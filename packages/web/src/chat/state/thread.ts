/**
 * One open session: its record, its messages (paged backwards from the newest), and everything live about it from
 * the session channel: streamed tokens and reasoning (kept in the order they arrive, with the runs between them), runs and their progress and cost, approvals and handler calls
 * waiting on the person, deliveries, presence, controls and session state. Sending, invoking, stopping, undoing,
 * retrying and editing go through here, as do approvals and answers, so every view of the session agrees.
 *
 * On a reconnect `refresh` fetches what may have changed while events were lost, so nothing is left spinning.
 */
import {
  compositeKey, isSettled, type ActorId, type Approval, type ApprovalId, type ChatMessage, type ClientInfo, type DeliveryId, type DeliveryView, type HandlerCall,
  type HandlerCallId, type Json, type MessageId, type NotifyChoice, type OutgoingPart, type Presence, type QualifiedName, type Remember,
  type ResolvedLimits, type RunId, type Session, type SessionControls, type SessionEvent, type SessionId, type SessionSummary, type StateFieldValue,
  type SystemName, type TurnId, type UndoReport,
} from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import { problemText } from '../../state/problems.ts';
import type { BodyOf } from '../../api/client.ts';
import type { ChatApi, SessionEvents } from '../api.ts';
import { isRememberable } from '../../components/approvals/rules.ts';
import { isConfirm } from '../logic/labels.ts';
import { applyRunUpdate, emptyRun, isActive, mergeRecord, type RunView } from '../logic/runs.ts';
import { addSegment, appendToken, prependPage, resendParts, settleSegments, storedSegments, undoneTurns, upsertMessage, type AnswerSegment } from '../logic/thread.ts';
import { RETRY, retryUntil, type RetryPolicy } from '../../state/retry.ts';
import { summaryOf } from './sessions.ts';

/** What the session controls can do, from the `control` endpoint's body. */
export type ControlAction = BodyOf<'control'>['action'];

/** The callers a thread uses. */
export type ThreadApi = Pick<ChatApi,
  'session' | 'messages' | 'send' | 'invoke' | 'control' | 'background' | 'undoTurn' | 'run' | 'approve' | 'answer' | 'updateSession' | 'limits' | 'presence' | 'act' | 'submit' | 'waiting' | 'state'
  | 'setBudget'>;

/** A used-up budget a run here waits on until someone raises it: the budget, the run, and which budget and how much in words. */
export type BudgetAsk = Omit<Extract<SessionEvent, { type: 'budget' }>, 'type'>;

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
  /** Whether the person can see the page (default the browser's page visibility). */
  readonly looking?: PageLooking;
  /** How a catch-up after a reconnect is retried until it works (default `RETRY`). */
  readonly retry?: RetryPolicy;
}

/**
 * Whether the person can see the page, and hearing when that changes. Presence follows this while the thread is
 * open (the session is on screen), not the composer's focus: clicking a button is still watching.
 */
export interface PageLooking {
  now(): boolean;
  /** Returns the stop. */
  watch(listener: () => void): () => void;
}

/** The browser's page visibility (always looking where there is no document). */
export const pageVisibility: PageLooking = {
  now: () => typeof document === 'undefined' || document.visibilityState === 'visible',
  watch: (listener) => {
    if (typeof document === 'undefined') { return () => undefined; }
    document.addEventListener('visibilitychange', listener);
    return () => { document.removeEventListener('visibilitychange', listener); };
  },
};

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

/**
 * A message on its way: shown in the thread at once (so a slow hub never makes it look lost), until the hub's stored
 * copy replaces it, or the send fails and it goes back into the composer.
 */
