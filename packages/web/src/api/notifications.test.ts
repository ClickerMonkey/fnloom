import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { ActorId, type UserEvent } from '@harness/core';
import type { Hub } from './client.ts';
import { userEvents } from './notifications.ts';

describe('userEvents', () => {
  it('listens as whoever is signed in, and again as the next person', async () => {
    const subs: unknown[] = [];
    const stops: unknown[] = [];
    const hub = {
      on: (channel: string, params: unknown, listener: (event: UserEvent) => void) => {
        subs.push([channel, params]);
        listener({ type: 'capabilities' });
        return () => { stops.push(params); };
      },
    } as unknown as Hub;
    const me = ref<ActorId | undefined>(undefined);
    const heard: UserEvent[] = [];
    const stop = userEvents(hub, () => me.value)((event) => { heard.push(event); });
    expect(subs).toEqual([]);
    const ann = ActorId.parse('act_ann');
    me.value = ann;
    await nextTick();
    expect(subs).toEqual([['user', { user: ann }]]);
    expect(heard).toHaveLength(1);
    me.value = ActorId.parse('act_bo');
    await nextTick();
    expect(stops).toEqual([{ user: ann }]);
    expect(subs).toEqual([['user', { user: ann }], ['user', { user: 'act_bo' }]]);
    stop();
    expect(stops).toEqual([{ user: ann }, { user: 'act_bo' }]);
  });
});
