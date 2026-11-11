import { ApiError } from '@ayepi/core';
import { ApprovalId, InstanceName, MAIN_INSTANCE, MessageId, noFnStats, QualifiedName, ResourceUri, RunId, SessionId, SystemName, TurnId, type InstallSubject, type InstanceRef, type KindDescription, type Manifest } from '@harness/core';
import { g, wireType } from '@harness/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, declOf, manifestFor, orders, shop, vectors } from '../catalog/fixtures.ts';
import { settle } from '../testing.ts';
import { fingerprint, makeKeyPair, signNonce } from './keys.ts';
import { checkedInstall } from './install.ts';
import { FakeSystem, linkRig, pairDirectly, type LinkRig } from './rig.ts';

const q = (name: string) => QualifiedName.parse(name);
const SHOP = SystemName.parse('shop');
const main = (system: string) => ({ system: SystemName.parse(system), instance: MAIN_INSTANCE });

/** The status an `ApiError` rejection carries. */
async function statusOf(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) { return { status: error.status, code: error.code }; }
    throw error;
  }
  throw new Error('expected a rejection');
}

let rig: LinkRig;
let shopManifest: Manifest;
beforeEach(async () => {
  rig = await linkRig();
  shopManifest = await manifestFor(shop);
});
afterEach(() => rig.stop());

describe('pairing with a code', () => {
  it('waits for an admin, then tells the system and lets it prove its key', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    const reply = await system.connect();
    if ('limits' in reply) { throw new Error('expected pairing'); }
    expect(reply.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(reply.url).toBe(`http://hub/pair/${reply.pairing}?code=${reply.code ?? ''}`);
    expect(reply.expiresAt).toBe(rig.time.now + 60_000);
    const pending = await rig.pairing.pending();
    expect(pending).toMatchObject([{ id: reply.pairing, name: 'shop', instance: 'main', method: 'code', address: '10.0.0.7', keyFingerprint: fingerprint(system.keys.publicKey) }]);
    expect(rig.bus.of('pairing')).toHaveLength(1);

    // the same name and key asking again gets the same request
    expect(await system.hello()).toMatchObject({ kind: 'pairing', pairing: reply.pairing, code: reply.code });

    const record = await rig.pairing.approve(reply.pairing, ADMIN);
    expect(record).toMatchObject({ system: 'shop', instance: 'main', status: 'disconnected', pairedBy: ADMIN, publicKey: system.keys.publicKey });
    const shopRow = await rig.store.table('systems').get(SHOP);
    expect(await rig.store.table('actors').get(shopRow?.actor ?? ADMIN)).toMatchObject({ kind: 'system', system: 'shop' });
    await settle(5);
    expect(system.paired).toEqual([reply.pairing]);
    expect(await rig.pairing.pending()).toEqual([]);

    const welcome = await system.connect();
    expect(welcome).toMatchObject({ instance: 'main', sendManifest: true, start: { first: true }, limits: { maxChunk: 1_024 } });
    expect('config' in welcome).toBe(false);
  });

  it('refuses, and expires, requests', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    const reply = await system.connect();
    if ('limits' in reply) { throw new Error('expected pairing'); }
    await rig.pairing.reject(reply.pairing, ADMIN);
    expect((await rig.store.table('pairings').get(reply.pairing))?.status).toBe('rejected');
    expect(await statusOf(rig.pairing.approve(reply.pairing, ADMIN))).toEqual({ status: 404, code: 'NO_PAIRING' });

    const again = await system.hello();
    if (again.kind !== 'pairing') { throw new Error('expected pairing'); }
    rig.time.now += 61_000;
    expect(await rig.pairing.pending()).toEqual([]);
    expect((await rig.store.table('pairings').get(again.pairing))?.status).toBe('expired');
    // the expiry is announced, so whoever was asked to approve it hears it is over
    expect(rig.bus.of('pairing').at(-1)).toMatchObject({ pairing: { id: again.pairing, status: 'expired' } });
  });

  it('refuses a key that is not Ed25519', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest, { publicKey: 'bm90IGEga2V5', privateKey: 'x' });
    system.open();
    expect(await statusOf(system.hello())).toEqual({ status: 400, code: 'BAD_KEY' });
  });
});

