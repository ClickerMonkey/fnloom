/**
 * What a system page runs and answers through its host (item 8/9): `host.runs` (the SDK's `PageRuns`) and
 * `host.inbox` (`PageInbox`).
 *
 * The runs a page starts are the person's own runs in a harness chat, so the hub's approval rules see them and the chat
 * records them: an item's own chat when the page `attach`es one, else one made for the page the first time something
 * runs. A run resolves only once it has settled with its outcome (`settledRun`: the hub's `done` event comes before the
 * run's record, so it never reports a run that worked as failed). A run that stops for approval waits in the chat's
 * approvals, which the page answers in place.
 */
import type { Approval, InstanceName, Json, QualifiedName, Remember, RunId, SessionId } from '@harness/core';
import type { PageInbox, PageRuns, PageRunsOptions, RunOutcome } from '@harness/sdk';
import { ref, shallowRef } from 'vue';
import type { ApprovalDesk } from '../chat/state/approvals.ts';
import type { ChatStore } from '../chat/state/chat.ts';
import type { ThreadStore } from '../chat/state/thread.ts';
import { settledRun } from '../chat/state/widget-host.ts';

/** What the runs need of the chat. */
export type RunsChat = Pick<ChatStore, 'sessions' | 'thread'>;

/** One chat that runs a page's calls, opened on first use (or at once, for an `attach`ed one). */
export class ChatRuns implements PageRuns {
  readonly #chat: RunsChat;
  readonly #title: () => string;
  #opening: Promise<ThreadStore | undefined> | undefined;
  #closed = false;
  readonly #problem = ref('');
  /** The chat's thread once it is open. */
  readonly thread = shallowRef<ThreadStore | undefined>(undefined);

  constructor(chat: RunsChat, options: PageRunsOptions) {
    this.#chat = chat;
    this.#title = options.title;
  }

  get approvals(): readonly Approval[] {
    return this.thread.value?.approvals.value ?? [];
  }

  get problem(): string {
    return this.#problem.value || this.thread.value?.problem.value || '';
  }

  argsOf(run: RunId): Json | undefined {
    return this.thread.value?.runs.value.get(run)?.args;
  }

  attach(session: SessionId): void {
    this.#opening ??= this.#open(session);
  }

  async run(fn: QualifiedName, args: Json, options: { readonly on?: InstanceName; readonly waiting?: () => void } = {}): Promise<RunOutcome> {
    const thread = await (this.#opening ??= this.#open(undefined));
    if (thread === undefined) {
      this.#opening = undefined;
      return { ok: false, problem: this.#chat.sessions.problem.value || "Couldn't start a chat to run it in." };
    }
    const id = await thread.invoke(fn, args, options.on);
    if (id === undefined) { return { ok: false, problem: thread.problem.value || "Couldn't run that." }; }
    return settledRun(thread, id, options.waiting);
  }

  async approve(approval: Approval, approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<boolean> {
    const thread = this.thread.value;
    if (thread === undefined) { this.#problem.value = 'That approval is no longer open here.'; return false; }
    this.#problem.value = '';
    return thread.approve(approval.id, approve, remember, reason, answer);
  }

  refresh(): void {
    const thread = this.thread.value;
    if (thread !== undefined) { for (const approval of thread.approvals.value) { void thread.ensureRun(approval.run); } }
  }

  close(): void {
    this.#closed = true;
    this.thread.value?.close();
  }

  /** Read through a method: the page may close the runs while one of them awaits. */
  #isClosed(): boolean {
    return this.#closed;
  }

  async #open(existing: SessionId | undefined): Promise<ThreadStore | undefined> {
    const session = existing ?? await this.#chat.sessions.create({ title: this.#title() });
    if (session === undefined || this.#isClosed()) { return undefined; }
    const thread = this.#chat.thread(session);
    await thread.open();
    // the page may have left while the thread opened
    if (this.#isClosed()) { thread.close(); return undefined; }
    this.thread.value = thread;
    return thread;
  }
}

/** The inbox's approvals as a page reads them (`host.inbox`). */
export function pageInbox(desk: Pick<ApprovalDesk, 'byRun' | 'load' | 'decide' | 'problem'>): PageInbox {
  return {
    byRun: (run) => desk.byRun.value.get(run),
    load: (runs) => desk.load(runs),
    decide: (approval, approve, reason, answer) => desk.decide(approval, approve, reason, answer),
    get problem() { return desk.problem.value; },
  };
}