export interface PendingSend {
  readonly parts: readonly OutgoingPart[];
  /** When it was sent (ms since the epoch). */
  readonly at: number;
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

/**
 * Where a session state field is kept. Two fields are the same only when system, name and type all match (as the hub
 * keys them), so a same-named field of another type never reaches a renderer that didn't declare it.
 */
export function stateKey(system: SystemName, field: Pick<StateFieldValue, 'name' | 'type'>): string {
  return compositeKey(system, field.name, field.type);
}

/** The state fields a run's fn declared: its system, and each field's name and type. */
interface DeclaredState {
  readonly system: SystemName;
  readonly fields: readonly Pick<StateFieldValue, 'name' | 'type'>[];
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
  readonly #loadingState = new Set<RunId>();
  /** Runs the person approved here: approving runs them, so a yes-or-no question one asks after is answered yes. */
  readonly #approved = new Set<RunId>();
  #lastPresence = 0;
  #typing = false;
  #focused = false;
  #stopLooking: (() => void) | undefined;

  readonly session = shallowRef<Session | undefined>(undefined);
  /** Oldest first. */
  readonly messages = shallowRef<readonly ChatMessage[]>([]);
  /**
   * What streamed into each answer seen streaming here, in the order it arrived: reasoning, words and runs (see
   * `answerPieces`). A message never seen streaming shows in the order its parts keep.
   */
  readonly live = shallowRef<ReadonlyMap<MessageId, readonly AnswerSegment[]>>(new Map());
  readonly runs = shallowRef<ReadonlyMap<RunId, RunView>>(new Map());
  /** Waiting on the person, oldest first. */
  readonly approvals = shallowRef<readonly Approval[]>([]);
  readonly handlers = shallowRef<readonly HandlerCall[]>([]);
  /** Used-up budgets runs here wait on, one per budget, until it is raised, the run goes on, or the person leaves it. */
  readonly budgets = shallowRef<readonly BudgetAsk[]>([]);
  readonly deliveries = shallowRef<ReadonlyMap<DeliveryId, DeliveryView>>(new Map());
  readonly presence = shallowRef<readonly Presence[]>([]);
  readonly controls = shallowRef<SessionControls | undefined>(undefined);
  /** Session state field values by `stateKey` (system, name and type). */
  readonly state = shallowRef<ReadonlyMap<string, Json>>(new Map());
  /** The fields each run's fn declared, once read (see `stateOf`). */
  readonly #declared = shallowRef<ReadonlyMap<RunId, DeclaredState>>(new Map());
  readonly limits = shallowRef<ResolvedLimits | undefined>(undefined);
  readonly status = ref<ThreadStatus>('loading');
  readonly problem = ref('');
  /**
   * What is shown may be behind: a reconnect's catch-up hasn't worked yet (it is retried until it does), so live
   * events may have been missed.
   */
  readonly stale = ref(false);
  #catchUps = 0;
  readonly loadingOlder = ref(false);
  readonly sending = ref(false);
  /** The message being sent, shown until the hub has it. */
  readonly pending = shallowRef<PendingSend | undefined>(undefined);
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
      if (message.role === 'note' || this.undone.value.has(message.turn)) { continue; }
      if (message.role === 'assistant' && message.status === 'failed') { count++; continue; }
      break;
    }
    return count;
  });
  /** Others typing now. */
  readonly typing = computed(() => this.presence.value.filter((p) => p.typing && p.user !== this.#deps.me()));
  /** The person's own notification choice for this session. */
  readonly notify = computed<NotifyChoice>(() => this.session.value?.participants.find((p) => p.actor === this.#deps.me())?.notify ?? 'all');
  /** The turns undone so far. */
  readonly undone = computed(() => undoneTurns(this.messages.value));
  /** The latest turn that still stands, for Undo. */
  readonly lastTurn = computed(() => [...this.messages.value].reverse().find((m) => m.role !== 'note' && !this.undone.value.has(m.turn))?.turn);
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
    const looking = this.#deps.looking ?? pageVisibility;
    this.#stopLooking ??= looking.watch(() => { this.reportPresence({ typing: this.#typing && looking.now() }); });
    this.reportPresence({ typing: this.#typing });
    this.status.value = this.messages.value.length > 0 ? 'ready' : 'loading';
    this.problem.value = '';
    try {
      const merged = await this.#load();
      void this.loadLimits();
      void this.loadWaiting();
      void this.#fetchRuns(merged.flatMap((m) => m.runs).slice(-this.#settings.runsOnOpen));
    } catch (error) {
      // a chat already on screen stays there when catching up fails; only a chat that never loaded shows the error
      const loaded = this.session.value !== undefined;
      this.status.value = loaded ? 'ready' : 'error';
      this.problem.value = problemText(error, loaded ? "Couldn't catch up with this chat." : "Couldn't open this chat.");
    }
  }

  /** Read the record and the latest page, merged with what live events already brought; throws when either fails. */
  async #load(): Promise<readonly ChatMessage[]> {
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
    return merged;
  }

  /** Stop listening (the thread is no longer shown). */
  close(): void {
    this.#stopEvents?.();
    this.#stopEvents = undefined;
    for (const timer of this.#typingTimers.values()) { clearTimeout(timer); }
    this.#typingTimers.clear();
    this.#stopLooking?.();
    this.#stopLooking = undefined;
    if (this.#typing || this.#focused) { this.#sendPresence(false, false); }
  }

  /**
   * Fetch what may have changed while offline: the session, the latest page, what waits on the person, the runs those
   * messages made and the unsettled ones, and state. Until every one of those reads works the thread is `stale`, and
   * the catch-up is tried again with growing waits (a hub that is back but still busy), while the thread is open. A
   * newer catch-up takes over from an older one.
   */
  async refresh(): Promise<void> {
    const mine = ++this.#catchUps;
    this.stale.value = true;
    this.#stopEvents ??= this.#deps.events(this.id, (event) => { this.#onEvent(event); });
    const wanted = (): boolean => mine === this.#catchUps && this.#stopEvents !== undefined;
    const caught = await retryUntil(() => this.#catchUp(), this.#deps.retry ?? RETRY, wanted, (error) => {
      // the chat stays on screen, saying why it may be behind, while the catch-up is tried again
      this.problem.value = problemText(error, "Couldn't catch up with this chat.");
      if (this.session.value === undefined) { this.status.value = 'error'; }
    });
    if (caught && mine === this.#catchUps) {
      this.stale.value = false;
      this.problem.value = '';
      if (this.status.value === 'error') { this.status.value = 'ready'; }
      void this.loadLimits();
    }
  }

  /** One catch-up: every read it makes must work, or it throws (and is tried again). */
  async #catchUp(): Promise<void> {
    const merged = await this.#load();
    const unsettled = [...this.runs.value.values()].filter((run) => !isSettled(run.status)).map((run) => run.id);
    await Promise.all([
      this.#readWaiting(),
      this.#fetchRuns(merged.flatMap((m) => m.runs).slice(-this.#settings.runsOnOpen), false, true),
      this.#fetchRuns(unsettled, true, true),
      ...[...this.#declared.value.keys()].map((run) => this.loadState(run)),
    ]);
  }

  /**
   * A run's session state: the fields its fn declared, by name, live. The first read loads them from the hub (so a
   * renderer drawn after a reload has its state); until then it is empty.
   */
  stateOf(run: RunId): Readonly<Record<string, Json>> {
    const declared = this.#declared.value.get(run);
    if (declared === undefined) { void this.loadState(run); return {}; }
    const values: Record<string, Json> = {};
    for (const field of declared.fields) {
      const value = this.state.value.get(stateKey(declared.system, field));
      if (value !== undefined) { values[field.name] = value; }
    }
    return values;
  }

  /** Read the state fields a run's fn declared, with their values now. */
  async loadState(run: RunId): Promise<void> {
    if (this.#loadingState.has(run)) { return; }
    this.#loadingState.add(run);
    try {
      const { system, fields } = await this.#deps.api.state.call({ run });
      this.#applyState(system, fields);
      const declared = new Map(this.#declared.value);
      declared.set(run, { system, fields: fields.map(({ name, type }) => ({ name, type })) });
      this.#declared.value = declared;
    } catch {
      // the renderer draws without state; events fill it in as it changes
    } finally {
      this.#loadingState.delete(run);
    }
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

  /**
   * Read what waits on the person in this session (approvals, and questions runs asked them), so a reload or a
   * reconnect shows them again; live events keep the lists current from then on.
   */
  async loadWaiting(): Promise<void> {
    try {
      await this.#readWaiting();
    } catch {
      // the lists keep what events said
    }
  }

  async #readWaiting(): Promise<void> {
    const waiting = await this.#deps.api.waiting.call({ session: this.id });
    this.approvals.value = [...waiting.approvals].sort((a, b) => a.createdAt - b.createdAt);
    const me = this.#deps.me();
    this.handlers.value = this.#ask(waiting.handlers.filter((h) => 'user' in h.answerer && h.answerer.user === me));
    void this.#fetchRuns([...waiting.approvals.map((a) => a.run), ...waiting.handlers.map((h) => h.run)]);
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
    this.pending.value = { parts: outgoing.parts, at: this.#deps.clock() };
    this.problem.value = '';
    try {
      const sent = await this.#deps.api.send.call({
        session: this.id, parts: [...outgoing.parts], client: this.#deps.client(),
        ...(outgoing.replyTo === undefined ? {} : { replyTo: outgoing.replyTo }), ...(outgoing.replyAll === true ? { replyAll: true } : {}),
      });
      this.messages.value = upsertMessage(this.messages.value, sent.message);
      this.awaiting.value = sent.turn;
      this.#newTurn();
      this.reportPresence({ typing: false });
      return true;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't send that. Your message is back in the box.");
      return false;
    } finally {
      this.sending.value = false;
      this.pending.value = undefined;
    }
  }

  /** Run a fn by hand (`!fn`); submitting its form is the approval. */
  async invoke(fn: QualifiedName, args: Json): Promise<RunId | undefined> {
    try {
      const started = await this.#deps.api.invoke.call({ session: this.id, fn, args, client: this.#deps.client() });
      this.#upsertRun(this.runs.value.get(started.run) ?? emptyRun(started.run, fn));
      this.awaiting.value = started.turn;
      this.#newTurn();
      void this.#fetchRuns([started.run], true);
      return started.run;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't run that.");
      return undefined;
    }
  }

  /** Pause, resume or cancel the turn's runs: those named, or all. The UI shows it stopping at once; events confirm. */
  async control(action: ControlAction, runs?: readonly RunId[]): Promise<boolean> {
    this.stopping.value = action !== 'resume';
    try {
      this.controls.value = await this.#deps.api.control.call({ session: this.id, action, ...(runs === undefined || runs.length === 0 ? {} : { runs: [...runs] }) });
      if (action === 'cancel') {
        this.awaiting.value = undefined;
        void this.loadWaiting();
      }
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
    for (const m of this.messages.value.slice(at)) { if (m.role !== 'note' && !this.undone.value.has(m.turn) && !turns.includes(m.turn)) { turns.push(m.turn); } }
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
    const run = before.find((a) => a.id === approval)?.run;
    this.approvals.value = before.filter((a) => a.id !== approval);
    try {
      if (approve && run !== undefined) { this.#approved.add(run); }
      await this.#deps.api.approve.call({ approval, approve, remember, ...(reason === undefined || reason === '' ? {} : { reason }) });
      return true;
    } catch (error) {
      if (run !== undefined) { this.#approved.delete(run); }
      this.approvals.value = before;
      this.problem.value = problemText(error, "Couldn't send your answer.");
      return false;
    }
  }

  /**
   * The person's questions to show: a yes-or-no question from a run they approved is answered yes instead (approving
   * a run is saying yes to running it, so no second "Run" button follows).
   */
  #ask(calls: readonly HandlerCall[]): HandlerCall[] {
    const shown: HandlerCall[] = [];
    for (const call of calls) {
      if (this.#approved.has(call.run) && isConfirm(call)) { void this.answer(call.id, true); } else { shown.push(call); }
    }
    return shown;
  }

  /**
   * Approve or deny several waiting runs at once (the tray picks which: Deny all takes every one, Approve all only those
   * without a preview). An answer is remembered only for the runs whose answer may be.
   */
  async approveAll(ids: readonly ApprovalId[], approve: boolean, remember: Remember): Promise<boolean> {
    const chosen = this.approvals.value.filter((a) => ids.includes(a.id));
    const results = await Promise.all(chosen.map((a) => this.approve(a.id, approve, isRememberable(a) ? remember : 'once')));
    return results.every(Boolean);
  }

  /** Raise a used-up budget by `by` (USD) so the run waiting on it goes on; the card goes once it is saved. */
  async raiseBudget(ask: BudgetAsk, by: number): Promise<boolean> {
    const { setBy: _, ...rule } = ask.budget;
    try {
      await this.#deps.api.setBudget.call({ ...rule, maxCost: rule.maxCost + by });
      this.leaveBudget(ask);
      return true;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't raise the budget.");
      return false;
    }
  }

  /** Leave a used-up budget as it is: the card goes; the run keeps waiting until someone raises it or its window frees up. */
  leaveBudget(ask: BudgetAsk): void {
    this.budgets.value = this.budgets.value.filter((b) => b.budget.id !== ask.budget.id);
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

  /** Change the session (title, systems, agent, priority, notify, archived): any field `updateSession` takes. */
  async update(body: Omit<BodyOf<'updateSession'>, 'session'>): Promise<boolean> {
    try {
      const session = await this.#deps.api.updateSession.call({ session: this.id, ...body });
      this.session.value = session;
      this.#deps.changed(summaryOf(session));
      if (body.priority !== undefined) { void this.loadLimits(); }
      return true;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't change this chat.");
      return false;
    }
  }

  /**
   * Report typing to the hub, with whether the person is looking (the page is visible while this thread is open). At
   * most every `presenceEvery` ms while typing; a change of either is sent at once.
   */
  reportPresence(state: { typing: boolean }): void {
    const focused = (this.#deps.looking ?? pageVisibility).now();
    const changed = state.typing !== this.#typing || focused !== this.#focused;
    if (!changed && (!state.typing || this.#deps.clock() - this.#lastPresence < this.#settings.presenceEvery)) { return; }
    this.#sendPresence(state.typing, focused);
  }

  #sendPresence(typing: boolean, focused: boolean): void {
    this.#typing = typing;
    this.#focused = focused;
    this.#lastPresence = this.#deps.clock();
    void this.#deps.api.presence.call({ session: this.id, typing, focused }).catch(() => undefined);
  }

  /** An answer's segments in the order they streamed, when it was seen streaming here. */
  liveOf(message: Pick<ChatMessage, 'id'>): readonly AnswerSegment[] | undefined {
    return this.live.value.get(message.id);
  }

  /**
   * The runs a message made, in call order, as they show (see `shown`). A run not read yet is read now (any message
   * on screen, however far back), and shows once it is.
   */
  runsOf(message: Pick<ChatMessage, 'runs'>): RunView[] {
    const missing = message.runs.filter((id) => !this.runs.value.has(id));
    if (missing.length > 0) { void this.#fetchRuns(missing); }
    return message.runs.flatMap((id) => {
      const run = this.runs.value.get(id);
      return run === undefined ? [] : [this.shown(run)];
    });
  }

  /** A run as the thread shows it: `asking` while one of its handlers waits on the person's answer. */
  shown(run: RunView): RunView {
    const asking = this.handlers.value.some((h) => h.run === run.id);
    return asking === (run.asking === true) ? run : { ...run, asking };
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

  /** Read runs' records. `strict` throws when one can't be read (a catch-up tries again); otherwise it keeps what its events said. */
  async #fetchRuns(ids: readonly RunId[], again = false, strict = false): Promise<void> {
    const wanted = [...new Set(ids)].filter((id) => !this.#fetching.has(id) && (again || this.runs.value.get(id)?.createdAt === undefined));
    const failures: unknown[] = [];
    await Promise.all(wanted.map(async (id) => {
      this.#fetching.add(id);
      try {
        const record = await this.#deps.api.run.call({ run: id });
        this.#upsertRun(mergeRecord(this.runs.value.get(id), record));
      } catch (error) {
        failures.push(error);
      } finally {
        this.#fetching.delete(id);
      }
    }));
    if (strict && failures.length > 0) { throw failures[0]; }
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
        this.#liveRuns(message);
        this.messages.value = upsertMessage(this.messages.value, message);
        if (message.role === 'assistant' && message.turn === this.awaiting.value) { this.awaiting.value = undefined; }
        void this.#fetchRuns(message.runs);
        return;
      }
      case 'token': {
        const index = this.messages.value.findIndex((m) => m.id === event.message);
        const current = this.messages.value[index];
        this.#stream(event.message, { kind: 'text', text: event.text });
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
      case 'reasoning': this.#stream(event.message, { kind: 'reasoning', text: event.text }); return;
      case 'run': {
        const known = this.runs.value.get(event.run) ?? emptyRun(event.run, event.fn);
        this.#upsertRun(applyRunUpdate(known, event.update, this.#deps.clock()));
        // a run seen for the first time, or just settled, is read whole: its args, then its outcome
        const settled = event.update.type === 'status' && isSettled(event.update.status);
        if (known.createdAt === undefined || settled) { void this.#fetchRuns([event.run], settled); }
        // a run that settles, or spends again, isn't waiting on its budget any more
        if (settled || event.update.type === 'cost') { this.#dropWaiting(event.run); }
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
        this.handlers.value = event.call.status === 'pending' && mine ? [...others, ...this.#ask([event.call])] : others;
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
      case 'budget': {
        const { type: _, ...ask } = event;
        this.budgets.value = [...this.budgets.value.filter((b) => b.budget.id !== ask.budget.id), ask];
        return;
      }
      case 'presence': this.#onPresence(event.presence); return;
      case 'state': this.#applyState(event.system, event.fields); return;
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

  #applyState(system: SystemName, fields: readonly StateFieldValue[]): void {
    const state = new Map(this.state.value);
    for (const field of fields) {
      const key = stateKey(system, field);
      if (field.value === undefined) { state.delete(key); } else { state.set(key, field.value); }
    }
    this.state.value = state;
  }

  /**
   * A turn started: the controls the hub last sent were for the turn before (the hub sends them again as its runs
   * start and settle), so Stop offers Cancel until it says what this one allows.
   */
  #newTurn(): void {
    this.controls.value = undefined;
    this.stopping.value = false;
  }

  /** A settled run waits on no one: its approval and questions go, even if their own events were missed. */
  #dropWaiting(run: RunId): void {
    if (this.approvals.value.some((a) => a.run === run)) { this.approvals.value = this.approvals.value.filter((a) => a.run !== run); }
    if (this.handlers.value.some((h) => h.run === run)) { this.handlers.value = this.handlers.value.filter((h) => h.run !== run); }
    if (this.budgets.value.some((b) => b.run === run)) { this.budgets.value = this.budgets.value.filter((b) => b.run !== run); }
  }

  /**
   * Add what streamed into an answer to its live segments. The first piece seen starts from what the message held
   * already (a chat opened mid-answer), so nothing streamed before is lost.
   */
  #stream(id: MessageId, next: AnswerSegment): void {
    const held = this.messages.value.find((m) => m.id === id);
    const before = this.live.value.get(id) ?? (held === undefined ? [] : storedSegments(held));
    const live = new Map(this.live.value);
    live.set(id, addSegment(before, next));
    this.live.value = live;
  }

  /**
   * The runs a streaming answer started since it was last seen, after what streamed before them. Before anything
   * streamed, the message's stored order stands (its runs first), so there is nothing to note.
   */
  #liveRuns(message: ChatMessage): void {
    const known = this.live.value.get(message.id);
    if (known === undefined || message.role !== 'assistant') { return; }
    if (message.status !== 'streaming') {
      const live = new Map(this.live.value);
      live.set(message.id, settleSegments(known, message));
      this.live.value = live;
      return;
    }
    const placed = new Set(known.flatMap((segment) => (segment.kind === 'runs' ? segment.runs : [])));
    const fresh = message.runs.filter((run) => !placed.has(run));
    if (fresh.length > 0) { this.#stream(message.id, { kind: 'runs', runs: fresh }); }
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