describe('pairing with a token', () => {
  it('approves at once and uses the token up', async () => {
    const { token, expiresAt } = await rig.pairing.createToken({ name: SHOP, expiresIn: 30_000, by: ADMIN });
    expect(expiresAt).toBe(rig.time.now + 30_000);
    const stored = (await rig.store.table('pairingTokens').find({ limit: 10 })).items[0];
    expect(stored?.tokenHash).not.toContain(token);

    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    // it asked with a code first, then came back with the token
    const asked = await system.connect();
    if ('limits' in asked) { throw new Error('expected pairing'); }
    const reply = await system.connect(token);
    if ('limits' in reply) { throw new Error('expected pairing'); }
    expect(reply.code).toBeUndefined();
    expect((await rig.store.table('pairings').get(asked.pairing))?.status).toBe('expired');
    expect(rig.bus.of('pairing').map((e) => e.pairing.status)).toEqual(['pending', 'approved', 'expired']);
    await settle(5);
    expect(system.paired).toEqual([reply.pairing]);
    expect((await rig.store.table('instances').get(main('shop')))?.pairedBy).toBe(ADMIN);

    const other = new FakeSystem(rig.app, 'other', shopManifest);
    other.open();
    expect(await statusOf(other.hello(token))).toEqual({ status: 401, code: 'BAD_PAIRING_TOKEN' });
  });

  it('refuses a token made for another name', async () => {
    const { token } = await rig.pairing.createToken({ name: SystemName.parse('fs'), expiresIn: 30_000, by: ADMIN });
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    system.open();
    expect(await statusOf(system.hello(token))).toEqual({ status: 401, code: 'BAD_PAIRING_TOKEN' });
  });
});

describe('re-keying with a token', () => {
  it('needs a token made for the paired name, so a general token cannot take a system over', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await pairDirectly(rig, system);
    const impostor = new FakeSystem(rig.app, 'shop', shopManifest, makeKeyPair());
    impostor.open();
    const general = await rig.pairing.createToken({ expiresIn: 30_000, by: ADMIN });
    expect(await statusOf(impostor.hello(general.token))).toEqual({ status: 403, code: 'TOKEN_NOT_FOR_SYSTEM' });
    expect((await rig.store.table('instances').get(main('shop')))?.publicKey).toBe(system.keys.publicKey);

    const named = await rig.pairing.createToken({ name: SHOP, expiresIn: 30_000, by: ADMIN });
    expect(await impostor.hello(named.token)).toMatchObject({ kind: 'pairing' });
    expect((await rig.store.table('instances').get(main('shop')))?.publicKey).toBe(impostor.keys.publicKey);
  });
});

