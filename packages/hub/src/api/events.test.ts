import { describe, expect, it } from 'vitest';
import {
  ApprovalId, DeliveryId, HandlerCallId, MessageId, TurnId, NotificationId, PairingId, QualifiedName, RunId, SessionId, SystemName, ActorId, type Approval, type SessionSummary,
} from '@harness/core';
import { MemoryEventBus } from '../bus/memory.ts';
import { BusEventRelay } from './events.ts';
import type { WebEmit } from './index.ts';
import { settle } from './testing/rig.ts';

const session = SessionId.parse('ses_1');
const fn = QualifiedName.parse('fs/read');
const run = RunId.parse('run_1');

function make() {
  const bus = new MemoryEventBus(() => undefined);
  const sent: unknown[][] = [];
  const emit: WebEmit = (name, ...args) => { sent.push([name, ...args]); };
  const stop = new BusEventRelay(bus).start(emit);
  return { bus, sent, stop };
}

const summary: SessionSummary = {
  id: session, title: 'Plans', owner: ActorId.parse('act_1'), agent: QualifiedName.parse('hub/chat'), status: 'idle', createdAt: 1, updatedAt: 2, archived: false,
};
const approval: Approval = {
  id: ApprovalId.parse('apr_1'), run, fn, approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: 1,
};

describe('BusEventRelay', () => {
  it('relays session events to the session and user events to signed-in browsers', async () => {
    const { bus, sent } = make();
    bus.publish('message.token', { session, message: MessageId.parse('msg_1'), text: 'Hel' });
    bus.publish('run.update', { run, fn, session, update: { type: 'status', status: 'running' } });
    bus.publish('session.changed', { session: summary, participants: [] });
    bus.publish('approval', { session, approval, approvers: [] });
    bus.publish('system.status', { system: SystemName.parse('fs'), status: 'connected' });
    bus.publish('pairing', {
      pairing: {
        id: PairingId.parse('par_1'), name: SystemName.parse('fs'), keyFingerprint: 'f', publicKey: 'k', version: '1', address: 'a', method: 'code', status: 'pending',
        createdAt: 1, expiresAt: 2,
      },
    });
    bus.publish('notification', {
      notification: {
        id: NotificationId.parse('ntf_1'), user: ActorId.parse('act_1'), reason: 'replied', title: 't', body: 'b', link: { session }, read: false, pushed: false, createdAt: 1,
      },
    });
    await settle();
    expect(sent.map(([name, ...rest]) => [name, ...rest.map((part) => (typeof part === 'object' && part !== null && 'type' in part ? part.type : part))])).toEqual([
      ['session', { session }, 'token'],
      ['session', { session }, 'run'],
      ['session', { session }, 'session'],
      ['user', 'session'],
      ['session', { session }, 'approval'],
      ['user', 'approval'],
      ['user', 'system'],
      ['user', 'capabilities'],
      ['user', 'pairing'],
      ['user', 'notification'],
    ]);
  });

  it('relays messages, reasoning, controls, state, deliveries, handler calls, presence and catalog changes', async () => {
    const { bus, sent } = make();
    const user = ActorId.parse('act_1');
    bus.publish('message', {
      message: { id: MessageId.parse('msg_1'), session, turn: TurnId.parse('trn_1'), author: user, role: 'assistant', parts: [], runs: [], status: 'done', replyAll: false, answerers: [], createdAt: 1 },
    });
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
    bus.publish('catalog.changed', { added: [], removed: [], fns: [] });
    await settle();
    expect(sent.map(([name, , data]) => [name, typeof data === 'object' && data !== null && 'type' in data ? data.type : data])).toEqual([
      ['session', 'message'], ['session', 'reasoning'], ['session', 'controls'], ['session', 'state'], ['session', 'delivery'], ['session', 'handler'],
      ['session', 'presence'], ['user', undefined],
    ]);
  });

  it('leaves out run updates and handler calls outside a session', async () => {
    const { bus, sent } = make();
    bus.publish('run.update', { run, fn, update: { type: 'status', status: 'running' } });
    await settle();
    expect(sent).toEqual([]);
  });

  it('stops relaying when stopped', async () => {
    const { bus, sent, stop } = make();
    stop();
    bus.publish('capabilities.changed', {});
    await settle();
    expect(sent).toEqual([]);
    expect(bus.listenerCount('message')).toBe(0);
  });
});
