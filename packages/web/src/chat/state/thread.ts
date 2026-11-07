/**
 * One open session: its record, its messages (paged backwards from the newest), and everything live about it from
 * the session channel: streamed tokens and reasoning, runs and their progress and cost, approvals and handler calls
 * waiting on the person, deliveries, presence, controls and session state. Sending, invoking, stopping, undoing,
 * retrying and editing go through here, as do approvals and answers, so every view of the session agrees.
 *
 * On a reconnect `refresh` fetches what may have changed while events were lost, so nothing is left spinning.
 */
import {
  type ActorId, type Approval, type ApprovalId, type ChatMessage, type ClientInfo, type DeliveryId, type DeliveryView, type HandlerCall,
  type HandlerCallId, type Json, type MessageId, type NotifyChoice, type OutgoingPart, type Presence, type QualifiedName, type Remember,
  type ResolvedLimits, type RunId, type Session, type SessionControls, type SessionEvent, type SessionId, type SessionSummary, type SystemName,
  type TurnId, type UndoReport,
} from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import { problemText } from '../../state/problems.ts';
import type { ChatApi, SessionEvents } from '../api.ts';
import { applyRunUpdate, emptyRun, isActive, isSettled, mergeRecord, type RunView } from '../logic/runs.ts';
import { appendToken, prependPage, resendParts, upsertMessage } from '../logic/thread.ts';
import { summaryOf } from './sessions.ts';

/** The callers a thread uses. */
export type ThreadApi = Pick<ChatApi,
  'session' | 'messages' | 'send' | 'invoke' | 'control' | 'background' | 'undoTurn' | 'run' | 'approve' | 'answer' | 'updateSession' | 'limits' | 'presence' | 'act' | 'submit'>;

/** What a thread needs besides its callers. */
export interface ThreadDeps {
  readonly api: ThreadApi;
  readonly events: SessionEvents;
  /** The time now, in ms. */
  readonly clock: () => number;
  /** The browser's time zone, locale and clock, sent with every message. */
  readonly client: () => ClientInfo;
  /** The signed-in person. */
  readonly me: () => ActorId | undefined;
  /** Told whenever the session's summary changes, so the list follows. */
  readonly changed: (summary: SessionSummary) => void;
}

/** How a thread behaves: page size, how many runs to fetch on open, how long typing shows, presence throttle (ms). */
export interface ThreadSettings {
  readonly page: number;
  readonly runsOnOpen: number;
  readonly typingFor: number;
  readonly presenceEvery: number;
}

export const THREAD_SETTINGS: ThreadSettings = { page: 50, runsOnOpen: 60, typingFor: 6_000, presenceEvery: 3_000 };

/** Where the thread is. */
export type ThreadStatus = 'loading' | 'ready' | 'error';

/** What a person sends. */
export interface Outgoing {
  readonly parts: readonly OutgoingPart[];
  readonly replyTo?: MessageId | undefined;
  readonly replyAll?: boolean;
}

/** What undoing one or more turns did, together. */
export interface UndoSummary {
  readonly reports: readonly UndoReport[];
  readonly undone: number;
  readonly failed: number;
  readonly notUndoable: number;
}

/** Add up undo reports. */
export function undoSummary(reports: readonly UndoReport[]): UndoSummary {
  return {
    reports,
    undone: reports.reduce((n, r) => n + r.undone.length, 0),
    failed: reports.reduce((n, r) => n + r.failed.length, 0),
    notUndoable: reports.reduce((n, r) => n + r.notUndoable.length, 0),
  };
}

interface Follower {
  readonly status: (status: DeliveryView['status']) => void;
  readonly resolve: (result: Json) => void;
  readonly reject: (error: Error) => void;
}

/** One open session. */
export class ThreadStore {
  readonly id: SessionId;
  readonly #deps: ThreadDeps;
  readonly #settings: ThreadSettings;
  #stopEvents: (() => void) | undefined;
  #cursor: string | undefined;
  readonly #fetching = new Set<RunId>();
  readonly #pendingTokens = new Map<MessageId, string>();
  readonly #typingTimers = new Map<ActorId, ReturnType<typeof setTimeout>>();
  readonly #followers = new Map<DeliveryId, Follower[]>();
  #lastPresence = 0;
  #typing = false;