describe('the handshake', () => {
  it('asks a known name with another key to pair again, replacing it', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await pairDirectly(rig, system);
    const impostor = new FakeSystem(rig.app, 'shop', shopManifest, makeKeyPair());
    const reply = await impostor.connect();
    expect(reply).toMatchObject({ kind: 'pairing' });
    expect((await rig.pairing.pending())[0]?.replaces).toBe('shop');
  });

  it('refuses a wrong signature, a prove without hello, and calls before the handshake', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await pairDirectly(rig, system);
    system.open();
    expect(await statusOf(system.sdk.call('prove', { signature: 'AAAA' }))).toEqual({ status: 400, code: 'NO_CHALLENGE' });
    const reply = await system.hello();
    if (reply.kind !== 'challenge') { throw new Error('expected a challenge'); }
    expect(await statusOf(system.sdk.call('prove', { signature: signNonce(makeKeyPair().privateKey, reply.nonce) }))).toEqual({ status: 401, code: 'BAD_SIGNATURE' });
    expect(await statusOf(system.sdk.call('manifest', shopManifest))).toEqual({ status: 401, code: 'NOT_LINKED' });
  });

  it('imports the manifest, needs a config, and becomes usable once one is set', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await pairDirectly(rig, system);
    await system.start();
    const record = await rig.store.table('systems').get(SystemName.parse('shop'));
    expect(record).toMatchObject({ status: 'needs-config', manifestHash: shopManifest.hash, description: 'A small shop.' });
    expect(await rig.store.table('instances').get(main('shop'))).toMatchObject({ status: 'needs-config', manifestHash: shopManifest.hash, address: '10.0.0.7' });
    expect(await rig.catalog.availability(q('shop/get'))).toMatchObject({ unavailable: 'system-needs-config' });
    expect(rig.links.connection(SHOP)).toMatchObject({ instance: 'main', boot: 'b-1' });

    expect(await rig.config.set(SHOP, { currency: 'euros' }, ADMIN)).toMatchObject({ problems: [expect.any(String)] });
    expect(await rig.config.set(SHOP, { currency: 'EUR' }, ADMIN)).toEqual({ version: 1 });
    await settle(5);
    expect(system.configured).toEqual([{ value: { currency: 'EUR' }, version: 1 }]);
    expect((await rig.store.table('systems').get(SystemName.parse('shop')))?.status).toBe('connected');
    expect(await rig.catalog.availability(q('shop/get'))).toBe(true);
    expect(rig.bus.of('system.status').map((s) => s.status)).toEqual(['needs-config', 'connected']);

    expect(await rig.config.set(SHOP, { currency: 'USD' }, ADMIN)).toEqual({ version: 2 });
    await settle(5);
    expect(system.configured.at(-1)).toEqual({ value: { currency: 'USD' }, version: 2, previous: { currency: 'EUR' } });
    expect(await rig.config.current(SHOP)).toEqual({ value: { currency: 'USD' }, version: 2 });
  });

  it('gives every one of several configs set at once its own version', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await pairDirectly(rig, system);
    await system.start();
    const sets = await Promise.all(['EUR', 'USD', 'GBP'].map((currency) => rig.config.set(SHOP, { currency }, ADMIN)));
    expect(sets.map((s) => ('version' in s ? s.version : 0)).sort()).toEqual([1, 2, 3]);
    expect((await rig.config.current(SHOP))?.version).toBe(3);
  });

  it('refuses config for unknown systems and systems without a contract', async () => {
    expect(await rig.config.set(SHOP, {}, ADMIN)).toEqual({ problems: ['shop has no instance'] });
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await pairDirectly(rig, system);
    expect(await rig.config.set(SHOP, {}, ADMIN)).toEqual({ problems: ['shop has not sent its contract yet, so its config type is unknown'] });
  });

  it('configures a system with nothing to configure by itself', async () => {
    const system = new FakeSystem(rig.app, 'vectors', await manifestFor(vectors));
    await pairDirectly(rig, system);
    await system.start();
    expect((await rig.store.table('systems').get(SystemName.parse('vectors')))?.status).toBe('connected');
    expect(system.configured).toEqual([{ value: {}, version: 1 }]);
  });

  it('skips the manifest on a reconnect with the same hash, and says when it was upgraded', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await pairDirectly(rig, system);
    await system.start();
    await rig.config.set(SHOP, { currency: 'EUR' }, ADMIN);
    system.drop();
    await settle(5);
    expect((await rig.store.table('systems').get(SystemName.parse('shop')))?.status).toBe('disconnected');
    expect(await rig.catalog.availability(q('shop/get'))).toMatchObject({ unavailable: 'system-disconnected' });

    const waiting = rig.links.whenConnected(SHOP);
    system.boot = 'b-2';
    system.version = '1.1.0';
    const welcome = await system.connect();
    expect(welcome).toMatchObject({ sendManifest: false, start: { first: false, upgradedFrom: '1.0.0' }, config: { value: { currency: 'EUR' }, version: 1 } });
    expect((await waiting).boot).toBe('b-2');
    expect((await rig.store.table('systems').get(SystemName.parse('shop')))?.status).toBe('connected');
  });

  it('asks for the manifest again when some of it was refused', async () => {
    const system = new FakeSystem(rig.app, 'shop', { ...shopManifest, fns: [...shopManifest.fns, { ...declOf(shopManifest, 'get'), name: 'bad', args: wireType(g.text()), returns: { name: 'nothing-here' } }] });
    await pairDirectly(rig, system);
    await system.start();
    expect((await rig.store.table('systems').get(SystemName.parse('shop')))?.manifestHash).toBe('');
  });

  it('refuses a manifest for another system', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await pairDirectly(rig, system);
    await system.connect();
    expect(await statusOf(system.sdk.call('manifest', await manifestFor(orders)))).toEqual({ status: 403, code: 'WRONG_SYSTEM' });
  });

  it('takes patches over the link', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await pairDirectly(rig, system);
    await system.start();
    const report = await system.sdk.call('patch', { hash: 'h2', upsert: {}, remove: { fns: ['list'] } });
    expect(report.removed).toEqual(['shop/list']);
    expect((await rig.store.table('systems').get(SystemName.parse('shop')))?.manifestHash).toBe('h2');
  });
});

