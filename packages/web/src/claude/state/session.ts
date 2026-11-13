/**
 * One Claude session's page state: its record (read again quietly while the page is open), its transcript (or one
 * subagent's) a page at a time from the start, with new entries added while it works, what it waits on (the approvals
 * and questions of its waiting runs, plus those of the runs this page started, answered in place), and sending,
 * interrupting, stopping and switching its permission mode as the person's runs in the session's chat.
 */
import {
  ClaudeTranscriptPage, type Approval, type ApprovalId, type ClaudeControl, type ClaudePermissionMode, type ClaudeSessionRef, type ClaudeTranscriptItem, type Json, type Remember, type RunId,
} from '@harness/core';
import { computed, ref, shallowRef, watch, type WatchStopHandle } from 'vue';
import type { ApprovalDesk } from '../../chat/state/approvals.ts';
import type { DataStore } from '../../data/state/data.ts';
import { problemText } from '../../state/problems.ts';
import { CLAUDE_FNS, folderName, isBusy, sessionQuery, sessionsOf, TRANSCRIPT_PAGE, type FleetSession } from '../logic/claude.ts';
import { ClaudeRuns, type RunsChat } from './runs.ts';

/** What a session page needs. */
export interface SessionDeps {
  readonly data: Pick<DataStore, 'findRecords' | 'readFn'>;
  readonly chat: RunsChat;
  /** The shared desk of approvals outside a chat (the inbox's), for the session's waiting runs. */
  readonly desk: Pick<ApprovalDesk, 'byRun' | 'load' | 'decide' | 'problem'>;
}

/** A waiting approval and who answers it: the session's chat thread (which may remember the answer), or the desk. */
export interface WaitingCard {
  readonly approval: Approval;
  readonly inThread: boolean;
}

/** One session, as its page shows it. */
export class ClaudeSessionStore {
  readonly #deps: SessionDeps;
  readonly ref: ClaudeSessionRef;
  /** A subagent's transcript shown instead of the main one (its task id). */
  readonly #agent: string | undefined;
  readonly runs: ClaudeRuns;
  readonly record = shallowRef<FleetSession | undefined>(undefined);
  readonly loading = ref(true);
  readonly missing = ref(false);
  readonly problem = ref('');
  readonly items = shallowRef<readonly ClaudeTranscriptItem[]>([]);
  readonly transcriptLoading = ref(false);
  readonly transcriptProblem = ref('');
  /** The offset of the next page; undefined once the transcript is read to its end. */
  readonly next = ref<number | undefined>(undefined);
  readonly sending = ref(false);
  /** A run this page started waits for the person's approval (shown in place). */
  readonly awaiting = ref(false);
  readonly controlling = ref(false);
  #stopWatch: WatchStopHandle | undefined;

  readonly status = computed(() => this.record.value?.value.status);
  readonly busy = computed(() => this.status.value !== undefined && isBusy(this.status.value));

  constructor(deps: SessionDeps, ref: ClaudeSessionRef, agent?: string) {
    this.#deps = deps;
    this.ref = ref;
    this.#agent = agent;
    this.runs = new ClaudeRuns(deps.chat, () => `Claude: ${this.record.value?.value.title || folderName(this.record.value?.value.folder ?? 'session')}`);
    // the session's own chat holds its cards: open it as soon as the record names it
    this.#stopWatch = watch(() => this.record.value?.value.chat, (chat) => { if (chat !== undefined) { this.runs.attach(chat); } });
  }

