/**
 * The Claude pages' state (item 8/9), over what the page host gives: the hub client (the person's `claude/Session`
 * records and the `claude/transcript` read), the page's runs in a harness chat (`host.runs`: start, send, control,
 * each the person's own run, resolving only once it settled with its outcome) and the inbox's approvals.
 *
 * - `ClaudeFleet`: the sessions under the URL's filters a page at a time (searched, filtered and sorted by the hub),
 *   read again quietly while the page is open.
 * - `ClaudeStarter`: starting a session as a run in a chat made for it; its approval is answered in the dialog.
 * - `ClaudeSessionStore`: one session's record, its transcript (or a subagent's) a page at a time with new entries
 *   added while it works, what waits on the person, and sending, interrupting, stopping and switching its mode.
 */
import { jsonOf, type Approval, type ApprovalId, type Json, type Remember, type RunId } from '@harness/core';
import type { HubClient, PageInbox, PageRuns, PageRunsOptions } from '@harness/sdk';
import { computed, ref, shallowRef, watch, type WatchStopHandle } from 'vue';
import { ClaudeTranscriptPage, ClaudeTurn, type ClaudeControl, type ClaudePermissionMode, type ClaudeSessionRef, type ClaudeTranscriptItem } from '../shared/session.ts';
import { CLAUDE_FNS, FLEET_PAGE, fleetQuery, folderName, isBusy, sessionQuery, sessionsOf, startArgs, TRANSCRIPT_PAGE, type FleetSession, type FleetUrl, type StartDraft } from './logic.ts';

/** A problem in words: the error's message, else the fallback. */
function problemText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback;
}

/** What the fleet reads through. */
export type RecordsHub = Pick<HubClient, 'caller'>;

/** The fleet list. */
export class ClaudeFleet {
  readonly #records;
  #url: FleetUrl = {};
  #cursor: string | undefined;
  #generation = 0;
  readonly items = shallowRef<readonly FleetSession[]>([]);
  readonly loading = ref(false);
  readonly loadingMore = ref(false);
  readonly loaded = ref(false);
  readonly problem = ref('');
  readonly hasMore = ref(false);

  constructor(hub: RecordsHub) {
    this.#records = hub.caller('records');
  }

  /** Show the sessions under these filters, from the first page. */
  async show(url: FleetUrl): Promise<void> {
    this.#url = url;
    this.loading.value = true;
    await this.#first();
    this.loading.value = false;
  }

  /** Read the first page again without the loading state; skipped once more pages are shown (they'd be cut). */
  async refresh(): Promise<void> {
    if (this.items.value.length > FLEET_PAGE || this.loadingMore.value) { return; }
    await this.#first();
  }

