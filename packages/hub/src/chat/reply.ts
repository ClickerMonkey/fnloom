/** The reply rule: which agents answer a message. */
import type { ActorId, ChatMessage, Session } from '@harness/core';
import type { ReplyRule } from './index.ts';
import { agentActorId, peopleOf } from './support.ts';

/**
 * With one person in the session, its agent answers every message (or the agent replied to, or every agent on
 * reply-all). With more than one person, agents stay quiet unless addressed: an agent answers a reply to one of its
 * own messages, and every agent answers a reply-all. Only user messages are answered.
 */
export class SessionReplyRule implements ReplyRule {
  answerers(input: { session: Session; message: ChatMessage; repliedTo?: ChatMessage }): readonly ActorId[] {
    const { session, message, repliedTo } = input;
    if (message.role !== 'user') { return []; }
    const agents = session.participants.filter((p) => p.role === 'agent').map((p) => p.actor);
    if (message.replyAll) { return agents; }
    const addressed = repliedTo === undefined ? undefined : agents.find((agent) => agent === repliedTo.author);
    if (addressed !== undefined) { return [addressed]; }
    if (peopleOf(session).length > 1) { return []; }
    const own = agentActorId(session.agent);
    return agents.includes(own) ? [own] : agents.slice(0, 1);
  }
}
