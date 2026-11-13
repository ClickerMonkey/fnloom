/**
 * The live sessions of one claude instance (process state, like the database system's waiting changes): their
 * handles, the requests they wait on, and the record each is mirrored as. What a session reports updates its
 * `ClaudeSession` value, which is written to its hub record a debounce later. A tool use or a question becomes a
 * proposed run (`permit` / `answer`) for the session's person, and the request waits in `#waiting` until that run is
 * approved (its fn calls `settle`) or declined (the run event calls `declined`). Nothing here survives a restart: the
 * requests are gone and their runs fail plainly; the sessions stay in Claude's store, resumable.
 */
import { randomUUID } from 'node:crypto';
import { proposalKeyFor, type ApprovalPreview, type ClaudePermissionMode, type ClaudeSession, type ClaudeSessionId, type ClaudeTask, type GinTypeDef, type Json, type RecordId, type RunId, type SessionId } from '@harness/core';
import { g, wireType, type Log } from '@harness/sdk';
import type { ClaudeDriver, DriverEvent, DriverOpen, LiveSession, PermitDecision, PermitRequest, QuestionReply, SessionListener, TaskChange } from './driver.ts';
import { permitPreview, questionPreview } from './preview.ts';

/** A run the fleet proposes for a session's person. */
export interface Proposal {
  readonly fn: 'permit' | 'answer';
  readonly args: Json;
  readonly key: string;
  readonly preview: ApprovalPreview;
  readonly for: ClaudeSession['owner'];
  readonly chat?: SessionId | undefined;
  /** The form the person fills; its value becomes `args[into]`. */
  readonly ask?: { readonly type: GinTypeDef; readonly into: string } | undefined;
}

/** What the fleet needs of the hub, outside any run. */
export interface FleetHub {
  /** Write a session's record (it keeps its owner). */
  saveSession(id: RecordId, value: ClaudeSession): Promise<void>;
  /** Propose a run for a person; resolves with the run. */
  propose(proposal: Proposal): Promise<RunId>;
}

/** The fleet's tunables (from the env slice) and its clock. */
export interface FleetOptions {
  readonly instance: string;
  readonly debounce: number;
  readonly lastTextMax: number;
  readonly previewMax: number;
  readonly now: () => number;
  readonly log: Log;
}

/** How a turn a run waits on ended. */
export type TurnEnd = { readonly ok: boolean; readonly text: string; readonly costUsd: number } | { readonly ended: true; readonly problem?: string | undefined };

/** A request a session waits on. */
type Waiting =
  | { readonly kind: 'permit'; readonly session: ClaudeSessionId; run?: RunId; key?: string; readonly resolve: (decision: PermitDecision) => void }
  | { readonly kind: 'answer'; readonly session: ClaudeSessionId; run?: RunId; key?: string; readonly resolve: (reply: QuestionReply) => void };

/** One live session. */
interface Entry {
  readonly record: RecordId;
  value: ClaudeSession;
  readonly handle: LiveSession;
  readonly turnWaiters: Set<(end: TurnEnd) => void>;
  readonly watchers: Set<(line: string) => void>;
  idleClose: number;
  writeTimer?: NodeJS.Timeout | undefined;
  idleTimer?: NodeJS.Timeout | undefined;
}

/** What `settle` says when the request is gone. */
export const NOT_WAITING = 'This request is no longer waiting: the session ended, Claude withdrew it, or the claude system restarted.';

export class SessionFleet {
  readonly #driver: ClaudeDriver;
  readonly #hub: () => FleetHub | undefined;
  readonly #options: FleetOptions;
  readonly #live = new Map<ClaudeSessionId, Entry>();
  readonly #waiting = new Map<string, Waiting>();
  readonly #byRun = new Map<RunId, string>();

  constructor(driver: ClaudeDriver, hub: () => FleetHub | undefined, options: FleetOptions) {
    this.#driver = driver;
    this.#hub = hub;
    this.#options = options;
  }