  /** The next page, added under the ones shown. */
  async more(): Promise<void> {
    if (this.#cursor === undefined || this.loadingMore.value) { return; }
    const generation = this.#generation;
    this.loadingMore.value = true;
    try {
      const page = await this.#records.call(fleetQuery(this.#url, this.#cursor));
      if (generation !== this.#generation) { return; }
      this.items.value = [...this.items.value, ...sessionsOf(page.items)];
      this.#cursor = page.cursor;
      this.hasMore.value = page.cursor !== undefined;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't read more sessions.");
    } finally {
      this.loadingMore.value = false;
    }
  }

  async #first(): Promise<void> {
    const generation = ++this.#generation;
    try {
      const page = await this.#records.call(fleetQuery(this.#url));
      if (generation !== this.#generation) { return; }
      this.items.value = sessionsOf(page.items);
      this.#cursor = page.cursor;
      this.hasMore.value = page.cursor !== undefined;
      this.problem.value = '';
      this.loaded.value = true;
    } catch (error) {
      if (generation === this.#generation) { this.problem.value = problemText(error, "Couldn't read your Claude sessions."); }
    }
  }
}

/** Makes the chat a page's runs go to (`host.runs`). */
export type RunsOf = (options: PageRunsOptions) => PageRuns;

/** Where starting a session is: being typed, sent, or waiting for its approval. */
export type StartPhase = 'typing' | 'starting' | 'approval';

/** Starting one session. */
export class ClaudeStarter {
  readonly #runsOf: RunsOf;
  readonly phase = ref<StartPhase>('typing');
  readonly problems = shallowRef<Readonly<Record<string, string>>>({});
  readonly problem = ref('');
  /** The chat the start runs in, once made: its approval is answered in the dialog. */
  readonly runs = shallowRef<PageRuns | undefined>(undefined);
  readonly busy = computed(() => this.phase.value !== 'typing');
  /** The start's own approval (it is a write), answered in the dialog. */
  readonly approval = computed((): Approval | undefined => this.runs.value?.approvals[0]);

  constructor(runsOf: RunsOf) {
    this.#runsOf = runsOf;
  }

  /** Start a session from the form; the session once it is live, else undefined (with `problems` or `problem` set). */
  async start(draft: StartDraft): Promise<ClaudeSessionRef | undefined> {
    const checked = startArgs(draft);
    if (!checked.ok) { this.problems.value = checked.problems; return undefined; }
    this.problems.value = {};
    this.problem.value = '';
    this.phase.value = 'starting';
    const title = checked.args.title ?? folderName(checked.args.folder);
    this.runs.value?.close();
    const runs = this.#runsOf({ title: () => `Claude: ${title}` });
    this.runs.value = runs;
    const outcome = await runs.run(CLAUDE_FNS.start, jsonOf(checked.args), { ...(checked.on === undefined ? {} : { on: checked.on }), waiting: () => { this.phase.value = 'approval'; } });
    this.phase.value = 'typing';
    if (!outcome.ok) { this.problem.value = outcome.problem; return undefined; }
    const turn = ClaudeTurn.safeParse(outcome.output);
    if (!turn.success) { this.problem.value = 'The session started, but its answer could not be read.'; return undefined; }
    return { instance: turn.data.instance, session: turn.data.session };
  }

  /** Answer the start's approval in the dialog. */
  async decide(approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<boolean> {
    const runs = this.runs.value;
    const approval = this.approval.value;
    if (runs === undefined || approval === undefined) { return false; }
    const ok = await runs.approve(approval, approve, remember, reason, answer);
    if (!ok) { this.problem.value = runs.problem || "Couldn't send your answer."; }
    return ok;
  }

  /** Stop listening to the start's chat (the dialog closed or the page left). */
  close(): void {
    this.runs.value?.close();
    this.runs.value = undefined;
    this.phase.value = 'typing';
  }
}

/** A waiting approval and who answers it: the session's chat (which may remember the answer), or the inbox. */
export interface WaitingCard {
  readonly approval: Approval;
  readonly inChat: boolean;
}

/** What a session page needs. */
export interface SessionDeps {
  readonly hub: RecordsHub;
  readonly runs: RunsOf;
  readonly inbox: PageInbox;
}

/** One session, as its page shows it. */
export class ClaudeSessionStore {
  readonly #deps: SessionDeps;
  readonly #records;
  readonly #readFn;
  readonly ref: ClaudeSessionRef;
  /** A subagent's transcript shown instead of the main one (its task id). */
  readonly #agent: string | undefined;
  readonly runs: PageRuns;
  readonly record = shallowRef<FleetSession | undefined>(undefined);
  readonly loading = ref(true);
  readonly missing = ref(false);
  readonly problem = ref('');
  readonly items = shallowRef<readonly ClaudeTranscriptItem[]>([]);
  readonly transcriptLoading = ref(false);
  readonly transcriptProblem = ref('');
  /** The first stored message shown (the transcript reads newest first); older ones are read above it. */
  readonly first = ref(0);
  /** Older messages come before the ones shown. */
  readonly older = computed(() => this.first.value > 0);
  /** Just past the newest stored message shown: new ones are read from here while it works. */
  #end = 0;
  readonly sending = ref(false);
  /** A run this page started waits for the person's approval (shown in place). */
  readonly awaiting = ref(false);
  readonly controlling = ref(false);
  #stopWatch: WatchStopHandle | undefined;

  readonly status = computed(() => this.record.value?.value.status);
  readonly busy = computed(() => this.status.value !== undefined && isBusy(this.status.value));

  constructor(deps: SessionDeps, ref: ClaudeSessionRef, agent?: string) {
    this.#deps = deps;
    this.#records = deps.hub.caller('records');
    this.#readFn = deps.hub.caller('readFn');
    this.ref = ref;
    this.#agent = agent;
    this.runs = deps.runs({ title: () => `Claude: ${this.record.value?.value.title || folderName(this.record.value?.value.folder ?? 'session')}` });
    // the session's own chat holds its cards: run in it as soon as the record names it
    this.#stopWatch = watch(() => this.record.value?.value.chat, (chat) => { if (chat !== undefined) { this.runs.attach(chat); } });
  }

  /**
   * What waits on the person: the approvals in the session's chat that are about this session (its proposals, and
   * the runs this page started), and its other waiting runs (from the inbox), oldest first, once each.
   */
  readonly waiting = computed((): WaitingCard[] => {
    const cards = new Map<RunId, WaitingCard>();
    for (const approval of this.runs.approvals) {
      if (this.#about(this.runs.argsOf(approval.run))) { cards.set(approval.run, { approval, inChat: true }); }
    }
    for (const run of this.record.value?.value.waiting ?? []) {
      const approval = this.#deps.inbox.byRun(run);
      if (approval !== undefined && !cards.has(run)) { cards.set(run, { approval, inChat: false }); }
    }
    return [...cards.values()].sort((a, b) => a.approval.createdAt - b.approval.createdAt);
  });

  /** Read the record and the latest page of the transcript. */
  async open(): Promise<void> {
    await this.#readRecord();
    this.loading.value = false;
    if (this.record.value !== undefined) { await this.#page({ offset: 0, limit: TRANSCRIPT_PAGE, fromEnd: true }, 'latest'); }
  }

  /** Read the record again quietly, the new transcript entries while it works, and the runs its approvals wait on. */
  async refresh(): Promise<void> {
    const before = this.record.value?.value.updatedAt;
    await this.#readRecord();
    this.runs.refresh();
    const changed = this.record.value?.value.updatedAt !== before;
    if (changed || this.busy.value) { await this.#page({ offset: this.#end, limit: TRANSCRIPT_PAGE, fromEnd: false }, 'after'); }
  }

  /** The page of the transcript before the oldest shown. */
  async more(): Promise<void> {
    const start = Math.max(0, this.first.value - TRANSCRIPT_PAGE);
    if (this.older.value) { await this.#page({ offset: start, limit: this.first.value - start, fromEnd: false }, 'before'); }
  }

  /** Send Claude a message (it resumes a closed session first); true once its run settled done. */
  async send(text: string): Promise<boolean> {
    const message = text.trim();
    if (message === '' || this.sending.value) { return false; }
    this.sending.value = true;
    try {
      return await this.#run(CLAUDE_FNS.send, { ...this.ref, text: message, wait: false });
    } finally {
      this.sending.value = false;
    }
  }

  /** Interrupt the current turn, stop the session or (`mode`) only switch its permission mode; `mode` switches it with the others too. */
  async control(action: ClaudeControl['action'], mode?: ClaudePermissionMode): Promise<boolean> {
    if (this.controlling.value) { return false; }
    this.controlling.value = true;
    try {
      return await this.#run(CLAUDE_FNS.control, { ...this.ref, action, ...(mode === undefined ? {} : { mode }) });
    } finally {
      this.controlling.value = false;
    }
  }

  /** Answer a waiting card; false (with `problem` set) when the hub refused. */
  async decide(card: WaitingCard, approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<boolean> {
    const ok = card.inChat
      ? await this.runs.approve(card.approval, approve, remember, reason, answer)
      : await this.#deps.inbox.decide(card.approval, approve, reason, answer);
    if (!ok) { this.problem.value = (card.inChat ? this.runs.problem : this.#deps.inbox.problem) || "Couldn't send your answer."; }
    return ok;
  }

  /** The card of an approval, by id. */
  card(id: ApprovalId): WaitingCard | undefined {
    return this.waiting.value.find((card) => card.approval.id === id);
  }

  /** Stop listening (the page left). */
  close(): void {
    this.#stopWatch?.();
    this.#stopWatch = undefined;
    this.runs.close();
  }

  /** Run one of the session's fns on its machine as the person's run; true once it settled done, else `problem` says why. */
  async #run(fn: (typeof CLAUDE_FNS)[keyof typeof CLAUDE_FNS], args: Json): Promise<boolean> {
    try {
      const outcome = await this.runs.run(fn, args, { on: this.ref.instance, waiting: () => { this.awaiting.value = true; } });
      if (!outcome.ok) { this.problem.value = outcome.problem; return false; }
      this.problem.value = '';
      await this.refresh();
      return true;
    } finally {
      this.awaiting.value = false;
    }
  }

  /** Whether a run's args are about this session. */
  #about(args: Json | undefined): boolean {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) { return false; }
    return args['session'] === this.ref.session && (args['instance'] === undefined || args['instance'] === this.ref.instance);
  }

  async #readRecord(): Promise<void> {
    try {
      const page = await this.#records.call(sessionQuery(this.ref.instance, this.ref.session));
      const found = sessionsOf(page.items)[0];
      this.record.value = found;
      this.missing.value = found === undefined;
      if (found !== undefined && found.value.waiting.length > 0) { await this.#deps.inbox.load(found.value.waiting); }
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't read this session.");
    }
  }

  /**
   * Read a page of the transcript: the `latest` one (replacing what is shown), the one `before` the oldest shown, or
   * what came `after` the newest (quietly, while it works: the loading state stays off).
   */
  async #page(at: { offset: number; limit: number; fromEnd: boolean }, place: 'latest' | 'before' | 'after'): Promise<void> {
    if (this.transcriptLoading.value) { return; }
    const quiet = place === 'after';
    if (!quiet) { this.transcriptLoading.value = true; }
    try {
      const raw = await this.#readFn.call({ fn: CLAUDE_FNS.transcript, args: { ...this.ref, ...at, ...(this.#agent === undefined ? {} : { agent: this.#agent }) } });
      const page = ClaudeTranscriptPage.parse(raw);
      if (place === 'before') {
        this.items.value = [...page.items, ...this.items.value];
        this.first.value = page.offset;
      } else {
        this.items.value = place === 'latest' ? page.items : [...this.items.value, ...page.items];
        if (place === 'latest') { this.first.value = page.offset; }
        this.#end = page.end;
      }
      this.transcriptProblem.value = '';
    } catch (error) {
      if (!quiet) { this.transcriptProblem.value = problemText(error, "Couldn't read the transcript."); }
    } finally {
      this.transcriptLoading.value = false;
    }
  }
}
