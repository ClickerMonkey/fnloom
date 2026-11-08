import { ActorId, InstanceName, MAIN_INSTANCE, QualifiedName, ResourceUri, SessionId, SystemName, type Manifest, type ResourceRoot } from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, instanceRow, manifestFor, systemRow, vectors } from '../catalog/fixtures.ts';
import { settle } from '../testing.ts';
import { migrateLegacyInstances } from './migrate.ts';
import { FakeSystem, linkRig, pairDirectly, type LinkRig } from './rig.ts';
import { ambiguous, authorityInstance, urisIn } from './router.ts';
import { defaultInstanceOf, liveStatus, systemStatus } from './status.ts';

const FS = SystemName.parse('vectors');
const LAPTOP = InstanceName.parse('laptop');
const DESK = InstanceName.parse('desk');
const READ = QualifiedName.parse('vectors/read');

let rig: LinkRig;
let manifest: Manifest;
beforeEach(async () => {
  rig = await linkRig();
  manifest = { ...(await manifestFor(vectors)), resources: true };
});
afterEach(() => rig.stop());

/** A paired, connected instance of the vectors system serving one root under its own name. */
async function instance(name: InstanceName): Promise<FakeSystem> {
  const system = new FakeSystem(rig.app, 'vectors', manifest);
  system.instance = name;
  system.behaviour.roots = [root(name)];
  await pairDirectly(rig, system);
  await system.start();
  await settle(5);
  return system;
}

/** An instance's root: its name is the URI's authority, as the SDK writes fleet URIs. */
function root(name: InstanceName): ResourceRoot {
  return { uri: ResourceUri.parse(`file://${name}/work`), name: `${name} work`, description: 'w', index: 'none', ignore: [], watch: false };
}

describe('many instances of one system', () => {
  it('keeps several instances connected at once, each with its own key, config and status', async () => {
    const laptop = await instance(LAPTOP);
    const desk = await instance(DESK);
    expect(rig.links.connections(FS).map((c) => c.instance)).toEqual(['laptop', 'desk']);
    expect(rig.router.connected(FS)).toEqual(['laptop', 'desk']);
    expect((await rig.store.table('systems').get(FS))?.status).toBe('connected');
    expect((await rig.instances.of(FS)).map((i) => [i.instance, i.status])).toEqual([['desk', 'connected'], ['laptop', 'connected']]);
    // each instance's config is its own, and goes only to it
    expect(await rig.config.set(FS, {}, ADMIN, LAPTOP)).toEqual({ version: 2 });
    await settle(5);
    expect(laptop.configured).toEqual([{ value: {}, version: 1 }, { value: {}, version: 2, previous: {} }]);
    expect(desk.configured).toEqual([{ value: {}, version: 1 }]);
    expect(await rig.config.current(FS, DESK)).toEqual({ value: {}, version: 1 });

    desk.drop();
    await settle(5);
    expect(rig.links.connections(FS).map((c) => c.instance)).toEqual(['laptop']);
    expect((await rig.instances.get({ system: FS, instance: DESK }))?.status).toBe('disconnected');
    expect((await rig.store.table('systems').get(FS))?.status).toBe('connected');
    laptop.drop();
    await settle(5);
    expect((await rig.store.table('systems').get(FS))?.status).toBe('disconnected');
  });

  it('lets a new connection of one instance replace only its own', async () => {
    const laptop = await instance(LAPTOP);
    await instance(DESK);
    const again = new FakeSystem(rig.app, 'vectors', manifest, laptop.keys);
    again.instance = LAPTOP;
    again.boot = 'b-2';
    await again.start();
    expect(rig.links.connections(FS).map((c) => `${c.instance}:${c.boot}`).sort()).toEqual(['desk:b-1', 'laptop:b-2']);
  });

  it('proves a key as the instance it was paired as, whatever name it asks for', async () => {
    const laptop = await instance(LAPTOP);
    laptop.drop();
    await settle(5);
    const renamed = new FakeSystem(rig.app, 'vectors', manifest, laptop.keys);
    renamed.instance = MAIN_INSTANCE;
    const welcome = await renamed.connect();
    expect(welcome).toMatchObject({ instance: 'laptop' });
    expect(rig.links.connection(FS, LAPTOP)).toBeDefined();
  });

  it('routes resources to the instance whose root holds the URI, and keeps changes to their own instance', async () => {
    const laptop = await instance(LAPTOP);
    const desk = await instance(DESK);
    laptop.behaviour.read = (uri) => ({ stat: { uri: ResourceUri.parse(uri), name: 'a', type: 'file', version: 'v1' }, text: { inline: 'from the laptop' } });
    desk.behaviour.read = (uri) => ({ stat: { uri: ResourceUri.parse(uri), name: 'a', type: 'file', version: 'v1' }, text: { inline: 'from the desk' } });
    expect(rig.resources.route(ResourceUri.parse('file://desk/work/a.md'))).toMatchObject({ system: 'vectors', instance: 'desk' });
    expect((await rig.resources.text(ResourceUri.parse('file://laptop/work/a.md'))).text).toBe('from the laptop');
    expect((await rig.resources.text(ResourceUri.parse('file://desk/work/a.md'))).text).toBe('from the desk');
    await desk.resourcesChanged([
      { uri: ResourceUri.parse('file://desk/work/a.md'), change: 'changed' },
      { uri: ResourceUri.parse('file://laptop/work/a.md'), change: 'changed' },
    ]);
    expect(rig.bus.of('resources.changed')).toEqual([{ system: 'vectors', changes: [{ uri: 'file://desk/work/a.md', change: 'changed' }] }]);
    desk.drop();
    await settle(5);
    expect(rig.resources.roots().map((r) => r.instance)).toEqual(['laptop']);
  });

  it('removes one instance and leaves the others', async () => {
    const laptop = await instance(LAPTOP);
    await instance(DESK);
    await rig.packages.removeInstance({ system: FS, instance: LAPTOP }, ADMIN);
    expect(laptop.stops).toEqual(['removed']);
    expect((await rig.instances.get({ system: FS, instance: LAPTOP }))?.status).toBe('removed');
    expect((await rig.store.table('systems').get(FS))?.status).toBe('connected');
    await expect(rig.packages.removeInstance({ system: FS, instance: InstanceName.parse('ghost') }, ADMIN)).rejects.toMatchObject({ status: 404 });
  });
});