describe('kinds over the link', () => {
  it('has the kind’s system describe fns of its kinds', async () => {
    const shopSystem = new FakeSystem(rig.app, 'shop', shopManifest);
    const description: KindDescription = {
      args: wireType(g.obj({})), returns: wireType(g.num()), deps: [], operations: { cancel: true, pause: false, undo: false, background: true },
    };
    shopSystem.behaviour.describe = (kind) => (kind === 'report' ? { problems: [], description } : { problems: ['unknown kind'] });
    await pairDirectly(rig, shopSystem);
    await shopSystem.start();
    const ordersSystem = new FakeSystem(rig.app, 'orders', await manifestFor(orders));
    await pairDirectly(rig, ordersSystem);
    await ordersSystem.start();
    expect((await rig.catalog.fn(q('orders/sales')))?.decl.returns).toEqual(wireType(g.num()));
  });
});

describe('switches and removal', () => {
  it('switches functions off and on, and removes a system', async () => {
    const system = new FakeSystem(rig.app, 'vectors', await manifestFor(vectors));
    const vectorsName = SystemName.parse('vectors');
    await pairDirectly(rig, system);
    await system.start();
    await rig.catalog.declare(vectorsName, { ...declOf(shopManifest, 'get'), name: 'ping' }, ADMIN);
    expect(await rig.catalog.availability(q('vectors/ping'))).toBe(true);
    expect(await rig.admin.setEnabled(vectorsName, { functions: false }, ADMIN)).toEqual({ functions: false, renderers: true, context: true });
    expect(await rig.catalog.availability(q('vectors/ping'))).toMatchObject({ unavailable: 'disabled' });
    await rig.admin.setEnabled(vectorsName, { functions: true }, ADMIN);

    expect(await rig.admin.remove(vectorsName, ADMIN)).toEqual({ fnsUnavailable: 1 });
    expect(system.stops).toEqual(['removed']);
    expect((await rig.store.table('systems').get(SystemName.parse('vectors')))?.status).toBe('removed');
    expect(await rig.catalog.availability(q('vectors/ping'))).toMatchObject({ unavailable: 'system-removed' });
    // a removed name pairs again
    expect(await system.hello()).toMatchObject({ kind: 'pairing' });
    expect(await statusOf(rig.admin.setEnabled(SystemName.parse('ghost'), {}, ADMIN))).toEqual({ status: 404, code: 'NO_SYSTEM' });
    expect((await rig.admin.reimport(vectorsName)).refused).toEqual([]);
  });

  it('switches all of a system\'s context off and on, each item keeping its own switch (build 6)', async () => {
    const system = new FakeSystem(rig.app, 'shop', await manifestFor(shop));
    await pairDirectly(rig, system);
    await system.start();
    const guide = q('shop/guide');
    expect(await rig.catalog.context(guide)).toBeDefined();
    expect(await rig.admin.setEnabled(SHOP, { context: false }, ADMIN)).toEqual({ functions: true, renderers: true, context: false });
    expect(await rig.store.table('context').get(guide)).toMatchObject({ systemOff: true });
    // a person also switches the item off by itself; the system's switch coming back leaves that one off
    await rig.store.table('context').update(guide, { disabled: true });
    await rig.admin.setEnabled(SHOP, { context: true }, ADMIN);
    expect(await rig.store.table('context').get(guide)).toMatchObject({ systemOff: false, disabled: true });
  });

  it('asks every connected system to stop', async () => {
    const system = new FakeSystem(rig.app, 'vectors', await manifestFor(vectors));
    await pairDirectly(rig, system);
    await system.start();
    await rig.links.stopAll('shutdown', 1_000);
    expect(system.stops).toEqual(['shutdown']);
  });
});

