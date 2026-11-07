import { SystemName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import type { HubServices } from '../boot/index.ts';
import { createChat } from './chat.ts';
import { chatRig, gin, settle } from './testing.ts';

describe('the chat module', () => {
  it('provides every chat service the hub expects', async () => {
    const rig = await chatRig();
    await rig.init();
    const chat = createChat(rig.deps);
    const services: HubServices['chat'] = chat;
    expect(Object.keys(services).sort()).toEqual(['approvers', 'deliveries', 'enrich', 'mentions', 'notifications', 'presence', 'reply', 'sessions', 'start', 'state', 'turns', 'undo']);
  });

  it('flushes deliveries for systems already connected when it starts, and stops listening when stopped', async () => {
    const rig = await chatRig();
    await rig.init();
    const chat = createChat(rig.deps);
    rig.catalog.addEntry('actions', 'fs/ping', { name: 'ping', description: 'Ping.', input: gin({ name: 'any' }), returns: gin({ name: 'any' }) });
    const session = await chat.sessions.create({ owner: rig.admin.id });
    const id = await chat.deliveries.act({ session: session.id, system: SystemName.parse('fs'), action: 'ping', input: 1, actor: rig.admin.id, client: { timeZone: 'UTC', locale: 'en', now: 0 } });
    const answered: number[] = [];
    rig.link.connect('fs', { action: async () => { answered.push(1); return Promise.resolve({ result: 'pong' }); } });
    const stop = chat.start();
    await settle();
    expect((await chat.deliveries.get(id))?.status).toBe('done');
    stop();
    rig.link.disconnect('fs');
    await chat.deliveries.act({ session: session.id, system: SystemName.parse('fs'), action: 'ping', input: 2, actor: rig.admin.id, client: { timeZone: 'UTC', locale: 'en', now: 0 } });
    rig.link.connect('fs', { action: async () => { answered.push(2); return Promise.resolve({ result: 'pong' }); } });
    await settle();
    expect(answered).toEqual([1]);
  });
});