  readonly session = shallowRef<Session | undefined>(undefined);
  /** Oldest first. */
  readonly messages = shallowRef<readonly ChatMessage[]>([]);
  readonly reasoning = shallowRef<ReadonlyMap<MessageId, string>>(new Map());
  readonly runs = shallowRef<ReadonlyMap<RunId, RunView>>(new Map());
  /** Waiting on the person, oldest first. */
  readonly approvals = shallowRef<readonly Approval[]>([]);
  readonly handlers = shallowRef<readonly HandlerCall[]>([]);
  readonly deliveries = shallowRef<ReadonlyMap<DeliveryId, DeliveryView>>(new Map());
  readonly presence = shallowRef<readonly Presence[]>([]);
  readonly controls = shallowRef<SessionControls | undefined>(undefined);
  /** Session state fields by `system/name`. */
  readonly state = shallowRef<ReadonlyMap<string, Json>>(new Map());
  readonly limits = shallowRef<ResolvedLimits | undefined>(undefined);
  readonly status = ref<ThreadStatus>('loading');
  readonly problem = ref('');
  readonly loadingOlder = ref(false);
  readonly sending = ref(false);
  /** A stop asked for and not yet confirmed. */
  readonly stopping = ref(false);
  /** The turn just sent, until its first answer or run shows. */
  readonly awaiting = ref<TurnId | undefined>(undefined);
  readonly #hasOlder = ref(false);
  readonly #spentAtLimits = ref(0);