describe('routing a call to an instance', () => {
  it('needs no choice with one connected instance, and uses the default (or main) with none', async () => {
    expect(await rig.router.route({ fn: READ, args: {} })).toEqual({ instance: { system: FS, instance: 'main' } });
    await instance(LAPTOP);
    expect(await rig.router.route({ fn: READ, args: {} })).toEqual({ instance: { system: FS, instance: 'laptop' } });
  });

  it('picks by on, by a URI in the args, by the session pin and by the default, in that order', async () => {
    await instance(LAPTOP);
    await instance(DESK);
    const session = SessionId.parse('ses_1');
    expect(await rig.router.route({ fn: READ, args: {}, on: DESK })).toEqual({ instance: { system: FS, instance: 'desk' } });
    expect(await rig.router.route({ fn: READ, args: { path: 'file://laptop/work/a.md' } })).toEqual({ instance: { system: FS, instance: 'laptop' } });
    // URIs on two machines don't pick one
    expect(await rig.router.route({ fn: READ, args: { from: 'file://laptop/work/a', to: 'file://desk/work/b' } })).toEqual({ invalid: ambiguous(FS, [LAPTOP, DESK]) });
    rig.router.pin(session, { system: FS, instance: DESK });
    expect(await rig.router.route({ fn: READ, args: {}, session })).toEqual({ instance: { system: FS, instance: 'desk' } });
    // an explicit on still wins over the pin
    expect(await rig.router.route({ fn: READ, args: {}, session, on: LAPTOP })).toEqual({ instance: { system: FS, instance: 'laptop' } });
    rig.router.pin(session, { system: FS });
    expect(await rig.router.route({ fn: READ, args: {}, session })).toMatchObject({ invalid: { source: 'validation' } });
    await rig.instances.syncSystem(FS, { defaultInstance: LAPTOP });
    expect(await rig.router.route({ fn: READ, args: {} })).toEqual({ instance: { system: FS, instance: 'laptop' } });
  });

  it('refuses an ambiguous call, or an instance that is not connected, as invalid input naming the choices', async () => {
    await instance(LAPTOP);
    await instance(DESK);
    expect(await rig.router.route({ fn: READ, args: {} })).toEqual({
      invalid: { source: 'validation', problems: [{ path: 'on', message: 'vectors has several machines: say on=laptop or on=desk' }] },
    });
    expect(await rig.router.route({ fn: READ, args: {}, on: InstanceName.parse('attic') })).toEqual({
      invalid: { source: 'validation', problems: [{ path: 'on', message: 'vectors has no connected instance attic: say on=laptop or on=desk' }] },
    });
  });

  it('finds URIs in nested args and reads instance names from their authority', () => {
    expect(urisIn({ a: ['x', 'file://desk/a', { b: 'http://example.com/q' }], n: 3, t: true, z: null })).toEqual(['file://desk/a', 'http://example.com/q']);
    expect(urisIn({ many: Array.from({ length: 100 }, (_, i) => `file://h/${i}`) })).toHaveLength(64);
    expect(authorityInstance('file://Desk/a', [DESK])).toBe('desk');
    expect(authorityInstance('file:///C:/a', [DESK])).toBeUndefined();
    expect(authorityInstance('file://other/a', [DESK])).toBeUndefined();
    expect(authorityInstance('not a uri', [DESK])).toBeUndefined();
  });
});

