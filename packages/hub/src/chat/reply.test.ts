import { IDS, type ChatMessage, type Participant, type Session } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { SessionReplyRule } from './reply.ts';
import { agentActorId } from './support.ts';
import { actorId } from './testing.ts';

const ada = actorId('act_ada');
const bo = actorId('act_bo');
const chat = agentActorId('hub/chat');
const coach = agentActorId('crm/coach');

function session(people: readonly Participant['actor'][], agents = [chat, coach]): Session {
  return {
    id: IDS.session.parse('ses_1'), title: 't', owner: ada, agent: 'hub/chat', systems: 'all', tools: [], context: [], status: 'idle', transcript: [], createdAt: 0, updatedAt: 0,
    archived: false,
    participants: [
      ...people.map((actor, i): Participant => ({ actor, role: i === 0 ? 'owner' : 'member', notify: 'all', joinedAt: 0 })),
      ...agents.map((actor): Participant => ({ actor, role: 'agent', notify: 'none', joinedAt: 0 })),
    ],
  };
}

function message(input: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: IDS.message.parse('msg_new'), session: IDS.session.parse('ses_1'), turn: IDS.turn.parse('trn_1'), author: ada, role: 'user', parts: [], runs: [], status: 'done',
    replyAll: false, answerers: [], createdAt: 0, ...input,
  };
}

const rule = new SessionReplyRule();

describe('the reply rule', () => {
  it('with one person, the session agent answers every message', () => {
    expect(rule.answerers({ session: session([ada]), message: message() })).toEqual([chat]);
  });

  it('with one person, a reply to another agent is answered by that agent', () => {
    const repliedTo = message({ id: IDS.message.parse('msg_old'), author: coach, role: 'assistant' });
    expect(rule.answerers({ session: session([ada]), message: message({ replyTo: repliedTo.id }), repliedTo })).toEqual([coach]);
  });

  it('with one person, a reply to a person still wakes the session agent', () => {
    const repliedTo = message({ id: IDS.message.parse('msg_old'), author: ada });
    expect(rule.answerers({ session: session([ada]), message: message(), repliedTo })).toEqual([chat]);
  });

  it('with more people, agents stay quiet unless addressed', () => {
    expect(rule.answerers({ session: session([ada, bo]), message: message() })).toEqual([]);
  });

  it('with more people, an agent answers a reply to its own message', () => {
    const repliedTo = message({ id: IDS.message.parse('msg_old'), author: coach, role: 'assistant' });
    expect(rule.answerers({ session: session([ada, bo]), message: message(), repliedTo })).toEqual([coach]);
  });

  it('with more people, a reply to a person wakes nobody', () => {
    const repliedTo = message({ id: IDS.message.parse('msg_old'), author: bo });
    expect(rule.answerers({ session: session([ada, bo]), message: message(), repliedTo })).toEqual([]);
  });

  it('wakes every agent on reply-all', () => {
    expect(rule.answerers({ session: session([ada, bo]), message: message({ replyAll: true }) })).toEqual([chat, coach]);
    expect(rule.answerers({ session: session([ada]), message: message({ replyAll: true }) })).toEqual([chat, coach]);
  });

  it('ignores replies to an agent that left the session', () => {
    const repliedTo = message({ id: IDS.message.parse('msg_old'), author: coach, role: 'assistant' });
    expect(rule.answerers({ session: session([ada, bo], [chat]), message: message(), repliedTo })).toEqual([]);
  });

  it('answers only user messages', () => {
    expect(rule.answerers({ session: session([ada]), message: message({ role: 'assistant', author: chat }) })).toEqual([]);
    expect(rule.answerers({ session: session([ada]), message: message({ role: 'note' }) })).toEqual([]);
  });

  it('falls back to the first agent when the session agent is not a participant', () => {
    expect(rule.answerers({ session: session([ada], [coach]), message: message() })).toEqual([coach]);
    expect(rule.answerers({ session: session([ada], []), message: message() })).toEqual([]);
  });
});
