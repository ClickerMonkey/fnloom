import { ActorId, QualifiedName, SystemName, type Actor, type UserConnection, ConnectionId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { FixtureCatalog } from '../chat/testing.ts';
import { RecordingBus, testStore } from '../testing.ts';
import type { ConnectionGate } from './index.ts';
import { StoreAccessService } from './service.ts';

const HUB = ActorId.parse('act_hub');
const ADA = ActorId.parse('act_ada');
const BEN = ActorId.parse('act_ben');
const CAL = ActorId.parse('act_cal');
const TEAM = ActorId.parse('act_team');
const READ = QualifiedName.parse('fs/read');
const FS = SystemName.parse('fs');

const person = (id: ActorId, role: 'admin' | 'member'): Actor => ({ id, kind: 'user', name: id, email: `${id}@x`, role, about: '', createdAt: 0, disabled: false });

async function world(gate: ConnectionGate = { fn: () => undefined }) {
  const store = await testStore();
  for (const actor of [person(ADA, 'admin'), person(BEN, 'member'), person(CAL, 'member')]) await store.table('actors').insert(actor);
  await store.table('memberships').insert({ group: TEAM, user: CAL, addedBy: ADA, addedAt: 0 });
  const bus = new RecordingBus();
  const access = new StoreAccessService({
    store, bus, clock: () => 5, catalog: new FixtureCatalog(), hubActor: HUB, gate: () => Promise.resolve(gate),
    systemOf: (uri) => (uri.startsWith('file://') ? 'fs' : undefined),
  });
  return { store, bus, access };
}

describe('visibility', () => {
  it('reads anything without a row as public, owned by whoever added it, and tells a one-person hub apart', async () => {
    const { access, store } = await world();
    expect(await access.sharing({ kind: 'fn', fn: READ })).toEqual({ owner: HUB, visibility: 'public', with: [] });
    expect((await access.scope(BEN)).seesFn({ name: READ, system: FS })).toBe(true);
    expect(await access.info()).toEqual({ multiUser: true });
    await store.table('actors').update(BEN, { disabled: true });
    await store.table('actors').update(CAL, { disabled: true });
    expect(await access.info()).toEqual({ multiUser: false });
  });

  it('keeps private things to their owner, shares with people and groups, and lets admins see all', async () => {
    const { access, bus } = await world();
    await access.set(ADA, { kind: 'system', system: FS }, { visibility: 'private', with: [] });
    expect((await access.scope(BEN)).seesFn({ name: READ, system: FS })).toBe(false);
    expect((await access.scope(ADA)).seesFn({ name: READ, system: FS })).toBe(true);
    expect(bus.of('capabilities.changed')).toHaveLength(1);
    await access.set(ADA, { kind: 'system', system: FS }, { visibility: 'shared', with: [TEAM] });
    expect((await access.scope(CAL)).seesSystem('fs')).toBe(true);
    expect((await access.scope(BEN)).seesSystem('fs')).toBe(false);
  });

  it('refuses a change by anyone but the owner or an admin, and leaves out targets the asker cannot see', async () => {
    const { access } = await world();
    await expect(access.set(BEN, { kind: 'fn', fn: READ }, { visibility: 'private', with: [] })).rejects.toThrow(/owner or an admin/);
    await access.set(ADA, { kind: 'fn', fn: READ }, { visibility: 'private', with: [] });
    expect(await access.views(BEN, [{ kind: 'fn', fn: READ }])).toEqual([]);
    expect(await access.views(ADA, [{ kind: 'fn', fn: READ }])).toEqual([{ target: { kind: 'fn', fn: READ }, sharing: { owner: HUB, visibility: 'private', with: [] }, editable: true }]);
  });

  it('lets the closest root above a resource decide, and hides context made from it', async () => {
    const { access } = await world();
    await access.set(ADA, { kind: 'root', uri: 'hub://web/crawls' }, { visibility: 'private', with: [] });
    await access.set(ADA, { kind: 'root', uri: 'hub://web/crawls/shared' }, { visibility: 'public', with: [] });
    const ben = await access.scope(BEN);
    expect(ben.seesUri('hub://web/crawls/site/page.md')).toBe(false);
    expect(ben.seesUri('hub://web/crawls/shared/page.md')).toBe(true);
    expect(ben.seesUri('hub://web/crawlsother')).toBe(true);
    const made = { name: QualifiedName.parse('hub/resource/page'), system: SystemName.parse('hub'), origin: { type: 'resource' as const, uri: 'hub://web/crawls/site/page.md' as const, version: 'v', copy: 'snapshot' as const } };
    expect(ben.seesContext(made)).toBe(false);
  });

  it('leaves out a per-person fn switched off, and lists one without a connection as not usable', async () => {
    const off = QualifiedName.parse('cal/delete_event');
    const missing = QualifiedName.parse('cal/list_events');
    const { access } = await world({ fn: (record) => (record.name === off ? { state: 'off' } : record.name === missing ? { state: 'missing', page: 'Calendar' } : undefined) });
    const ben = await access.scope(BEN);
    expect(ben.seesFn({ name: off, system: 'cal' })).toBe(false);
    expect(ben.seesFn({ name: missing, system: 'cal' })).toBe(true);
    expect(ben.mayUse({ name: missing, system: 'cal' })).toBe(false);
  });

  it('keeps a connection\'s sharing on the connection itself', async () => {
    const { access, store } = await world();
    const connection: UserConnection = {
      id: ConnectionId.parse('cnx_1'), system: SystemName.parse('cal'), owner: BEN, status: 'connected', settings: {}, fns: {}, share: { visibility: 'private', with: [] }, createdAt: 0, updatedAt: 0,
    };
    await store.table('connections').insert(connection);
    const target = { kind: 'connection' as const, connection: connection.id };
    await expect(access.set(CAL, target, { visibility: 'public', with: [] })).rejects.toThrow(/owner/);
    await access.set(BEN, target, { visibility: 'shared', with: [CAL, CAL] });
    expect((await store.table('connections').get(connection.id))?.share).toEqual({ visibility: 'shared', with: [CAL] });
    expect(await access.views(CAL, [target])).toEqual([{ target, sharing: { owner: BEN, visibility: 'shared', with: [CAL] }, editable: false }]);
  });
});