describe('statuses', () => {
  it('works an instance status out of its row and connection, and a system status out of its instances', () => {
    expect(liveStatus({ status: 'removed', config: undefined }, true)).toBe('removed');
    expect(liveStatus({ status: 'connected' }, false)).toBe('disconnected');
    expect(liveStatus({ status: 'disconnected' }, true)).toBe('needs-config');
    expect(liveStatus({ status: 'disconnected', config: { value: {}, version: 1, setBy: ADMIN, setAt: 1 } }, true)).toBe('connected');
    expect(systemStatus(['disconnected', 'needs-config'])).toBe('needs-config');
    expect(systemStatus(['disconnected', 'connected', 'needs-config'])).toBe('connected');
    expect(systemStatus(['removed', 'disconnected'])).toBe('disconnected');
    expect(systemStatus(['removed'])).toBe('removed');
    expect(systemStatus([])).toBe('removed');
  });

  it('picks a default instance: the system’s choice, else main, else the first paired', () => {
    const rows = [
      { instance: DESK, status: 'connected' as const, pairedAt: 5 },
      { instance: LAPTOP, status: 'connected' as const, pairedAt: 2 },
      { instance: MAIN_INSTANCE, status: 'removed' as const, pairedAt: 1 },
    ];
    expect(defaultInstanceOf({ defaultInstance: DESK }, rows)).toBe('desk');
    expect(defaultInstanceOf({}, rows)).toBe('laptop');
    expect(defaultInstanceOf({}, [...rows, { instance: MAIN_INSTANCE, status: 'connected' as const, pairedAt: 9 }])).toBe('main');
    expect(defaultInstanceOf({ defaultInstance: InstanceName.parse('gone') }, [])).toBeUndefined();
  });
});

describe('moving build 1 rows onto instances', () => {
  it('gives a system row that still holds a key its main instance, once', async () => {
    const legacy = {
      ...systemRow('shop', 'connected'), keyFingerprint: 'fp-shop', publicKey: 'pk-shop', address: '10.0.0.1', lastSeenAt: 5, pairedAt: 1, pairedBy: ADMIN,
      config: { value: { currency: 'EUR' }, version: 2, setBy: ADMIN, setAt: 3 },
    };
    await rig.store.table('systems').put(legacy);
    await rig.store.table('systems').put(systemRow('fresh', 'disconnected'));
    expect(await migrateLegacyInstances(rig.store, rig.log)).toBe(1);
    const shopName = SystemName.parse('shop');
    expect(await rig.store.table('instances').get({ system: shopName, instance: MAIN_INSTANCE })).toMatchObject({
      keyFingerprint: 'fp-shop', publicKey: 'pk-shop', address: '10.0.0.1', lastSeenAt: 5, pairedBy: ADMIN, config: { version: 2 }, status: 'disconnected',
    });
    const moved = await rig.store.table('systems').get(shopName);
    expect(moved).not.toHaveProperty('keyFingerprint');
    expect(moved?.status).toBe('disconnected');
    expect(await migrateLegacyInstances(rig.store, rig.log)).toBe(0);
    // an instance already there is kept
    await rig.store.table('systems').put(legacy);
    await rig.store.table('instances').put(instanceRow('shop', 'connected', { keyFingerprint: 'kept' }));
    await migrateLegacyInstances(rig.store, rig.log);
    expect((await rig.store.table('instances').get({ system: shopName, instance: MAIN_INSTANCE }))?.keyFingerprint).toBe('kept');
    expect(ActorId.safeParse(moved?.actor).success).toBe(true);
  });
});
