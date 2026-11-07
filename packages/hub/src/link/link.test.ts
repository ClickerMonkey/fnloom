import { ApiError } from '@ayepi/core';
import { MessageId, QualifiedName, ResourceUri, RunId, SessionId, SystemName, TurnId, type KindDescription, type Manifest } from '@harness/core';
import { g, wireType } from '@harness/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, declOf, manifestFor, orders, shop, vectors } from '../catalog/fixtures.ts';
import { settle } from '../catalog/testing.ts';
import { fingerprint, makeKeyPair, signNonce } from './keys.ts';
import { FakeSystem, linkRig, pairDirectly, type LinkRig } from './rig.ts';

const q = (name: string) => QualifiedName.parse(name);
const SHOP = SystemName.parse('shop');

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
    expect(reply.url).toBe(`http://hub:4300/admin/systems?pairing=${reply.pairing}`);
    expect(reply.expiresAt).toBe(rig.time.now + 60_000);
    const pending = await rig.pairing.pending();
    expect(pending).toMatchObject([{ id: reply.pairing, name: 'shop', method: 'code', address: '10.0.0.7', keyFingerprint: fingerprint(system.keys.publicKey) }]);
    expect(rig.bus.of('pairing')).toHaveLength(1);

    // the same name and key asking again gets the same request
    expect(await system.hello()).toMatchObject({ kind: 'pairing', pairing: reply.pairing, code: reply.code });

    const record = await rig.pairing.approve(reply.pairing, ADMIN);
    expect(record).toMatchObject({ name: 'shop', status: 'disconnected', pairedBy: ADMIN, publicKey: system.keys.publicKey });
    expect(await rig.store.table('actors').get(record.actor)).toMatchObject({ kind: 'system', system: 'shop' });
    await settle(5);
    expect(system.paired).toEqual([reply.pairing]);
    expect(await rig.pairing.pending()).toEqual([]);

    const welcome = await system.connect();
    expect(welcome).toMatchObject({ sendManifest: true, start: { first: true }, limits: { maxChunk: 1_024 } });
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
    const reply = await system.connect(token);
    if ('limits' in reply) { throw new Error('expected pairing'); }
    expect(reply.code).toBeUndefined();
    await settle(5);
    expect(system.paired).toEqual([reply.pairing]);
    expect((await rig.store.table('systems').get('shop'))?.pairedBy).toBe(ADMIN);

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
    expect((await rig.store.table('systems').get('shop'))?.publicKey).toBe(system.keys.publicKey);

    const named = await rig.pairing.createToken({ name: SHOP, expiresIn: 30_000, by: ADMIN });
    expect(await impostor.hello(named.token)).toMatchObject({ kind: 'pairing' });
    expect((await rig.store.table('systems').get('shop'))?.publicKey).toBe(impostor.keys.publicKey);
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
    const record = await rig.store.table('systems').get('shop');
    expect(record).toMatchObject({ status: 'needs-config', manifestHash: shopManifest.hash, description: 'A small shop.', address: '10.0.0.7' });
    expect(await rig.catalog.availability(q('shop/get'))).toMatchObject({ unavailable: 'system-needs-config' });
    expect(rig.links.connection(SHOP)?.instance).toBe('i-1');

    expect(await rig.config.set(SHOP, { currency: 'euros' }, ADMIN)).toMatchObject({ problems: [expect.any(String)] });
    expect(await rig.config.set(SHOP, { currency: 'EUR' }, ADMIN)).toEqual({ version: 1 });
    await settle(5);
    expect(system.configured).toEqual([{ value: { currency: 'EUR' }, version: 1 }]);
    expect((await rig.store.table('systems').get('shop'))?.status).toBe('connected');
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
    expect(await rig.config.set(SHOP, {}, ADMIN)).toEqual({ problems: ['no system shop'] });
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await pairDirectly(rig, system);
    expect(await rig.config.set(SHOP, {}, ADMIN)).toEqual({ problems: ['shop has not sent its contract yet, so its config type is unknown'] });
  });

  it('configures a system with nothing to configure by itself', async () => {
    const system = new FakeSystem(rig.app, 'vectors', await manifestFor(vectors));
    await pairDirectly(rig, system);
    await system.start();
    expect((await rig.store.table('systems').get('vectors'))?.status).toBe('connected');
    expect(system.configured).toEqual([{ value: {}, version: 1 }]);
  });

  it('skips the manifest on a reconnect with the same hash, and says when it was upgraded', async () => {
    const system = new FakeSystem(rig.app, 'shop', shopManifest);
    await pairDirectly(rig, system);
    await system.start();
    await rig.config.set(SHOP, { currency: 'EUR' }, ADMIN);
    system.drop();
    await settle(5);
    expect((await rig.store.table('systems').get('shop'))?.status).toBe('disconnected');
    expect(await rig.catalog.availability(q('shop/get'))).toMatchObject({ unavailable: 'system-disconnected' });

    const waiting = rig.links.whenConnected(SHOP);
    system.instance = 'i-2';
    system.version = '1.1.0';
    const welcome = await system.connect();
    expect(welcome).toMatchObject({ sendManifest: false, start: { first: false, upgradedFrom: '1.0.0' }, config: { value: { currency: 'EUR' }, version: 1 } });
    expect((await waiting).instance).toBe('i-2');
    expect((await rig.store.table('systems').get('shop'))?.status).toBe('connected');
  });

  it('asks for the manifest again when some of it was refused', async () => {
    const system = new FakeSystem(rig.app, 'shop', { ...shopManifest, fns: [...shopManifest.fns, { ...declOf(shopManifest, 'get'), name: 'bad', args: wireType(g.text()), returns: { name: 'nothing-here' } }] });
    await pairDirectly(rig, system);
    await system.start();
    expect((await rig.store.table('systems').get('shop'))?.manifestHash).toBe('');
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
    expect((await rig.store.table('systems').get('shop'))?.manifestHash).toBe('h2');
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
    expect(await rig.admin.setEnabled(vectorsName, { functions: false }, ADMIN)).toEqual({ functions: false, renderers: true });
    expect(await rig.catalog.availability(q('vectors/ping'))).toMatchObject({ unavailable: 'disabled' });
    await rig.admin.setEnabled(vectorsName, { functions: true }, ADMIN);

    expect(await rig.admin.remove(vectorsName, ADMIN)).toEqual({ fnsUnavailable: 1 });
    expect(system.stops).toEqual(['removed']);
    expect((await rig.store.table('systems').get('vectors'))?.status).toBe('removed');
    expect(await rig.catalog.availability(q('vectors/ping'))).toMatchObject({ unavailable: 'system-removed' });
    // a removed name pairs again
    expect(await system.hello()).toMatchObject({ kind: 'pairing' });
    expect(await statusOf(rig.admin.setEnabled(SystemName.parse('ghost'), {}, ADMIN))).toEqual({ status: 404, code: 'NO_SYSTEM' });
    expect((await rig.admin.reimport(vectorsName)).refused).toEqual([]);
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
    expect((await system.sdk.call('resource', { uri: ResourceUri.parse('file:///work/a.md'), want: ['text'] })).text).toEqual({ inline: 'small' });
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

  it('embeds for systems and forwards their logs', async () => {
    const system = new FakeSystem(rig.app, 'vectors', await manifestFor(vectors));
    await pairDirectly(rig, system);
    await system.start();
    expect(await system.sdk.call('embed', { texts: ['a', 'b'] })).toEqual({ vectors: [[1, 0, 0], [1, 0, 0]], cost: 0 });
    await system.sdk.call('log', { level: 'warn', key: 'vectors.slow', fields: { took: 9 } });
    expect(rig.records.find((r) => r.msg === 'vectors.slow')).toMatchObject({ level: 'warn', system: 'vectors', took: 9 });
  });
});

describe('connections', () => {
  it('lets a newer connection of a system replace the older one', async () => {
    const first = new FakeSystem(rig.app, 'vectors', await manifestFor(vectors));
    await pairDirectly(rig, first);
    await first.start();
    const second = new FakeSystem(rig.app, 'vectors', await manifestFor(vectors), first.keys);
    second.instance = 'i-2';
    await second.start();
    expect(rig.links.connection(SystemName.parse('vectors'))?.instance).toBe('i-2');
    expect(rig.records.some((r) => r.msg === 'link.replaced')).toBe(true);
    first.drop();
    await settle(5);
    expect(rig.links.connected().map((c) => c.instance)).toEqual(['i-2']);
    expect((await rig.store.table('systems').get('vectors'))?.status).toBe('connected');
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
