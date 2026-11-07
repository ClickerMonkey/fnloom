import { describe, expect, it } from 'vitest';
import { MessageId, SessionId } from '@harness/core';
import type { HubEventName } from '../bus.ts';
import { MemoryEventBus } from './memory.ts';

const session = SessionId.parse('ses_1');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('MemoryEventBus', () => {
  it('calls listeners after publish returns, with the data', async () => {
    const bus = new MemoryEventBus(() => undefined);
    const seen: string[] = [];
    bus.subscribe('session.controls', ({ session: id }) => { seen.push(id); });
    bus.publish('session.controls', { session, controls: { pause: false, cancel: false, uncancellable: [], undoLastTurn: false } });
    expect(seen).toEqual([]);
    await tick();
    expect(seen).toEqual([session]);
  });

  it('keeps events apart', async () => {
    const bus = new MemoryEventBus(() => undefined);
    let calls = 0;
    bus.subscribe('capabilities.changed', () => { calls += 1; });
    bus.publish('message.token', { session, message: MessageId.parse('msg_1'), text: 'x' });
    await tick();
    expect(calls).toBe(0);
  });

  it('stops calling a listener once unsubscribed', async () => {
    const bus = new MemoryEventBus(() => undefined);
    let calls = 0;
    const stop = bus.subscribe('capabilities.changed', () => { calls += 1; });
    bus.publish('capabilities.changed', {});
    await tick();
    stop();
    bus.publish('capabilities.changed', {});
    await tick();
    expect(calls).toBe(1);
    expect(bus.listenerCount('capabilities.changed')).toBe(0);
  });

  it('reports a throwing or rejecting listener and still runs the others', async () => {
    const errors: Array<[HubEventName, unknown]> = [];
    const bus = new MemoryEventBus((event, error) => { errors.push([event, error]); });
    let ran = false;
    bus.subscribe('capabilities.changed', () => { throw new Error('boom'); });
    bus.subscribe('capabilities.changed', () => Promise.reject(new Error('later')));
    bus.subscribe('capabilities.changed', () => { ran = true; });
    bus.publish('capabilities.changed', {});
    await tick();
    expect(ran).toBe(true);
    expect(errors.map(([event, error]) => [event, error instanceof Error ? error.message : error])).toEqual([
      ['capabilities.changed', 'boom'], ['capabilities.changed', 'later'],
    ]);
  });
});