describe('resources', () => {
  async function served() {
    const manifest: Manifest = { ...(await manifestFor(vectors)), resources: true };
    const system = new FakeSystem(rig.app, 'vectors', manifest);
    system.behaviour.roots = [
      { uri: ResourceUri.parse('file:///work'), name: 'work', description: 'w', index: 'all', ignore: [], watch: true },
      { uri: ResourceUri.parse('file:///work/deep'), name: 'deep', description: 'd', index: 'none', ignore: [], watch: false },
    ];
    await pairDirectly(rig, system);
    await system.start();
    await settle(5);
    return system;
  }

  it('routes a URI to the longest root of a connected system', async () => {
    const system = await served();
    expect(rig.resources.roots()).toHaveLength(2);
    expect(rig.resources.route(ResourceUri.parse('file:///work/deep/a.md'))?.root.name).toBe('deep');
    expect(rig.resources.route(ResourceUri.parse('file:///work/a.md'))?.root.name).toBe('work');
    expect(rig.resources.route(ResourceUri.parse('file:///workers/a.md'))).toBeUndefined();
    expect(system.watched).toEqual([['file:///work']]);
    system.drop();
    await settle(5);
    expect(rig.resources.roots()).toEqual([]);
  });

  it('asks for roots again once a system becomes connected (its config arrived after it connected)', async () => {
    const system = await served();
    system.behaviour.roots = [{ uri: ResourceUri.parse('file:///later'), name: 'later', description: 'l', index: 'all', ignore: [], watch: false }];
    rig.bus.publish('system.status', { system: SystemName.parse('vectors'), status: 'connected' });
    await settle(5);
    expect(rig.resources.roots().map((r) => r.root.name)).toEqual(['later']);
  });

  it('asks for roots again once a system has applied a config, as fs does (connect, then configure, then started)', async () => {
    const system = new FakeSystem(rig.app, 'shop', { ...shopManifest, resources: true });
    const root = { uri: ResourceUri.parse('file:///shop'), name: 'shop', description: 's', index: 'all' as const, ignore: [], watch: false };
    // like fs, the system serves no roots until its config has been applied
    system.behaviour.configure = () => { system.behaviour.roots = [root]; };
    await pairDirectly(rig, system);
    await system.start();
    await settle(5);
    expect(rig.resources.roots()).toEqual([]);
    await rig.config.set(SHOP, { currency: 'EUR' }, ADMIN);
    await settle(5);
    expect(rig.bus.of('system.configured')).toEqual([{ system: SHOP, version: 1 }]);
    expect(rig.resources.roots().map((r) => r.root.name)).toEqual(['shop']);
  });

  it('reads text inline and by ref in chunks, and answers systems asking for resources', async () => {
    const system = await served();
    const text = 'héllo wörld '.repeat(200);
    const bytes = Buffer.from(text, 'utf8');
    system.behaviour.read = (uri) => ({
      stat: { uri: ResourceUri.parse(uri), name: 'a', type: 'file', version: 'v2' },
      text: uri.endsWith('big.md') ? { ref: { hash: '0'.repeat(64), size: bytes.length, mime: 'text/markdown' } } : { inline: 'small' },
    });
    system.behaviour.content = (offset, length) => bytes.subarray(offset, offset + length).toString('base64');
    expect((await rig.resources.text(ResourceUri.parse('file:///work/big.md'))).text).toBe(text);
    expect((await rig.resources.text(ResourceUri.parse('file:///work/a.md'))).text).toBe('small');
    expect((await rig.resources.stat(ResourceUri.parse('file:///work/a.md')))?.version).toBe('v2');
    expect(await rig.resources.list(ResourceUri.parse('file:///work'))).toEqual({ items: [] });
    expect(await statusOf(rig.resources.read(ResourceUri.parse('http://elsewhere/x'), ['text']))).toEqual({ status: 404, code: 'NO_RESOURCE' });
  });

  it('keeps only changes under the reporting system’s roots', async () => {
    const system = await served();
    await system.resourcesChanged([
      { uri: ResourceUri.parse('file:///work/a.md'), change: 'changed', version: 'v3' },
      { uri: ResourceUri.parse('file:///other/b.md'), change: 'added' },
    ]);
    expect(rig.bus.of('resources.changed')).toEqual([{ system: 'vectors', changes: [{ uri: 'file:///work/a.md', change: 'changed', version: 'v3' }] }]);
  });

  it('cuts resources with a system’s own sectioner', async () => {
    const system = await served();
    system.behaviour.sections = [];
    expect(await rig.resources.sections(q('vectors/csv'), ResourceUri.parse('file:///work/a.csv'), 'v1')).toEqual([]);
    expect(await statusOf(rig.resources.sections(q('ghost/csv'), ResourceUri.parse('file:///work/a.csv'), 'v1'))).toEqual({ status: 503, code: 'SECTIONER_AWAY' });
  });
});