  /**
   * What waits on the person: the session's waiting runs (from the desk) and the approvals in its chat that are about
   * this session (its proposals, and the runs this page started), oldest first, once each.
   */
  readonly waiting = computed((): WaitingCard[] => {
    const thread = this.runs.thread.value;
    const cards = new Map<RunId, WaitingCard>();
    for (const approval of thread?.approvals.value ?? []) {
      const args = thread?.runs.value.get(approval.run)?.args;
      if (this.#about(args)) { cards.set(approval.run, { approval, inThread: true }); }
    }
    for (const run of this.record.value?.value.waiting ?? []) {
      const approval = this.#deps.desk.byRun.value.get(run);
      if (approval !== undefined && !cards.has(run)) { cards.set(run, { approval, inThread: false }); }
    }
    return [...cards.values()].sort((a, b) => a.approval.createdAt - b.approval.createdAt);
  });

  /** Read the record and the first page of the transcript. */
  async open(): Promise<void> {
    await this.#readRecord();
    this.loading.value = false;
    if (this.record.value !== undefined) { await this.#page(0); }
  }

  /** Read the record again quietly, the new transcript entries while it works, and its waiting runs' approvals. */
  async refresh(): Promise<void> {
    const before = this.record.value?.value.updatedAt;
    await this.#readRecord();
    const thread = this.runs.thread.value;
    if (thread !== undefined) { for (const approval of thread.approvals.value) { void thread.ensureRun(approval.run); } }
    const changed = this.record.value?.value.updatedAt !== before;
    if (this.next.value === undefined && (changed || this.busy.value)) { await this.#page(this.items.value.length, true); }
  }

  /** The next page of the transcript. */
  async more(): Promise<void> {
    if (this.next.value !== undefined) { await this.#page(this.next.value); }
  }

  /** Send Claude a message (it resumes a closed session first). */
  async send(text: string): Promise<boolean> {
    const message = text.trim();
    if (message === '' || this.sending.value) { return false; }
    this.sending.value = true;
    try {
      const outcome = await this.runs.run(CLAUDE_FNS.send, { ...this.ref, text: message, wait: false }, () => { this.awaiting.value = true; });
      if (!outcome.ok) { this.problem.value = outcome.problem; return false; }
      this.problem.value = '';
      await this.refresh();
      return true;
    } finally {
      this.sending.value = false;
      this.awaiting.value = false;
    }
  }

  /** Interrupt the current turn or stop the session, switching its permission mode with it when `mode` is given. */
  async control(action: ClaudeControl['action'], mode?: ClaudePermissionMode): Promise<boolean> {
    if (this.controlling.value) { return false; }
    this.controlling.value = true;
    try {
      const outcome = await this.runs.run(CLAUDE_FNS.control, { ...this.ref, action, ...(mode === undefined ? {} : { mode }) }, () => { this.awaiting.value = true; });
      if (!outcome.ok) { this.problem.value = outcome.problem; return false; }
      this.problem.value = '';
      await this.refresh();
      return true;
    } finally {
      this.controlling.value = false;
      this.awaiting.value = false;
    }
  }

  /** Answer a waiting card; false (with `problem` set) when the hub refused. */
  async decide(card: WaitingCard, approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<boolean> {
    const thread = this.runs.thread.value;
    const ok = card.inThread && thread !== undefined
      ? await thread.approve(card.approval.id, approve, remember, reason, answer)
      : await this.#deps.desk.decide(card.approval, approve, reason, answer);
    if (!ok) { this.problem.value = (card.inThread ? thread?.problem.value : this.#deps.desk.problem.value) || "Couldn't send your answer."; }
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

  /** Whether a run's args are about this session. */
  #about(args: Json | undefined): boolean {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) { return false; }
    return args['session'] === this.ref.session && (args['instance'] === undefined || args['instance'] === this.ref.instance);
  }

  async #readRecord(): Promise<void> {
    try {
      const page = await this.#deps.data.findRecords(sessionQuery(this.ref.instance, this.ref.session));
      const found = sessionsOf(page.items)[0];
      this.record.value = found;
      this.missing.value = found === undefined;
      if (found !== undefined && found.value.waiting.length > 0) { await this.#deps.desk.load(found.value.waiting); }
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't read this session.");
    }
  }

  /** Read a page of the transcript from `offset`; `quiet` (new entries while it works) keeps the loading state off. */
  async #page(offset: number, quiet = false): Promise<void> {
    if (this.transcriptLoading.value) { return; }
    if (!quiet) { this.transcriptLoading.value = true; }
    try {
      const raw = await this.#deps.data.readFn(CLAUDE_FNS.transcript, { ...this.ref, offset, limit: TRANSCRIPT_PAGE, ...(this.#agent === undefined ? {} : { agent: this.#agent }) });
      const page = ClaudeTranscriptPage.parse(raw);
      const known = this.items.value.slice(0, offset);
      this.items.value = [...known, ...page.items];
      this.next.value = page.next;
      this.transcriptProblem.value = '';
    } catch (error) {
      if (!quiet) { this.transcriptProblem.value = problemText(error, "Couldn't read the transcript."); }
    } finally {
      this.transcriptLoading.value = false;
    }
  }
}

