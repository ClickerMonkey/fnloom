/**
 * Starting a chat from outside one (a system page's `host.openChat`, the fn page's "Open in chat"): the chat is made as
 * the person, a fn runs there first when given (as the person's own run, so its approvals, row actions and undo work
 * where the chat shows them), and the app moves to it.
 */
import type { ChatStart } from '@harness/sdk';
import type { SessionId } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { links } from '../../app/routes.ts';
import type { SessionListStore } from './sessions.ts';
import type { ThreadStore } from './thread.ts';

/** What starting a chat uses: the session list (to make the chat), its thread (to run the fn) and the router. */
export interface OpenChatDeps {
  readonly chat: {
    readonly sessions: Pick<SessionListStore, 'create' | 'problem'>;
    thread(session: SessionId): Pick<ThreadStore, 'invoke' | 'problem'>;
  };
  readonly push: (to: RouteLocationRaw) => Promise<unknown>;
}

/** Make the chat, run its first fn and go there; rejects with the reason when the chat couldn't be made or the fn not started. */
export async function openChat(deps: OpenChatDeps, start: ChatStart): Promise<SessionId> {
  const session = await deps.chat.sessions.create({ title: start.title });
  if (session === undefined) { throw new Error(deps.chat.sessions.problem.value || "Couldn't start a chat."); }
  if (start.run !== undefined) {
    const thread = deps.chat.thread(session);
    const run = await thread.invoke(start.run.fn, start.run.args);
    if (run === undefined) { throw new Error(thread.problem.value || "Couldn't run that."); }
  }
  await deps.push(links.session(session));
  return session;
}