describe('events, embeddings and logs', () => {
  it('relays the hub events a system subscribed to', async () => {
    const manifest: Manifest = { ...(await manifestFor(vectors)), events: ['fns'] };
    const system = new FakeSystem(rig.app, 'vectors', manifest);
    await pairDirectly(rig, system);
    await system.start();
    await rig.catalog.importManifest(shopManifest);
    await settle(10);
    expect(system.events.some((e) => e.type === 'fns' && e.added.includes(q('shop/get')))).toBe(true);
    rig.relay.send({ type: 'resources', changes: [] });
    await settle(5);
    expect(system.events.some((e) => e.type === 'resources')).toBe(false);
    rig.relay.stop();
  });

  it('forwards the logs of systems', async () => {
    const system = new FakeSystem(rig.app, 'vectors', await manifestFor(vectors));
    await pairDirectly(rig, system);
    await system.start();
    await system.sdk.call('log', { level: 'warn', key: 'vectors.slow', fields: { took: 9 } });
    expect(rig.records.find((r) => r.msg === 'vectors.slow')).toMatchObject({ level: 'warn', system: 'vectors', took: 9 });
  });

  it('logs a request and a response line, with a request id, for each call a system makes (progress and logs stay quiet)', async () => {
    const system = new FakeSystem(rig.app, 'vectors', await manifestFor(vectors));
    await pairDirectly(rig, system);
    await system.start();
    rig.records.length = 0;
    await system.sdk.call('fleet', {});
    await system.sdk.call('log', { level: 'info', key: 'vectors.note', fields: {} });
    const lines = rig.records.map((r) => [r.msg, r['path']]);
    expect(lines).toEqual([['request', '/fleet'], ['response', '/fleet'], ['vectors.note', '/log']]);
    const [request, response, note] = rig.records;
    expect(response).toMatchObject({ status: 200, requestId: request?.['requestId'] });
    // logs inside a call carry its trace context
    expect(note?.['requestId']).toEqual(expect.any(String));
  });
});

describe('connections', () => {
  it('lets a newer connection of a system replace the older one', async () => {
    const first = new FakeSystem(rig.app, 'vectors', await manifestFor(vectors));
    await pairDirectly(rig, first);
    await first.start();
    const second = new FakeSystem(rig.app, 'vectors', await manifestFor(vectors), first.keys);
    second.boot = 'b-2';
    await second.start();
    expect(rig.links.connection(SystemName.parse('vectors'))?.boot).toBe('b-2');
    expect(rig.records.some((r) => r.msg === 'link.replaced')).toBe(true);
    first.drop();
    await settle(5);
    expect(rig.links.connected().map((c) => c.boot)).toEqual(['b-2']);
    expect((await rig.store.table('systems').get(SystemName.parse('vectors')))?.status).toBe('connected');
  });

  it('stops waiting for a system when asked', async () => {
    const abort = new AbortController();
    const waiting = rig.links.whenConnected(SystemName.parse('ghost'), abort.signal);
    abort.abort(new Error('gave up'));
    await expect(waiting).rejects.toThrow('gave up');
    await expect(rig.links.whenConnected(SystemName.parse('ghost'), abort.signal)).rejects.toThrow('gave up');
  });
});

describe('the event relay', () => {
  it('turns bus events into system events for subscribers', async () => {
    const manifest: Manifest = { ...(await manifestFor(vectors)), events: ['message', 'run', 'system'] };
    const system = new FakeSystem(rig.app, 'vectors', manifest);
    await pairDirectly(rig, system);
    await system.start();
    await settle(5);
    system.events.length = 0;
    const base = {
      id: MessageId.parse('msg_1'), session: SessionId.parse('ses_1'), turn: TurnId.parse('trn_1'), author: ADMIN, role: 'user' as const, runs: [],
      replyAll: false, answerers: [], createdAt: 7,
    };
    rig.bus.publish('message', { message: { ...base, status: 'streaming', parts: [{ type: 'text', text: 'partial' }] } });
    rig.bus.publish('message', {
      message: { ...base, status: 'done', parts: [{ type: 'text', text: 'see ' }, { type: 'mention', provider: q('fs/files'), label: 'a.md', target: {}, text: '…' }] },
    });
    rig.bus.publish('run.update', { run: RunId.parse('run_1'), fn: q('shop/get'), update: { type: 'status', status: 'running' } });
    rig.bus.publish('system.status', { system: SHOP, status: 'needs-config' });
    rig.bus.publish('system.status', { system: SHOP, status: 'disconnected' });
    await settle(10);
    expect(system.events).toEqual([
      { type: 'message', message: { id: 'msg_1', session: 'ses_1', author: ADMIN, role: 'user', text: 'see a.md', replyAll: false, createdAt: 7 } },
      { type: 'run', run: 'run_1', fn: 'shop/get', update: { type: 'status', status: 'running' } },
      { type: 'system', system: 'shop', status: 'disconnected' },
    ]);
  });
});

