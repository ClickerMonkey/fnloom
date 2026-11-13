import { IDS, SystemName, type SystemActor } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { RecordingBus, testStore } from '../testing.ts';
import { StoreHubIdentity } from './identity.ts';

const admin = IDS.actor.parse('act_admin');
const hub = SystemName.parse('hub');

async function world(envName?: string) {
  const store = await testStore();
  const bus = new RecordingBus();
  const actor: SystemActor = { id: IDS.actor.parse('act_hub'), kind: 'system', system: hub, name: 'Harness', about: 'The hub itself.', createdAt: 0, disabled: false };
  await store.table('actors').insert(actor);
  return { store, bus, actor, identity: new StoreHubIdentity({ store, bus, clock: () => 5, envName, version: '1.2.3', hub }) };
}

describe('the hub display name', () => {
  it('is the default, else the env, else the admin\'s setting, and goes back when cleared', async () => {
    expect(await (await world()).identity.identity()).toEqual({ name: 'Harness', source: 'default', version: '1.2.3' });
    const w = await world('Family Desk');
    expect(await w.identity.identity()).toMatchObject({ name: 'Family Desk', source: 'env' });
    expect(await w.identity.setName('Ops Room', admin)).toMatchObject({ name: 'Ops Room', source: 'setting' });
    expect(await w.identity.identity()).toMatchObject({ name: 'Ops Room', source: 'setting' });
    expect(await w.identity.setName(null, admin)).toMatchObject({ name: 'Family Desk', source: 'env' });
  });

  it('publishes every change and renames the hub\'s own actor', async () => {
    const w = await world();
    await w.identity.setName('Ops Room', admin);
    expect(w.bus.of('identity').map((e) => e.identity.name)).toEqual(['Ops Room']);
    expect((await w.store.table('actors').get(w.actor.id))?.name).toBe('Ops Room');
    expect(await w.store.table('hubOptions').get('hub.name')).toMatchObject({ value: 'Ops Room', setBy: admin, updatedAt: 5 });
  });

  it('ignores an empty env name', async () => {
    expect(await (await world('  ')).identity.identity()).toMatchObject({ name: 'Harness', source: 'default' });
  });
});