  /** How many sessions are live. */
  get size(): number { return this.#live.size; }

  /** A live session's current value, or `undefined` when it isn't live. */
  value(session: ClaudeSessionId): ClaudeSession | undefined {
    return this.#live.get(session)?.value;
  }

  /** Whether a session is live here. */
  isLive(session: ClaudeSessionId): boolean {
    return this.#live.has(session);
  }

  /**
   * Make a session live: start (or resume) it with the driver, mirrored as `record`, and send `prompt` as its first
   * message. A live session with nothing to do closes after `idleClose` ms.
   */
  open(record: RecordId, value: ClaudeSession, open: DriverOpen, prompt: string, idleClose: number): void {
    const listener = this.#listener(open.session);
    const entry: Entry = { record, value: { ...value, status: 'working' }, handle: this.#driver.open(open, listener), turnWaiters: new Set(), watchers: new Set(), idleClose };
    this.#live.set(open.session, entry);
    entry.handle.send(prompt);
    this.#write(entry);
  }

  /** Queue a message to a live session; it is working until the turn ends. */
  send(session: ClaudeSessionId, text: string): boolean {
    const entry = this.#live.get(session);
    if (entry === undefined) { return false; }
    clearTimeout(entry.idleTimer);
    entry.handle.send(text);
    this.#change(entry, { status: this.#busy(session) ? 'waiting' : 'working' });
    return true;
  }

  /**
   * Wait for the session's current turn to end, reporting each tool use and task line to `progress`. Resolves early
   * with `ended` when the session ends, and with the turn so far when `signal` aborts (the run was cancelled).
   */
  turn(session: ClaudeSessionId, progress: (line: string) => void, signal: AbortSignal): Promise<TurnEnd> {
    const entry = this.#live.get(session);
    if (entry === undefined) { return Promise.resolve({ ended: true }); }
    return new Promise((resolve) => {
      const done = (end: TurnEnd) => {
        entry.turnWaiters.delete(done);
        entry.watchers.delete(progress);
        signal.removeEventListener('abort', aborted);
        resolve(end);
      };
      const aborted = () => { done({ ok: false, text: entry.value.lastText ?? '', costUsd: entry.value.costUsd }); };
      entry.turnWaiters.add(done);
      entry.watchers.add(progress);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  /** Stop the current turn of a live session. */
  async interrupt(session: ClaudeSessionId): Promise<boolean> {
    const entry = this.#live.get(session);
    if (entry === undefined) { return false; }
    await entry.handle.interrupt();
    return true;
  }

  /** Switch a live session's permission mode. */
  async setMode(session: ClaudeSessionId, mode: ClaudePermissionMode): Promise<boolean> {
    const entry = this.#live.get(session);
    if (entry === undefined) { return false; }
    await entry.handle.setMode(mode);
    this.#change(entry, { permissionMode: mode });
    return true;
  }

  /** Close a live session (it stays resumable); its waiting requests are withdrawn. */
  stop(session: ClaudeSessionId): boolean {
    const entry = this.#live.get(session);
    if (entry === undefined) { return false; }
    entry.handle.close();
    this.#end(session, entry, undefined);
    return true;
  }

  /** Close every live session (the process is stopping) and write their records now. */
  async stopAll(): Promise<void> {
    const writes = [...this.#live.entries()].map(([session, entry]) => {
      entry.handle.close();
      this.#end(session, entry, undefined);
      return this.#flush(entry);
    });
    await Promise.all(writes);
  }

  /** The approved run of a waiting tool use of `session`: let Claude use it. False when the request is gone. */
  permit(session: ClaudeSessionId, request: string, always: boolean): boolean {
    if (!this.#waitingOf(session, request, 'permit')) { return false; }
    const waiting = this.#take(request);
    if (waiting?.kind !== 'permit') { return false; }
    waiting.resolve({ allow: true, always });
    return true;
  }

  /** The approved run of a waiting question of `session`, with the person's answer. False when the request is gone. */
  answer(session: ClaudeSessionId, request: string, answer: Json): boolean {
    if (!this.#waitingOf(session, request, 'answer')) { return false; }
    const waiting = this.#take(request);
    if (waiting?.kind !== 'answer') { return false; }
    waiting.resolve({ answer });
    return true;
  }

  /** A proposed run settled without running (declined, or cancelled): deny or decline what it stood for. */
  declined(run: RunId, reason: string): void {
    const request = this.#byRun.get(run);
    const waiting = request === undefined ? undefined : this.#take(request);
    if (waiting === undefined) { return; }
    if (waiting.kind === 'permit') { waiting.resolve({ allow: false, reason }); } else { waiting.resolve({ declined: reason }); }
  }

  #listener(session: ClaudeSessionId): SessionListener {
    return {
      event: (event) => { this.#event(session, event); },
      permit: (request, signal) => new Promise<PermitDecision>((resolve) => {
        this.#ask(session, { kind: 'permit', session, resolve }, (entry, id, key) => ({
          fn: 'permit', key, preview: permitPreview(request, this.#options.previewMax),
          args: { instance: this.#options.instance, session, request: id, tool: request.tool, input: request.input, always: false },
          for: entry.value.owner, chat: entry.value.chat, ask: alwaysAsk(request),
        }), signal, (reason) => { resolve({ allow: false, reason }); });
      }),
      question: (request, signal) => new Promise<QuestionReply>((resolve) => {
        this.#ask(session, { kind: 'answer', session, resolve }, (entry, id, key) => ({
          fn: 'answer', key, preview: questionPreview(request),
          args: { instance: this.#options.instance, session, request: id, from: request.from, answer: null },
          for: entry.value.owner, chat: entry.value.chat, ...(request.form === undefined ? {} : { ask: { type: request.form, into: 'answer' } }),
        }), signal, (reason) => { resolve({ declined: reason }); });
      }),
    };
  }

  /** Propose the run a request waits on, and keep the request until it is answered, declined or withdrawn. */
  #ask(session: ClaudeSessionId, waiting: Waiting, proposal: (entry: Entry, id: string, key: string) => Proposal, signal: AbortSignal, refuse: (reason: string) => void): void {
    const entry = this.#live.get(session);
    const hub = this.#hub();
    if (entry === undefined || hub === undefined) { refuse('The harness is not connected, so nobody can be asked.'); return; }
    const id = randomUUID();
    this.#waiting.set(id, waiting);
    signal.addEventListener('abort', () => {
      // Claude withdrew it (an interrupt): the card's run then finds nothing to answer
      if (this.#take(id) !== undefined) { refuse('Claude withdrew the request.'); }
    }, { once: true });
    // the key starts with the session's record: the hub accepts a proposal for the owner of that record only
    const key = proposalKeyFor(entry.record, `${waiting.kind}:${id}`);
    waiting.key = key;
    this.#change(entry, { asking: [...entry.value.asking, key] });
    const made = proposal(entry, id, key);
    hub.propose(made).then((run) => {
      if (!this.#waiting.has(id)) { return; }
      waiting.run = run;
      this.#byRun.set(run, id);
      this.#change(entry, { status: 'waiting', waiting: [...entry.value.waiting, run] });
    }).catch((error: unknown) => {
      this.#options.log.warn('claude.propose_failed', { session, problem: String(error) });
      if (this.#take(id) !== undefined) { refuse(`The person could not be asked: ${String(error)}`); }
    });
  }

  /** Take a waiting request out, and its run off its session's record. */
  #take(request: string): Waiting | undefined {
    const waiting = this.#waiting.get(request);
    if (waiting === undefined) { return undefined; }
    this.#waiting.delete(request);
    const run = waiting.run;
    if (run !== undefined) { this.#byRun.delete(run); }
    const entry = this.#live.get(waiting.session);
    if (entry !== undefined) {
      const left = entry.value.waiting.filter((r) => r !== run);
      const status = left.length > 0 ? 'waiting' : entry.value.status === 'waiting' ? 'working' : entry.value.status;
      this.#change(entry, { waiting: left, asking: entry.value.asking.filter((key) => key !== waiting.key), status });
    }
    return waiting;
  }

  /** Whether `request` is a request of this kind that `session` waits on (a run names both). */
  #waitingOf(session: ClaudeSessionId, request: string, kind: Waiting['kind']): boolean {
    const waiting = this.#waiting.get(request);
    return waiting?.session === session && waiting.kind === kind;
  }

  /** Whether a session has requests waiting. */
  #busy(session: ClaudeSessionId): boolean {
    return [...this.#waiting.values()].some((waiting) => waiting.session === session);
  }

  #event(session: ClaudeSessionId, event: DriverEvent): void {
    const entry = this.#live.get(session);
    if (entry === undefined) { return; }
    switch (event.type) {
      case 'text':
        this.#change(entry, { lastText: oneLine(event.text, this.#options.lastTextMax) });
        return;
      case 'tool':
        for (const watcher of entry.watchers) { watcher(event.line); }
        return;
      case 'task': {
        const task = mergeTask(entry.value.tasks.find((t) => t.id === event.change.id), event.change, this.#options.now());
        for (const watcher of entry.watchers) { watcher(`${task.name ?? task.kind}: ${task.progress ?? task.description} (${task.status})`); }
        this.#change(entry, { tasks: [...entry.value.tasks.filter((t) => t.id !== task.id), task] });
        return;
      }
      case 'result': {
        const end: TurnEnd = { ok: event.ok, text: event.text, costUsd: event.costUsd };
        this.#change(entry, {
          status: this.#busy(session) ? 'waiting' : 'idle', turns: event.turns, costUsd: event.costUsd,
          ...(event.text === '' ? {} : { lastText: oneLine(event.text, this.#options.lastTextMax) }),
          ...(event.ok ? { problem: undefined } : { problem: oneLine(event.text, this.#options.lastTextMax) }),
        });
        for (const waiter of [...entry.turnWaiters]) { waiter(end); }
        clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => { this.stop(session); }, entry.idleClose);
        return;
      }
      case 'ended':
        this.#end(session, entry, event.problem);
        return;
    }
  }

  /** A session is no longer live: closed or failed, its requests withdrawn and its waiters told. */
  #end(session: ClaudeSessionId, entry: Entry, problem: string | undefined): void {
    if (this.#live.get(session) !== entry) { return; }
    this.#live.delete(session);
    clearTimeout(entry.idleTimer);
    for (const [id, waiting] of [...this.#waiting.entries()]) {
      if (waiting.session !== session) { continue; }
      this.#take(id);
      if (waiting.kind === 'permit') { waiting.resolve({ allow: false, reason: 'The session ended.' }); } else { waiting.resolve({ declined: 'The session ended.' }); }
    }
    this.#change(entry, { status: problem === undefined ? 'closed' : 'failed', waiting: [], asking: [], ...(problem === undefined ? {} : { problem }) });
    for (const waiter of [...entry.turnWaiters]) { waiter({ ended: true, problem }); }
  }

  #change(entry: Entry, patch: Partial<ClaudeSession>): void {
    const next: ClaudeSession = { ...entry.value, ...patch, updatedAt: this.#options.now() };
    if (patch.problem === undefined && 'problem' in patch) { delete next.problem; }
    entry.value = next;
    this.#write(entry);
  }

  /** Write the record a debounce from now, once for every change meanwhile. */
  #write(entry: Entry): void {
    if (entry.writeTimer !== undefined) { return; }
    entry.writeTimer = setTimeout(() => { void this.#flush(entry); }, this.#options.debounce);
  }

  async #flush(entry: Entry): Promise<void> {
    clearTimeout(entry.writeTimer);
    entry.writeTimer = undefined;
    const hub = this.#hub();
    if (hub === undefined) { return; }
    try {
      await hub.saveSession(entry.record, entry.value);
    } catch (error) {
      this.#options.log.warn('claude.record_failed', { session: entry.value.session, record: entry.record, problem: String(error) });
    }
  }
}

/** The "always allow" choice on a tool use's card, when Claude suggested a rule for it: optional, so Approve alone allows it once. */
function alwaysAsk(request: PermitRequest): Proposal['ask'] {
  if (!request.canAlways) { return undefined; }
  return { type: wireType(g.optional(g.bool())), into: 'always' };
}

/** A task with a change applied; a new one starts now. */
export function mergeTask(current: ClaudeTask | undefined, change: TaskChange, now: number): ClaudeTask {
  const base: ClaudeTask = current ?? { id: change.id, kind: 'other', description: '', status: 'running', startedAt: now, updatedAt: now };
  const merged: ClaudeTask = { ...base, updatedAt: now };
  if (change.kind !== undefined) { merged.kind = change.kind; }
  if (change.name !== undefined) { merged.name = change.name; }
  if (change.description !== undefined) { merged.description = change.description; }
  if (change.status !== undefined) { merged.status = change.status; }
  if (change.progress !== undefined) { merged.progress = change.progress; }
  if (change.parent !== undefined) { merged.parent = change.parent; }
  return merged;
}

/** Text as one line of at most `max` characters. */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