describe('pairing granted to an approved install run (build 6)', () => {
  /** fs/install_system approved by an admin for shop, with the install's subject on its preview. */
  async function approvedInstall(manifestHash: string) {
    const fs = SystemName.parse('fs');
    const decl = { ...declOf(shopManifest, 'list'), name: 'install_system', approval: { preview: true, remember: false, approver: 'admins' as const } };
    await rig.store.table('fns').put({ name: q('fs/install_system'), system: fs, decl, version: 'v1', origin: 'contract', available: true, paused: false, disabled: false, stats: noFnStats(), updatedAt: 0 });
    const run = RunId.parse('run_install');
    await rig.store.table('runs').put({
      id: run, fn: q('fs/install_system'), fnVersion: 'v1', kind: 'native', system: fs, instance: MAIN_INSTANCE, root: run, turn: TurnId.parse('trn_install'), key: 'k',
      actor: ADMIN, caller: ADMIN, args: { path: '/systems/shop' }, status: 'running', allowed: { cancel: true, pause: false, background: false },
      cost: 0, totalCost: 0, priority: 'interactive', background: false, attempt: 1, errors: [], stateChanges: [], createdAt: 0,
    });
    const subject: InstallSubject = {
      kind: 'system-install', system: SHOP, instance: MAIN_INSTANCE, version: '1.0.0', manifestHash, bundleHash: 'b'.repeat(64), sourceHash: 's'.repeat(64),
      host: { system: fs, instance: MAIN_INSTANCE },
    };
    await rig.store.table('approvals').put({
      id: ApprovalId.parse('apr_install'), run, fn: q('fs/install_system'), approver: { by: 'admins' }, status: 'approved',
      decisions: [{ by: ADMIN, approve: true, remember: 'once', at: 0 }], createdAt: 0, preview: { title: 'Install shop 1.0.0 on fs/main', parts: [], irreversible: false, subject },
    });
    return { run, subject, host: { system: fs, instance: MAIN_INSTANCE } };
  }

  it('grants a one-time token bound to the subject, pairs only the approved contract, and records the host', async () => {
    const { run, subject, host } = await approvedInstall(shopManifest.hash);
    await expect(rig.pairing.grant({ run, subject: { ...subject, bundleHash: 'c'.repeat(64) } }, host)).rejects.toThrow(/not what was approved/);
    await expect(rig.pairing.grant({ run, subject }, { ...host, system: SHOP })).rejects.toThrow(/not a running run/);
    const { token } = await rig.pairing.grant({ run, subject }, host);
    // a hello with another contract is refused, so the token is still good for the approved one
    const other = new FakeSystem(rig.app, 'shop', { ...shopManifest, hash: 'changed' });
    other.open();
    expect(await statusOf(other.hello(token))).toEqual({ status: 403, code: 'NOT_WHAT_WAS_APPROVED' });
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    const reply = await system.connect(token);
    if ('limits' in reply) { throw new Error('expected pairing'); }
    expect((await rig.store.table('instances').get(main('shop')))?.host).toEqual({ host, path: '/systems/shop', bundleHash: subject.bundleHash, approval: 'apr_install' });
    const again = new FakeSystem(rig.app, 'shop', shopManifest);
    again.open();
    expect(await statusOf(again.hello(token))).toEqual({ status: 401, code: 'BAD_PAIRING_TOKEN' });
  });

  it('records an approved update as the host when the hosted instance says hello again with its key', async () => {
    const { run, subject, host } = await approvedInstall(shopManifest.hash);
    const { token } = await rig.pairing.grant({ run, subject }, host);
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await system.connect(token);
    // the install settled; a restart with no install running changes nothing
    await rig.store.table('runs').update(run, { status: 'done' });
    const restarted = new FakeSystem(rig.app, 'shop', shopManifest, system.keys);
    await restarted.connect();
    expect((await rig.store.table('instances').get(main('shop')))?.host?.approval).toBe('apr_install');
    // fs runs an approved update of the same instance: no token, and the hello records what runs now
    const update = RunId.parse('run_update');
    const row = await rig.store.table('runs').get(run);
    if (row === undefined) { throw new Error('no install run'); }
    await rig.store.table('runs').put({ ...row, id: update, root: update, args: { path: '/systems/shop2' }, status: 'running', createdAt: 1 });
    const bundleHash = 'd'.repeat(64);
    await rig.store.table('approvals').put({
      id: ApprovalId.parse('apr_update'), run: update, fn: q('fs/install_system'), approver: { by: 'admins' }, status: 'approved',
      decisions: [{ by: ADMIN, approve: true, remember: 'once', at: 1 }], createdAt: 1, preview: { title: 'Update shop', parts: [], irreversible: false, subject: { ...subject, version: '1.1.0', bundleHash } },
    });
    const updated = new FakeSystem(rig.app, 'shop', shopManifest, system.keys);
    await updated.connect();
    expect((await rig.store.table('instances').get(main('shop')))?.host).toEqual({ host, path: '/systems/shop2', bundleHash, approval: 'apr_update' });
  });

  it('refuses a grant when the approved install names another host than the asking instance', async () => {
    const { run, subject, host } = await approvedInstall(shopManifest.hash);
    const elsewhere = { ...subject, host: { system: host.system, instance: InstanceName.parse('lab') } };
    await rig.store.table('approvals').update(ApprovalId.parse('apr_install'), { preview: { title: 'Install shop on fs/lab', parts: [], irreversible: false, subject: elsewhere } });
    await expect(rig.pairing.grant({ run, subject: elsewhere }, host)).rejects.toThrow(/hosted by fs@lab, not fs@main/);
  });

  it('refuses a grant for an instance paired now unless the approved card says it replaces it', async () => {
    await pairDirectly(rig, new FakeSystem(rig.app, 'shop', shopManifest));
    const { run, subject, host } = await approvedInstall(shopManifest.hash);
    await expect(rig.pairing.grant({ run, subject }, host)).rejects.toThrow(/shop@main is paired already, and the approved card doesn't say it replaces it/);
    const replacing = { ...subject, replaces: { version: '1.0.0', manifestHash: shopManifest.hash } };
    await rig.store.table('approvals').update(ApprovalId.parse('apr_install'), { preview: { title: 'Replace shop', parts: [], irreversible: false, subject: replacing } });
    await expect(rig.pairing.grant({ run, subject: replacing }, host)).resolves.toHaveProperty('token');
  });
});

describe('an install card checked against the hub\'s instances (build 6)', () => {
  const fs = SystemName.parse('fs');
  const subject: InstallSubject = {
    kind: 'system-install', system: SHOP, instance: MAIN_INSTANCE, version: '2.0.0', manifestHash: 'm'.repeat(64), bundleHash: 'b'.repeat(64), sourceHash: 's'.repeat(64),
    host: { system: fs, instance: MAIN_INSTANCE },
  };
  const card = { title: 'Install shop 2.0.0 on fs@main', parts: [{ type: 'text' as const, text: 'Fns: …' }], irreversible: false, subject };
  const lookup = (ref: InstanceRef) => rig.store.table('instances').get(ref);

  it('leaves a free name alone, refuses a paired one without replace, and says what it replaces with it', async () => {
    expect(await checkedInstall(card, { path: '/systems/shop' }, lookup)).toEqual({ preview: card });
    await pairDirectly(rig, new FakeSystem(rig.app, 'shop', shopManifest));
    const refused = await checkedInstall(card, { path: '/systems/shop' }, lookup);
    expect('refused' in refused ? refused.refused : '').toMatch(/^shop@main is already paired .*replace: true/);
    const checked = await checkedInstall(card, { path: '/systems/shop', replace: true }, lookup);
    if (!('preview' in checked)) { throw new Error(checked.refused); }
    expect(checked.preview.title).toMatch(/^Replace shop@main /);
    expect(checked.preview.subject?.replaces).toBeDefined();
    const first = checked.preview.parts[0];
    expect(first?.type === 'text' ? first.text : '').toMatch(/^\*\*Replaces shop@main\*\*.*takes over its key/);
  });
});
