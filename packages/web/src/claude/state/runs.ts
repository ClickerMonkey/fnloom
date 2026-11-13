/**
 * The runs the Claude pages start (`claude/start_session`, `send`, `control`) are the person's own runs in a harness
 * chat, so the hub's approval rules see them and the chat records them: a session's own chat (where its cards also
 * show) when it has one, else one made for it the first time something runs. A run that stops for approval is
 * answered on the page (the thread's approvals) or in that chat.
 */
import type { Json, QualifiedName, SessionId } from '@harness/core';
import { shallowRef } from 'vue';
import type { ChatStore } from '../../chat/state/chat.ts';
import type { ThreadStore } from '../../chat/state/thread.ts';
import { settledRun } from '../../chat/state/widget-host.ts';
import type { RunOutcome } from '../../components/widgets/widgets.ts';

/** What the runs need of the chat. */
export type RunsChat = Pick<ChatStore, 'sessions' | 'thread'>;

/** One chat that runs the page's calls, opened on first use (or at once, for a session's own chat). */
export class ClaudeRuns {
  readonly #chat: RunsChat;
  readonly #title: () => string;
  #opening: Promise<ThreadStore | undefined> | undefined;
  #closed = false;
  /** The chat's thread once it is open: its approvals are the ones the page answers in place. */
  readonly thread = shallowRef<ThreadStore | undefined>(undefined);

  /** `title` names a chat made for these runs. */
  constructor(chat: RunsChat, title: () => string) {
    this.#chat = chat;
    this.#title = title;
  }

  /** Use this chat (a session's own) instead of making one; nothing changes once one is open. */
  attach(session: SessionId): void {
    this.#opening ??= this.#open(session);
  }

  /** Run a fn as the person's run in the chat, resolving when it settles; `waiting` is called if it stops for approval. */
  async run(fn: QualifiedName, args: Json, waiting?: () => void): Promise<RunOutcome> {
    const thread = await (this.#opening ??= this.#open(undefined));
    if (thread === undefined) {
      this.#opening = undefined;
      return { ok: false, problem: this.#chat.sessions.problem.value || "Couldn't start a chat to run it in." };
    }
    const id = await thread.invoke(fn, args);
    if (id === undefined) { return { ok: false, problem: thread.problem.value || "Couldn't run that." }; }
    return settledRun(thread, id, waiting);
  }

  /** Stop listening to the chat (the page left). */
  close(): void {
    this.#closed = true;
    this.thread.value?.close();
  }

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