  /** Whether older messages remain. */
  readonly hasOlder = computed(() => this.#hasOlder.value);
  /** Whether the start of the session is loaded. */
  readonly beginning = computed(() => this.status.value === 'ready' && !this.#hasOlder.value);
  /** Whether a turn is going. */
  readonly running = computed(() => this.session.value?.status === 'running' || this.awaiting.value !== undefined);
  readonly paused = computed(() => this.session.value?.status === 'paused');
  /** What this session has spent, as far as this view knows (every known run's own cost). */
  readonly spent = computed(() => [...this.runs.value.values()].reduce((sum, run) => sum + run.cost, 0));
  /** Spent since the limits were read. */
  readonly spentSince = computed(() => Math.max(0, this.spent.value - this.#spentAtLimits.value));
  /** Runs moved to the background that haven't finished. */
  readonly background = computed(() => [...this.runs.value.values()].filter((run) => run.background && !isSettled(run.status)));
  /** How many answers in a row failed at the end of the thread. */
  readonly failures = computed(() => {
    let count = 0;
    for (const message of [...this.messages.value].reverse()) {
      if (message.role === 'note') { continue; }
      if (message.role === 'assistant' && message.status === 'failed') { count++; continue; }
      break;
    }
    return count;
  });
  /** Others typing now. */
  readonly typing = computed(() => this.presence.value.filter((p) => p.typing && p.user !== this.#deps.me()));
  /** The person's own notification choice for this session. */
  readonly notify = computed<NotifyChoice>(() => this.session.value?.participants.find((p) => p.actor === this.#deps.me())?.notify ?? 'all');
  /** The latest turn, for Undo. */
  readonly lastTurn = computed(() => [...this.messages.value].reverse().find((m) => m.role !== 'note')?.turn);
  /** Whether the last turn may be undone. */
  readonly canUndo = computed(() => this.controls.value?.undoLastTurn ?? (this.lastTurn.value !== undefined && !this.running.value));

  constructor(id: SessionId, deps: ThreadDeps, settings: ThreadSettings = THREAD_SETTINGS) {
    this.id = id;
    this.#deps = deps;
    this.#settings = settings;
  }

  /** Listen to the session and load it: the record, the latest page, the limits, then the runs those messages made. */
  async open(): Promise<void> {
    this.#stopEvents ??= this.#deps.events(this.id, (event) => { this.#onEvent(event); });
    this.status.value = this.messages.value.length > 0 ? 'ready' : 'loading';
    this.problem.value = '';
    try {
      const [session, page] = await Promise.all([
        this.#deps.api.session.call({ session: this.id }),
        this.#deps.api.messages.call({ session: this.id, limit: this.#settings.page }),
      ]);
      this.session.value = session;
      this.#deps.changed(summaryOf(session));
      let merged = [...page.items].reverse();
      for (const live of this.messages.value) { merged = upsertMessage(merged, live); }
      this.messages.value = merged;
      this.#cursor = page.cursor;
      this.#hasOlder.value = page.cursor !== undefined;
      this.status.value = 'ready';
      void this.loadLimits();
      void this.#fetchRuns(merged.flatMap((m) => m.runs).slice(-this.#settings.runsOnOpen));
    } catch (error) {
      this.status.value = 'error';
      this.problem.value = problemText(error, "Couldn't open this chat.");
    }
  }

  /** Stop listening (the thread is no longer shown). */
  close(): void {
    this.#stopEvents?.();
    this.#stopEvents = undefined;
    for (const timer of this.#typingTimers.values()) { clearTimeout(timer); }
    this.#typingTimers.clear();
    if (this.#typing) { this.reportPresence({ typing: false, focused: false }); }
  }

  /** Fetch what may have changed while offline: the session, the latest page, controls and unsettled runs. */
  async refresh(): Promise<void> {
    await this.open();
    const unsettled = [...this.runs.value.values()].filter((run) => !isSettled(run.status)).map((run) => run.id);
    await this.#fetchRuns(unsettled, true);
  }

  /** Load the page before the oldest message held. */
  async loadOlder(): Promise<void> {
    const cursor = this.#cursor;
    if (cursor === undefined || this.loadingOlder.value) { return; }
    this.loadingOlder.value = true;
    try {
      const page = await this.#deps.api.messages.call({ session: this.id, limit: this.#settings.page, cursor });
      this.messages.value = prependPage(this.messages.value, page.items);
      this.#cursor = page.cursor;
      this.#hasOlder.value = page.cursor !== undefined;
      void this.#fetchRuns(page.items.flatMap((m) => m.runs));
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't load older messages.");
    } finally {
      this.loadingOlder.value = false;
    }
  }

  /** Read the budgets the next turn would get. */
  async loadLimits(): Promise<void> {
    try {
      this.limits.value = await this.#deps.api.limits.call({ session: this.id });
      this.#spentAtLimits.value = this.spent.value;
    } catch {
      // the meter keeps its last reading
    }
  }

  /** Send a message. A second send while one is in flight is refused, so a double tap sends once. */
  async send(outgoing: Outgoing): Promise<boolean> {
    if (this.sending.value || outgoing.parts.length === 0) { return false; }
    this.sending.value = true;
    this.problem.value = '';
    try {
      const sent = await this.#deps.api.send.call({
        session: this.id, parts: [...outgoing.parts], client: this.#deps.client(),
        ...(outgoing.replyTo === undefined ? {} : { replyTo: outgoing.replyTo }), ...(outgoing.replyAll === true ? { replyAll: true } : {}),
      });
      this.messages.value = upsertMessage(this.messages.value, sent.message);
      this.awaiting.value = sent.turn;
      this.reportPresence({ typing: false, focused: true });
      return true;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't send that. Your message is back in the box.");
      return false;
    } finally {
      this.sending.value = false;
    }
  }

  /** Run a fn by hand (`!fn`); submitting its form is the approval. */
  async invoke(fn: QualifiedName, args: Json): Promise<RunId | undefined> {
    try {
      const started = await this.#deps.api.invoke.call({ session: this.id, fn, args, client: this.#deps.client() });
      this.#upsertRun(this.runs.value.get(started.run) ?? emptyRun(started.run, fn));
      this.awaiting.value = started.turn;
      void this.#fetchRuns([started.run], true);
      return started.run;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't run that.");
      return undefined;
    }
  }

  /** Pause, resume or cancel the turn. The UI shows it stopping at once; events confirm. */
  async control(action: 'pause' | 'resume' | 'cancel'): Promise<boolean> {
    this.stopping.value = action !== 'resume';
    try {
      this.controls.value = await this.#deps.api.control.call({ session: this.id, action });
      if (action === 'cancel') { this.awaiting.value = undefined; }
      return true;
    } catch (error) {
      this.stopping.value = false;
      this.problem.value = problemText(error, "Couldn't stop the turn.");
      return false;
    }
  }

  /** Move a run to the background so the agent stops waiting for it. */
  async toBackground(run: RunId): Promise<boolean> {
    try {
      const { accepted } = await this.#deps.api.background.call({ run });
      const known = this.runs.value.get(run);
      if (accepted && known !== undefined) { this.#upsertRun({ ...known, background: true }); }
      return accepted;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't move that to the background.");
      return false;
    }
  }

  /** Undo a turn. The hub posts a note saying what was undone. */
  async undoTurn(turn: TurnId): Promise<UndoReport | undefined> {
    try {
      const report = await this.#deps.api.undoTurn.call({ turn });
      for (const run of [...report.undone.map((u) => u.run)]) {
        const known = this.runs.value.get(run);
        if (known !== undefined) { this.#upsertRun({ ...known, status: 'undone' }); }
      }
      return report;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't undo that.");
      return undefined;
    }
  }

  /** Undo the last turn. */
  async undoLast(): Promise<UndoReport | undefined> {
    const turn = this.lastTurn.value;
    return turn === undefined ? undefined : this.undoTurn(turn);
  }

  /** The user message that started a turn. */
  turnMessage(turn: TurnId): ChatMessage | undefined {
    return this.messages.value.find((m) => m.turn === turn && m.role === 'user');
  }

  /** Undo an answer's turn and send its message again. */
  async retry(turn: TurnId): Promise<boolean> {
    const message = this.turnMessage(turn);
    if (message === undefined) { return false; }
    const report = await this.undoTurn(turn);
    if (report === undefined) { return false; }
    await this.#reloadLatest();
    return this.send({ parts: resendParts(message.parts), replyTo: message.replyTo, replyAll: message.replyAll });
  }

  /** The turns from a message on, newest first: what editing it undoes. */
  turnsFrom(message: MessageId): TurnId[] {
    const at = this.messages.value.findIndex((m) => m.id === message);
    if (at === -1) { return []; }
    const turns: TurnId[] = [];
    for (const m of this.messages.value.slice(at)) { if (m.role !== 'note' && !turns.includes(m.turn)) { turns.push(m.turn); } }
    return turns.reverse();
  }

  /** Undo every turn from a message on (newest first), then send the edited message. */
  async editResend(message: MessageId, parts: readonly OutgoingPart[]): Promise<UndoSummary | undefined> {
    const original = this.messages.value.find((m) => m.id === message);
    if (original === undefined) { return undefined; }
    const reports: UndoReport[] = [];
    for (const turn of this.turnsFrom(message)) {
      const report = await this.undoTurn(turn);
      if (report === undefined) { return undefined; }
      reports.push(report);
    }
    await this.#reloadLatest();
    const sent = await this.send({ parts, replyTo: original.replyTo, replyAll: original.replyAll });
    return sent ? undoSummary(reports) : undefined;
  }

  /** Approve or deny a run. It leaves the queue at once; the hub's event confirms. */
  async approve(approval: ApprovalId, approve: boolean, remember: Remember, reason?: string): Promise<boolean> {
    const before = this.approvals.value;
    this.approvals.value = before.filter((a) => a.id !== approval);
    try {
      await this.#deps.api.approve.call({ approval, approve, remember, ...(reason === undefined || reason === '' ? {} : { reason }) });
      return true;
    } catch (error) {
      this.approvals.value = before;
      this.problem.value = problemText(error, "Couldn't send your answer.");
      return false;
    }
  }

  /** Approve or deny every waiting run. */
  async approveAll(approve: boolean, remember: Remember): Promise<boolean> {
    const results = await Promise.all(this.approvals.value.map((a) => this.approve(a.id, approve, remember)));
    return results.every(Boolean);
  }

  /** Answer a handler a run asked the person for. */
  async answer(call: HandlerCallId, value: Json): Promise<boolean> {
    const before = this.handlers.value;
    this.handlers.value = before.filter((h) => h.id !== call);
    try {
      await this.#deps.api.answer.call({ call, value });
      return true;
    } catch (error) {
      this.handlers.value = before;
      this.problem.value = problemText(error, "Couldn't send your answer.");
      return false;
    }
  }

  /** Submit a run's form. Its delivery's state shows live. */
  async submit(run: RunId, value: Json): Promise<DeliveryId | undefined> {
    try {
      return (await this.#deps.api.submit.call({ run, value })).delivery;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't submit that.");
      return undefined;
    }
  }

  /** Send a renderer's action to its system. */
  async act(system: SystemName, action: string, input: Json, run?: RunId): Promise<DeliveryId> {
    const { delivery } = await this.#deps.api.act.call({ session: this.id, system, action, input, client: this.#deps.client(), ...(run === undefined ? {} : { run }) });
    return delivery;
  }

  /** Follow a delivery: `status` on every change; resolves with its result when done, rejects when it fails or expires. */
  follow(delivery: DeliveryId, status: (status: DeliveryView['status']) => void): Promise<Json> {
    return new Promise((resolve, reject) => {
      const follower: Follower = { status, resolve, reject };
      const known = this.deliveries.value.get(delivery);
      if (known !== undefined && this.#settle(known, follower)) { return; }
      this.#followers.set(delivery, [...(this.#followers.get(delivery) ?? []), follower]);
    });
  }

  /** Change the session (title, systems, agent, priority, notify, archived). */
  async update(body: { title?: string; notify?: NotifyChoice; archived?: boolean; agent?: QualifiedName; systems?: Session['systems'] }): Promise<boolean> {
    try {
      const session = await this.#deps.api.updateSession.call({ session: this.id, ...body });
      this.session.value = session;
      this.#deps.changed(summaryOf(session));
      return true;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't change this chat.");
      return false;
    }
  }

  /** Report typing and focus to the hub, at most every `presenceEvery` ms while typing (a stop is sent at once). */
  reportPresence(state: { typing: boolean; focused: boolean }): void {
    const now = this.#deps.clock();
    const changed = state.typing !== this.#typing;
    if (!changed && state.typing && now - this.#lastPresence < this.#settings.presenceEvery) { return; }
    this.#typing = state.typing;
    this.#lastPresence = now;
    void this.#deps.api.presence.call({ session: this.id, ...state }).catch(() => undefined);
  }

  /** The runs a message made, in call order, as far as known. */
  runsOf(message: Pick<ChatMessage, 'runs'>): RunView[] {
    return message.runs.flatMap((id) => {
      const run = this.runs.value.get(id);
      return run === undefined ? [] : [run];
    });
  }

  /** Fetch a run's record (when it isn't known, or `again`). */
  async ensureRun(run: RunId, again = false): Promise<void> {
    await this.#fetchRuns([run], again);
  }

  async #reloadLatest(): Promise<void> {
    try {
      const page = await this.#deps.api.messages.call({ session: this.id, limit: this.#settings.page });
      this.messages.value = [...page.items].reverse();
      this.#cursor = page.cursor;
      this.#hasOlder.value = page.cursor !== undefined;
    } catch {
      // the events that follow keep the thread current
    }
  }

  async #fetchRuns(ids: readonly RunId[], again = false): Promise<void> {
    const wanted = [...new Set(ids)].filter((id) => !this.#fetching.has(id) && (again || this.runs.value.get(id)?.createdAt === undefined));
    await Promise.all(wanted.map(async (id) => {
      this.#fetching.add(id);
      try {
        const record = await this.#deps.api.run.call({ run: id });
        this.#upsertRun(mergeRecord(this.runs.value.get(id), record));
      } catch {
        // a run that can't be read keeps what its events said
      } finally {
        this.#fetching.delete(id);
      }
    }));
  }

  #upsertRun(run: RunView): void {
    const runs = new Map(this.runs.value);
    runs.set(run.id, run);
    this.runs.value = runs;
  }

  #settle(delivery: DeliveryView, follower: Follower): boolean {
    follower.status(delivery.status);
    if (delivery.status === 'done') { follower.resolve(delivery.result ?? null); return true; }
    if (delivery.status === 'failed' || delivery.status === 'expired') {
      follower.reject(new Error(delivery.error?.message ?? (delivery.status === 'expired' ? 'It expired before the system came online.' : 'It failed.')));
      return true;
    }
    return false;
  }

  #onEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'message': {
        const buffered = this.#pendingTokens.get(event.message.id);
        this.#pendingTokens.delete(event.message.id);
        const message = buffered !== undefined && event.message.status === 'streaming' ? appendToken(event.message, buffered) : event.message;
        this.messages.value = upsertMessage(this.messages.value, message);
        if (message.role === 'assistant' && message.turn === this.awaiting.value) { this.awaiting.value = undefined; }
        void this.#fetchRuns(message.runs);
        return;
      }
      case 'token': {
        const index = this.messages.value.findIndex((m) => m.id === event.message);
        const current = this.messages.value[index];
        if (current === undefined) {
          this.#pendingTokens.set(event.message, (this.#pendingTokens.get(event.message) ?? '') + event.text);
          return;
        }
        const next = [...this.messages.value];
        next[index] = appendToken(current, event.text);
        this.messages.value = next;
        if (current.turn === this.awaiting.value) { this.awaiting.value = undefined; }
        return;
      }
      case 'reasoning': {
        const reasoning = new Map(this.reasoning.value);
        reasoning.set(event.message, (reasoning.get(event.message) ?? '') + event.text);
        this.reasoning.value = reasoning;
        return;
      }
      case 'run': {
        const known = this.runs.value.get(event.run) ?? emptyRun(event.run, event.fn);
        this.#upsertRun(applyRunUpdate(known, event.update, this.#deps.clock()));
        // a run seen for the first time, or just settled, is read whole: its args, then its outcome
        const settled = event.update.type === 'status' && isSettled(event.update.status);
        if (known.createdAt === undefined || settled) { void this.#fetchRuns([event.run], settled); }
        if (event.update.type === 'status' && isActive(event.update.status)) { this.awaiting.value = undefined; }
        return;
      }
      case 'controls': this.controls.value = event.controls; this.stopping.value = false; return;
      case 'approval': {
        const others = this.approvals.value.filter((a) => a.id !== event.approval.id);
        this.approvals.value = event.approval.status === 'pending' ? [...others, event.approval].sort((a, b) => a.createdAt - b.createdAt) : others;
        return;
      }
      case 'handler': {
        const others = this.handlers.value.filter((h) => h.id !== event.call.id);
        const mine = 'user' in event.call.answerer && event.call.answerer.user === this.#deps.me();
        this.handlers.value = event.call.status === 'pending' && mine ? [...others, event.call] : others;
        return;
      }
      case 'delivery': {
        const deliveries = new Map(this.deliveries.value);
        deliveries.set(event.delivery.id, event.delivery);
        this.deliveries.value = deliveries;
        const followers = this.#followers.get(event.delivery.id) ?? [];
        const waiting = followers.filter((f) => !this.#settle(event.delivery, f));
        if (waiting.length === 0) { this.#followers.delete(event.delivery.id); } else { this.#followers.set(event.delivery.id, waiting); }
        return;
      }
      case 'presence': this.#onPresence(event.presence); return;
      case 'state': {
        const state = new Map(this.state.value);
        for (const field of event.fields) {
          const key = `${event.system}/${field.name}`;
          if (field.value === undefined) { state.delete(key); } else { state.set(key, field.value); }
        }
        this.state.value = state;
        return;
      }
      case 'session': {
        const current = this.session.value;
        if (current !== undefined) { this.session.value = { ...current, ...event.session }; }
        if (event.session.status === 'idle') {
          this.awaiting.value = undefined;
          this.stopping.value = false;
          void this.loadLimits();
        }
        this.#deps.changed(event.session);
        return;
      }
    }
  }

  #onPresence(presence: Presence): void {
    this.presence.value = [...this.presence.value.filter((p) => p.user !== presence.user), presence];
    clearTimeout(this.#typingTimers.get(presence.user));
    if (!presence.typing) { return; }
    this.#typingTimers.set(presence.user, setTimeout(() => {
      this.presence.value = this.presence.value.map((p) => (p.user === presence.user ? { ...p, typing: false } : p));
    }, this.#settings.typingFor));
  }
}
