import { describe, expect, it } from 'vitest';
import type { WsConn } from '@ayepi/core';
import {
  ApprovalId, AuthSessionId, BudgetRule, DeliveryId, HandlerCallId, MessageId, TurnId, NotificationId, PairingId, QualifiedName, RunId, SessionId, SystemName, ActorId, type Approval, type SessionSummary,
} from '@harness/core';
import { MemoryEventBus } from '../bus/memory.ts';
import { BusEventRelay, Listeners } from './events.ts';
import type { WebEmit } from './index.ts';
import { settle, testStore } from '../testing.ts';

const session = SessionId.parse('ses_1');
const fn = QualifiedName.parse('fs/read');
const run = RunId.parse('run_1');
const ann = ActorId.parse('act_ann');
const bo = ActorId.parse('act_bo');
const admin = ActorId.parse('act_admin');
const signIn = (id: string) => AuthSessionId.parse(`aus_${id}`);

/** A socket as the server hands it to the event guards. */
function socket(): { conn: WsConn; close: () => void } {
  const closed = new AbortController();
  return { conn: { id: 1, req: new Request('http://hub/ws', { signal: closed.signal }), send: () => undefined, subs: new Set(), streams: new Map(), calls: new Map() }, close: () => { closed.abort(); } };
}

async function make() {
  const bus = new MemoryEventBus(() => undefined);
  const sent: unknown[][] = [];
  const closed: WsConn[] = [];
  const emit: WebEmit = (name, ...args) => { sent.push([name, ...args]); };
  // the admins, as the database answers them
  const store = await testStore();
  await store.table('actors').insert({ id: admin, kind: 'user', name: 'Admin', about: '', email: 'admin@example.com', role: 'admin', createdAt: 1, disabled: false });
  const relay = new BusEventRelay({ bus, store });
  const stop = relay.start(emit, { close: (conn) => { closed.push(conn); } });
  return { bus, sent, stop, relay, closed };
}

/** Each sent event as `[channel, params, type]`. */
const shapes = (sent: unknown[][]) => sent.map(([name, params, data]) => [name, params, typeof data === 'object' && data !== null && 'type' in data ? data.type : data]);

const summary: SessionSummary = {
  id: session, title: 'Plans', owner: ann, agent: QualifiedName.parse('hub/chat'), status: 'idle', createdAt: 1, updatedAt: 2, archived: false,
};
const approval: Approval = {
  id: ApprovalId.parse('apr_1'), run, fn, approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: 1,
};

describe('BusEventRelay', () => {
  it('sends each user event only to the people it is for', async () => {
    const { bus, sent, relay } = await make();
    relay.listen(socket().conn, { user: ann, session: signIn('1') });
    relay.listen(socket().conn, { user: bo, session: signIn('2') });
    bus.publish('session.changed', { session: summary, participants: [ann] });
    bus.publish('session.deleted', { session, participants: [ann] });
    bus.publish('approval', { session, approval, approvers: [bo], turnUser: ann });
    bus.publish('notification', {
      notification: { id: NotificationId.parse('ntf_1'), user: bo, reason: 'replied', title: 't', body: 'b', link: { session }, read: false, pushed: false, createdAt: 1 },
    });
    bus.publish('pairing', {
      pairing: {
        id: PairingId.parse('par_1'), name: SystemName.parse('fs'), keyFingerprint: 'f', publicKey: 'k', version: '1', address: 'a', method: 'code', status: 'pending', createdAt: 1, expiresAt: 2,
      },
    });
    await settle();
    expect(shapes(sent)).toEqual([
      ['session', { session }, 'session'],
      ['user', { user: ann }, 'session'],
      ['user', { user: ann }, 'session-deleted'],
      ['session', { session }, 'approval'],
      ['user', { user: bo }, 'approval'],
      ['user', { user: ann }, 'approval'],
      ['user', { user: bo }, 'notification'],
      ['user', { user: admin }, 'pairing'],
    ]);
  });

  it('sends what changes for everyone to each person listening, once each', async () => {
    const { bus, sent, relay } = await make();
    relay.listen(socket().conn, { user: ann, session: signIn('1') });
    relay.listen(socket().conn, { user: ann, session: signIn('3') });
    const gone = socket();
    relay.listen(gone.conn, { user: bo, session: signIn('2') });
    gone.close();
    bus.publish('system.status', { system: SystemName.parse('fs'), status: 'connected' });
    await settle();
    expect(shapes(sent)).toEqual([['user', { user: ann }, 'system'], ['user', { user: ann }, 'capabilities']]);
  });

  it('relays session events to the session', async () => {
    const { bus, sent } = await make();
    const user = ann;
    bus.publish('message', {
      message: { id: MessageId.parse('msg_1'), session, turn: TurnId.parse('trn_1'), author: user, role: 'assistant', parts: [], runs: [], status: 'done', replyAll: false, answerers: [], createdAt: 1 },
    });
    bus.publish('message.token', { session, message: MessageId.parse('msg_1'), text: 'Hel' });
    bus.publish('message.reasoning', { session, message: MessageId.parse('msg_1'), text: 'think' });
    bus.publish('session.controls', { session, controls: { pause: true, cancel: true, uncancellable: [], undoLastTurn: false } });
    bus.publish('state.changed', { session, system: SystemName.parse('fs'), fields: [{ name: 'open', type: 't', value: true }] });
    bus.publish('delivery', { session, delivery: { id: DeliveryId.parse('dlv_1'), status: 'done' } });
    bus.publish('handler', {
      session,
      call: {
        id: HandlerCallId.parse('hcl_1'), run, handler: 'confirm', args: {}, decl: { description: '', args: { name: 'object', props: {} }, returns: { name: 'bool' } },
        answerer: { user }, status: 'pending', createdAt: 1,
      },
    });
    bus.publish('presence', { presence: { session, user, focused: true, typing: true, lastActiveAt: 1 } });
    const budget = BudgetRule.parse({ id: 'bgt_1', target: { scope: 'hub' }, period: 'all-time', maxCost: 1, onLimit: 'ask', setBy: user });
    bus.publish('budget.reached', { budget, run, reason: 'the hub budget of $1.00 is used up', session });
    bus.publish('budget.reached', { budget, run, reason: 'no session to tell' });
    bus.publish('run.update', { run, fn, update: { type: 'status', status: 'running' } });
    await settle();
    expect(shapes(sent).map(([name, , type]) => [name, type])).toEqual([
      ['session', 'message'], ['session', 'token'], ['session', 'reasoning'], ['session', 'controls'], ['session', 'state'], ['session', 'delivery'], ['session', 'handler'],
      ['session', 'presence'], ['session', 'budget'],
    ]);
  });

  it('ends the sockets of a sign-in, or all of a person’s, when their access ends', async () => {
    const { bus, relay, closed } = await make();
    const [one, two, other] = [socket().conn, socket().conn, socket().conn];
    relay.listen(one, { user: ann, session: signIn('1') });
    relay.listen(two, { user: ann, session: signIn('2') });
    relay.listen(other, { user: bo, session: signIn('3') });
    bus.publish('access.ended', { user: ann, session: signIn('1') });
    await settle();
    // each is ended at once and again once the current work settles (for a subscription a guard was just adding)
    expect(closed).toEqual([one, one]);
    bus.publish('access.ended', { user: ann });
    await settle();
    expect(closed).toEqual([one, one, two, two]);
  });

  it('stops relaying when stopped', async () => {
    const { bus, sent, stop } = await make();
    stop();
    bus.publish('capabilities.changed', {});
    await settle();
    expect(sent).toEqual([]);
    expect(bus.listenerCount('message')).toBe(0);
    expect(bus.listenerCount('access.ended')).toBe(0);
  });
});

describe('Listeners', () => {
  it('forgets a socket once it closes', () => {
    const listeners = new Listeners();
    const { conn, close } = socket();
    listeners.add(conn, { user: ann, session: signIn('1') });
    expect(listeners.people()).toEqual([ann]);
    close();
    expect(listeners.people()).toEqual([]);
    expect(listeners.take({ user: ann })).toEqual([]);
  });
});
