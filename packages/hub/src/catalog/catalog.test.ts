import { ConnectKey, ContextDecl, GinTypeDef, QualifiedName, SystemName, type FnDecl, type KindDescription, type Manifest } from '@harness/core';
import { embedder, g, system, wireType } from '@harness/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestHashOf, StoreCatalog } from './catalog.ts';
import { ADMIN, declOf, manifestFor, orders, shop, systemRow } from './fixtures.ts';
import type { KindDescriber } from './index.ts';
import { roleUnsetDetail } from './availability.ts';
import { RecordingBus, memoryLog, testStore } from '../testing.ts';

const q = (name: string) => QualifiedName.parse(name);
/** A definition gin refuses, typed as a wire definition (its outer shape passes). */
const invalid = (def: object): GinTypeDef => GinTypeDef.parse(def);
const SHOP = SystemName.parse('shop');
const ORDERS = SystemName.parse('orders');

/** A describer that works the sales report out as a no-arg fn returning a number. */
function reportDescriber(): KindDescriber & { calls: Array<{ kind: string; payload: unknown }> } {
  const calls: Array<{ kind: string; payload: unknown }> = [];
  return {
    calls,
    describe(kind, payload) {
      calls.push({ kind, payload });
      const description: KindDescription = {
        args: wireType(g.obj({})), returns: wireType(g.num()), deps: [q('shop/list')],
        operations: { cancel: true, pause: false, undo: false, background: true }, examples: [{ args: {}, note: 'This week.' }],
      };
      return Promise.resolve({ problems: [], description });
    },
  };
}

async function setup(describer: KindDescriber = reportDescriber()) {
  const store = await testStore();
  const bus = new RecordingBus();
  const { log, records } = memoryLog();
  const catalog = new StoreCatalog({ store, bus, log, clock: () => 1_000, describer });
  return { store, bus, log, records, catalog, describer };
}

describe('importing a manifest', () => {
  let shopManifest: Manifest;
  beforeEach(async () => { shopManifest = await manifestFor(shop); });

  it('adds every entry, stores the records and the manifest, and announces it', async () => {
    const { catalog, store, bus } = await setup();
    const report = await catalog.importManifest(shopManifest);
    expect(report.refused).toEqual([]);
    expect(report.added).toEqual(expect.arrayContaining(['shop/Product', 'shop/report', 'shop/get', 'shop/list', 'shop/Product.discount', 'shop/guide', 'shop/products', 'shop/csv']));
    expect(await catalog.type(q('shop/Product'))).toMatchObject({ system: 'shop', display: { label: 'Product' } });
    expect(await catalog.kind(q('shop/report'))).toMatchObject({ system: 'shop' });
    expect((await catalog.fn(q('shop/get')))?.origin).toBe('contract');
    expect(await catalog.manifest(SHOP)).toEqual(shopManifest);
    expect((await store.table('manifests').get(SystemName.parse('shop')))?.importedAt).toBe(1_000);
    expect(bus.of('catalog.changed').at(-1)?.added).toContain('shop/get');
    expect((await catalog.entries('mentions')).map((e) => e.name)).toEqual(['shop/products']);
    expect((await catalog.entries('sectioners', { system: SHOP })).map((e) => e.decl.match)).toEqual([{ format: 'csv' }]);
  });

  it('finds the fns and context a context mentions in its text', async () => {
    const { catalog } = await setup();
    await catalog.importManifest(shopManifest);
    expect((await catalog.context(q('shop/guide')))?.mentions).toEqual({ fns: ['shop/get'], context: ['shop/guide'] });
  });

  it('writes a context item\'s graph edges and sizes with it, and removes the edges with it', async () => {
    const { catalog, store } = await setup();
    await catalog.importManifest(shopManifest);
    const edges = await store.table('contextLinks').find({ where: { from: q('shop/guide') }, limit: 10 });
    expect(edges.items.map((e) => [e.relation, e.toKey, e.source])).toEqual([['mentions', 'fn:shop/get', 'mentioned']]);
    expect((await catalog.context(q('shop/guide')))?.tokens?.full).toBeGreaterThan(0);
    await catalog.importManifest({ ...shopManifest, context: [] });
    expect((await store.table('contextLinks').find({ where: { from: q('shop/guide') }, limit: 10 })).items).toEqual([]);
  });

  it('changes nothing when the same manifest comes again', async () => {
    const { catalog } = await setup();
    await catalog.importManifest(shopManifest);
    expect(await catalog.importManifest(shopManifest)).toEqual({ added: [], updated: [], removed: [], refused: [] });
  });

  it('reports what was updated and removed', async () => {
    const { catalog } = await setup();
    await catalog.importManifest(shopManifest);
    const get = declOf(shopManifest, 'get');
    const next: Manifest = { ...shopManifest, fns: [{ ...get, description: 'Find a product.' }], context: [] };
    const report = await catalog.importManifest(next);
    expect(report.updated).toEqual(['shop/get']);
    expect(report.removed).toEqual(expect.arrayContaining(['shop/list', 'shop/Product.discount', 'shop/guide']));
    expect(await catalog.fn(q('shop/list'))).toBeUndefined();
    expect(await catalog.context(q('shop/guide'))).toBeUndefined();
    expect((await catalog.fn(q('shop/get')))?.decl.description).toBe('Find a product.');
  });

  it('refuses a fn whose type is not a gin type and keeps the one it had', async () => {
    const { catalog } = await setup();
    await catalog.importManifest(shopManifest);
    const get = declOf(shopManifest, 'get');
    const broken: FnDecl = { ...get, description: 'changed', args: invalid({ name: 'obj', props: {}, nonsense: true }) };
    const report = await catalog.importManifest({ ...shopManifest, fns: shopManifest.fns.map((f) => (f.name === 'get' ? broken : f)) });
    expect(report.refused).toEqual([{ name: 'shop/get', problems: [expect.stringContaining('nonsense')] }]);
    expect((await catalog.fn(q('shop/get')))?.decl.description).toBe(get.description);
    expect((await catalog.manifest(SHOP))?.fns.find((f) => f.name === 'get')).toEqual(get);
  });

  it('refuses the whole manifest when its config type is invalid', async () => {
    const { catalog } = await setup();
    const report = await catalog.importManifest({ ...shopManifest, config: invalid({ name: 'obj', wrong: 1 }) });
    expect(report.refused.map((r) => r.name)).toEqual(['shop (config)']);
    expect(await catalog.manifest(SHOP)).toBeUndefined();
  });

  it('refuses a type that refers to a type nobody declared', async () => {
    const { catalog } = await setup();
    const product = shopManifest.types[0];
    if (product === undefined) { throw new Error('no type'); }
    const report = await catalog.importManifest({ ...shopManifest, types: [{ ...product, def: { name: 'list', generic: { V: { name: 'ghost/Thing' } } } }] });
    expect(report.refused).toEqual([{ name: 'shop/Product', problems: ['refers to the unknown type ghost/Thing'] }]);
  });
});

describe('changes other systems depend on', () => {
  async function both() {
    const ctx = await setup();
    const shopManifest = await manifestFor(shop);
    await ctx.catalog.importManifest(shopManifest);
    await ctx.catalog.importManifest(await manifestFor(orders));
    return { ...ctx, shopManifest };
  }

  it('refuses a type change that narrows what other systems pass', async () => {
    const { catalog, shopManifest } = await both();
    const [product] = shopManifest.types;
    if (product === undefined) { throw new Error('no type'); }
    const narrowed = { ...product, def: wireType(g.obj({ sku: g.text(), price: g.num(), stock: g.num() })) };
    const report = await catalog.importManifest({ ...shopManifest, types: [narrowed] });
    expect(report.refused[0]?.name).toBe('shop/Product');
    const widened = { ...product, def: wireType(g.obj({ sku: g.text(), price: g.num(), stock: g.optional(g.num()) })) };
    expect((await catalog.importManifest({ ...shopManifest, types: [widened] })).updated).toContain('shop/Product');
  });

  it('refuses a fn change that breaks the fns depending on it', async () => {
    const { catalog, shopManifest } = await both();
    const get = declOf(shopManifest, 'get');
    const stricter = { ...get, args: wireType(g.obj({ sku: g.text(), shelf: g.num() })) };
    const report = await catalog.importManifest({ ...shopManifest, fns: shopManifest.fns.map((f) => (f.name === 'get' ? stricter : f)) });
    expect(report.refused).toEqual([{ name: 'shop/get', problems: ['its args no longer accept what orders/place pass'] }]);
    const looser = { ...get, returns: wireType(g.text({ minLength: 1 })) };
    expect((await catalog.importManifest({ ...shopManifest, fns: shopManifest.fns.map((f) => (f.name === 'get' ? looser : f)) })).updated).toEqual(['shop/get']);
  });

  it('parses a fn that names another system’s type', async () => {
    const { catalog } = await both();
    const signature = await catalog.signature(q('orders/place'));
    expect(signature.argsSchema.safeParse({ product: { sku: 'a', price: 1 }, count: 2 }).success).toBe(true);
    expect(signature.argsSchema.safeParse({ product: { sku: 'a', price: -1 }, count: 2, extra: 1 }).success).toBe(false);
  });
});

describe('fns of a kind', () => {
  it('asks the kind to describe the payload and stores what it works out', async () => {
    const { catalog, describer } = await setup();
    await catalog.importManifest(await manifestFor(shop));
    await catalog.importManifest(await manifestFor(orders));
    const sales = await catalog.fn(q('orders/sales'));
    expect(sales?.decl.deps).toEqual(['shop/list']);
    expect(sales?.decl.returns).toEqual(wireType(g.num()));
    expect(describer).toMatchObject({ calls: [{ kind: 'shop/report', payload: { query: 'week' } }] });
  });

  it('keeps the connection key its kind names for the payload (an api fn\'s service)', async () => {
    const inner = reportDescriber();
    const keyed: KindDescriber = {
      describe: async (kind, payload) => {
        const answer = await inner.describe(kind, payload);
        return answer.description === undefined ? answer : { ...answer, description: { ...answer.description, connectKey: ConnectKey.parse('tracker') } };
      },
    };
    const { catalog } = await setup(keyed);
    await catalog.importManifest(await manifestFor(shop));
    await catalog.importManifest(await manifestFor(orders));
    expect((await catalog.fn(q('orders/sales')))?.decl.connectKey).toBe('tracker');
  });

  it('gives a fn declared without examples its kind\'s, and keeps an author\'s own', async () => {
    const { catalog } = await setup();
    await catalog.importManifest(await manifestFor(shop));
    const manifest = await manifestFor(orders);
    await catalog.importManifest(manifest);
    expect((await catalog.fn(q('orders/sales')))?.decl.examples).toEqual([{ args: {}, note: 'This week.' }]);
    const own = [{ args: {}, note: 'The sales so far.' }];
    await catalog.importManifest({ ...manifest, hash: 'own-examples', fns: manifest.fns.map((decl) => (decl.name === 'sales' ? { ...decl, examples: own } : decl)) });
    expect((await catalog.fn(q('orders/sales')))?.decl.examples).toEqual(own);
  });

  it('refuses a payload the kind’s payload type does not accept', async () => {
    const { catalog } = await setup();
    await catalog.importManifest(await manifestFor(shop));
    const manifest = await manifestFor(orders);
    const sales = declOf(manifest, 'sales');
    const report = await catalog.importManifest({ ...manifest, fns: [{ ...sales, payload: { query: 4 } }] });
    expect(report.refused[0]?.problems[0]).toMatch(/^payload: /);
  });

  it('refuses what the kind refuses, and a description that does not fit the declared result', async () => {
    const refusing: KindDescriber = { describe: () => Promise.resolve({ problems: ['no such table'] }) };
    const a = await setup(refusing);
    await a.catalog.importManifest(await manifestFor(shop));
    expect((await a.catalog.importManifest(await manifestFor(orders))).refused).toEqual([{ name: 'orders/sales', problems: ['no such table'] }]);

    const manifest = await manifestFor(orders);
    const sales = declOf(manifest, 'sales');
    const b = await setup();
    await b.catalog.importManifest(await manifestFor(shop));
    const report = await b.catalog.importManifest({ ...manifest, fns: [{ ...sales, returns: wireType(g.text()) }] });
    expect(report.refused[0]?.problems).toEqual(['the result its kind works out does not fit the declared result']);
  });

  it('keeps a fn as declared while its kind’s system is away, and describes it when that system connects', async () => {
    let reachable = false;
    const inner = reportDescriber();
    const flaky: KindDescriber = { describe: (k, p) => (reachable ? inner.describe(k, p) : Promise.reject(new Error('shop is not connected'))) };
    const { catalog, store } = await setup(flaky);
    await catalog.importManifest(await manifestFor(shop));
    expect((await catalog.importManifest(await manifestFor(orders))).refused).toEqual([]);
    expect((await catalog.fn(q('orders/sales')))?.decl.deps).toEqual([]);
    reachable = true;
    await store.table('systems').put(systemRow('shop', 'connected'));
    await catalog.refreshAvailability(SHOP);
    expect((await catalog.fn(q('orders/sales')))?.decl.deps).toEqual(['shop/list']);
  });
});

describe('when a type changes', () => {
  it('describes again the kind fns whose payload references it, and rebuilds signatures that use it', async () => {
    const describer = reportDescriber();
    const typed: KindDescriber = {
      async describe(kind, payload) {
        const answer = await describer.describe(kind, payload);
        return answer.description === undefined ? answer : { ...answer, description: { ...answer.description, types: [q('shop/Product')] } };
      },
    };
    const { catalog } = await setup(typed);
    const shopManifest = await manifestFor(shop);
    await catalog.importManifest(shopManifest);
    await catalog.importManifest(await manifestFor(orders));
    expect(describer.calls).toHaveLength(1);
    const byName = { ...declOf(await manifestFor(orders), 'place'), name: 'check', args: GinTypeDef.parse({ name: 'shop/Product' }) };
    expect((await catalog.declare(ORDERS, byName, ADMIN)).added).toEqual(['orders/check']);
    const before = await catalog.signature(q('orders/check'));

    const [product] = shopManifest.types;
    if (product === undefined) { throw new Error('no type'); }
    const widened = { ...product, def: wireType(g.obj({ sku: g.text(), price: g.num({ min: 0 }), stock: g.optional(g.num()) })) };
    expect((await catalog.importManifest({ ...shopManifest, types: [widened] })).updated).toContain('shop/Product');
    expect(describer.calls).toHaveLength(2);
    const after = await catalog.signature(q('orders/check'));
    expect(after).not.toBe(before);
    expect(after.argsSchema.safeParse({ sku: 'a', price: 1, stock: 2 }).success).toBe(true);
    expect(before.argsSchema.safeParse({ sku: 'a', price: 1, stock: 2 }).success).toBe(false);
  });
});

describe('availability', () => {
  async function imported() {
    const ctx = await setup();
    await ctx.catalog.importManifest(await manifestFor(shop));
    await ctx.catalog.importManifest(await manifestFor(orders));
    return ctx;
  }

  it('says why a fn of a system that never connected is unavailable', async () => {
    const { catalog } = await imported();
    expect(await catalog.availability(q('shop/get'))).toEqual({ unavailable: 'system-disconnected', detail: 'shop has never connected' });
    expect(await catalog.availability(q('shop/guide'))).toMatchObject({ unavailable: 'system-disconnected' });
  });

  it('counts context the hub made itself (a memory, named memory/…) as always available', async () => {
    const { catalog, store } = await imported();
    const name = q('memory/gollum-1a2b');
    await store.table('context').put({
      name, system: SystemName.parse('hub'), origin: { type: 'memory', scope: { to: 'everyone' }, author: ADMIN }, stale: false, updatedAt: 0,
      decl: ContextDecl.parse({ name: 'gollum-1a2b', description: 'Gollum', command: { name: 'gollum', args: [] }, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: [], content: 'precious' }),
      mentions: { context: [], fns: [] }, tokens: { full: 2, summary: 1 },
    });
    expect(await catalog.availability(name)).toBe(true);
  });

  it('follows the system, its config, its switches, kinds and deps', async () => {
    const { catalog, store, bus } = await imported();
    const systems = store.table('systems');
    await systems.put(systemRow('shop', 'connected'));
    await systems.put(systemRow('orders', 'connected'));
    await catalog.refreshAvailability(SHOP);
    expect(await catalog.availability(q('shop/get'))).toBe(true);
    expect(await catalog.availability(q('orders/place'))).toBe(true);
    expect(await catalog.availability(q('orders/sales'))).toBe(true);
    expect(bus.of('capabilities.changed').length).toBeGreaterThan(0);

    await systems.update(SystemName.parse('shop'), { status: 'needs-config' });
    await catalog.refreshAvailability(SHOP);
    expect(await catalog.availability(q('shop/get'))).toMatchObject({ unavailable: 'system-needs-config' });
    expect(await catalog.availability(q('orders/place'))).toMatchObject({ unavailable: 'dep-unavailable' });
    expect(await catalog.availability(q('orders/sales'))).toMatchObject({ unavailable: 'kind-system-disconnected' });

    await systems.update(SystemName.parse('shop'), { status: 'connected', enabled: { functions: false, renderers: true } });
    await catalog.refreshAvailability(SHOP);
    expect(await catalog.availability(q('shop/get'))).toMatchObject({ unavailable: 'disabled' });

    await systems.update(SystemName.parse('shop'), { enabled: { functions: true, renderers: true } });
    await store.table('fns').update('shop/get', { paused: true });
    await catalog.refreshAvailability(SHOP);
    expect(await catalog.availability(q('shop/get'))).toMatchObject({ unavailable: 'paused' });

    await systems.update(SystemName.parse('shop'), { status: 'removed' });
    await catalog.refreshAvailability(SHOP);
    expect(await catalog.availability(q('shop/list'))).toMatchObject({ unavailable: 'system-removed' });
    expect(await catalog.fns({ system: ORDERS, available: true })).toEqual([]);
  });

  it('marks a fn whose kind is gone', async () => {
    const { catalog, store } = await imported();
    await store.table('systems').put(systemRow('shop', 'connected'));
    await store.table('systems').put(systemRow('orders', 'connected'));
    const shopManifest = await manifestFor(shop);
    await catalog.importManifest({ ...shopManifest, kinds: [] });
    expect(await catalog.availability(q('orders/sales'))).toMatchObject({ unavailable: 'kind-missing' });
  });

  it('treats the hub as always connected', async () => {
    const { catalog } = await setup();
    expect(await catalog.availability(q('hub/search_fns'))).toBe(true);
  });

  it('keeps a fn that needs a model role off while the role has no model, and follows the role as it is set and cleared (plan item 7)', async () => {
    let decideSet = false;
    const store = await testStore();
    const bus = new RecordingBus();
    const { log } = memoryLog();
    const catalog = new StoreCatalog({ store, bus, log, clock: () => 1_000, describer: reportDescriber(), roleSet: (role) => Promise.resolve(role === 'decide' && decideSet) });
    await store.table('systems').put(systemRow('shop', 'connected'));
    const base = await manifestFor(shop);
    const get = base.fns.find((decl) => decl.name === 'get');
    if (get === undefined) throw new Error('shop has no get');
    const body = { ...base, fns: [...base.fns, { ...get, name: 'crawl', roles: ['decide' as const] }] };
    expect((await catalog.importManifest({ ...body, hash: await manifestHashOf(body) })).refused).toEqual([]);
    const off = { unavailable: 'role-unset', detail: roleUnsetDetail(q('shop/crawl'), 'decide') };
    expect(await catalog.availability(q('shop/crawl'))).toEqual(off);
    expect(off.detail).toBe('shop/crawl needs a model for the decide role, and none is set: an admin sets it under Models, Roles');
    // a fn that needs no role is untouched
    expect(await catalog.availability(q('shop/get'))).toBe(true);

    decideSet = true;
    await catalog.refreshRoles(['decide']);
    expect(await catalog.availability(q('shop/crawl'))).toBe(true);
    expect(bus.of('catalog.changed').at(-1)?.fns.map((fn) => fn.name)).toEqual(['shop/crawl']);

    // another role changing leaves it alone; clearing decide turns it off again
    decideSet = false;
    await catalog.refreshRoles(['ocr']);
    expect(await catalog.availability(q('shop/crawl'))).toBe(true);
    await catalog.refreshRoles(['decide']);
    expect(await catalog.availability(q('shop/crawl'))).toEqual(off);
  });
});

describe('patches, runtime fns and re-imports', () => {
  it('applies a patch over the stored manifest', async () => {
    const { catalog } = await setup();
    const manifest = await manifestFor(shop);
    await catalog.importManifest(manifest);
    const get = declOf(manifest, 'get');
    const report = await catalog.importPatch(SHOP, { hash: 'h2', upsert: { fns: [{ ...get, name: 'find' }] }, remove: { fns: ['list'] } });
    expect(report.added).toEqual(['shop/find']);
    expect(report.removed).toEqual(['shop/list']);
    const stored = await catalog.manifest(SHOP);
    // the hub hashes what it stores, never keeping the hash the system sent
    expect(stored?.hash).toBe(stored === undefined ? undefined : await manifestHashOf(stored));
    expect(stored?.hash).not.toBe('h2');
  });

  it('keeps the fns a patch adds as the running system’s own, replaces the top-level lists whole, and versions replaced types with their meta (build 6)', async () => {
    const { catalog, store } = await setup();
    const manifest = await manifestFor(shop);
    await catalog.importManifest(manifest);
    const get = declOf(manifest, 'get');
    const product = manifest.types.find((t) => t.name === 'Product');
    if (product === undefined) throw new Error('no Product');
    await catalog.importPatch(SHOP, {
      hash: 'h2', upsert: { fns: [{ ...get, name: 'find' }], types: [{ ...product, description: 'A product.', meta: { schemaHash: 'abc' } }] }, remove: {},
      lists: { providers: [], registries: [], contributes: [] },
    });
    expect((await catalog.fn(QualifiedName.parse('shop/find')))?.origin).toBe('runtime');
    expect((await catalog.fn(QualifiedName.parse('shop/get')))?.origin).toBe('contract');
    expect((await catalog.type(QualifiedName.parse('shop/Product')))?.meta).toEqual({ schemaHash: 'abc' });
    // every item has its history: the first import's versions, then each change, numbered per item
    const version = async (section: string, name: string, number: number) => store.table('itemVersions').get(`shop:${section}:${name}#${String(number)}`);
    expect(await version('types', 'shop/Product', 1)).toMatchObject({ change: 'added', declaredBy: 'contract', decl: { description: product.description } });
    expect(await version('types', 'shop/Product', 2)).toMatchObject({ change: 'changed', decl: { description: 'A product.', meta: { schemaHash: 'abc' } } });
    expect(await version('fns', 'shop/find', 1)).toMatchObject({ change: 'added', declaredBy: 'runtime' });
    expect(await version('fns', 'shop/get', 2)).toBeUndefined();
    // a later patch that doesn't touch it leaves the runtime fn the running system's
    await catalog.importPatch(SHOP, { hash: 'h3', upsert: { types: [{ ...product, meta: { schemaHash: 'def' } }] }, remove: {} });
    expect((await catalog.fn(QualifiedName.parse('shop/find')))?.origin).toBe('runtime');
    expect((await version('types', 'shop/Product', 3))?.decl).toMatchObject({ meta: { schemaHash: 'def' } });
    expect(await version('fns', 'shop/find', 2)).toBeUndefined();
    expect((await catalog.manifest(SHOP))?.providers).toEqual([]);
  });

  it('refuses a patch before any manifest', async () => {
    const { catalog } = await setup();
    expect((await catalog.importPatch(SHOP, { hash: 'h', upsert: {}, remove: {} })).refused[0]?.problems).toEqual(['no manifest to patch: send the whole manifest first']);
  });

  it('keeps what the running system added runtime through whole manifests and re-imports, and a context item\'s switches through a change (build 6)', async () => {
    const { catalog, store } = await setup();
    const manifest = await manifestFor(shop);
    await catalog.importManifest(manifest);
    const get = declOf(manifest, 'get');
    const guide = manifest.context.find((c) => c.name === 'guide');
    if (guide === undefined) throw new Error('no guide');
    // switched off by a person, by itself and with its system's context
    await store.table('context').update(q('shop/guide'), { disabled: true, systemOff: true });
    // the system sends its whole manifest with a fn it added while running (`Manifest.runtime`) and a changed guide
    const whole: Manifest = { ...manifest, hash: 'h2', fns: [...manifest.fns, { ...get, name: 'find' }], context: [{ ...guide, description: 'How the shop works now.' }], runtime: { fns: ['find'] } };
    expect((await catalog.importManifest(whole)).refused).toEqual([]);
    expect(await catalog.fn(q('shop/find'))).toMatchObject({ origin: 'runtime' });
    expect(await catalog.fn(q('shop/get'))).toMatchObject({ origin: 'contract' });
    expect(await catalog.context(q('shop/guide'))).toMatchObject({ decl: { description: 'How the shop works now.' }, disabled: true, systemOff: true, declaredBy: 'contract' });
    // a re-import and a patch that leaves it alone keep it the running system's, so it can still be declared over
    await catalog.reimport(SHOP);
    await catalog.importPatch(SHOP, { hash: 'h3', upsert: { fns: [{ ...get, description: 'Get one.' }] }, remove: {} });
    expect(await catalog.fn(q('shop/find'))).toMatchObject({ origin: 'runtime' });
    expect((await catalog.manifest(SHOP))?.runtime).toEqual({ fns: ['find', 'get'] });
    expect((await catalog.declare(SHOP, { ...get, name: 'find', description: 'Find one.' }, ADMIN)).refused).toEqual([]);
  });

  it('declares a fn at runtime, and refuses one that clashes with the contract', async () => {
    const { catalog } = await setup();
    const manifest = await manifestFor(shop);
    await catalog.importManifest(manifest);
    const get = declOf(manifest, 'get');
    expect(await catalog.declare(SHOP, { ...get, name: 'extra' }, ADMIN)).toMatchObject({ added: ['shop/extra'] });
    expect(await catalog.fn(q('shop/extra'))).toMatchObject({ origin: 'runtime', addedBy: ADMIN });
    expect((await catalog.declare(SHOP, get, ADMIN)).refused[0]?.problems).toEqual(['a fn of the contract has this name']);
    // an instance's fn (a local name with a dot) is listed in its system's fns by its whole name, where the fn modal finds it
    expect(await catalog.declare(SHOP, { ...get, name: 'main.sample' }, ADMIN)).toMatchObject({ added: ['shop/main.sample'] });
    expect((await catalog.fns({ system: SHOP })).map((f) => f.name)).toContain('shop/main.sample');
    // a whole manifest leaves runtime fns alone
    await catalog.importManifest(manifest);
    expect(await catalog.fn(q('shop/extra'))).toBeDefined();
  });

  it('re-imports the stored manifest, describing kinds afresh', async () => {
    const describer = reportDescriber();
    const { catalog } = await setup(describer);
    await catalog.importManifest(await manifestFor(shop));
    await catalog.importManifest(await manifestFor(orders));
    const report = await catalog.reimport(ORDERS);
    expect(report.refused).toEqual([]);
    expect(describer.calls).toHaveLength(2);
    expect((await catalog.reimport(SystemName.parse('nobody'))).refused[0]?.problems).toEqual(['no manifest has been imported']);
  });
});

describe('types and values', () => {
  it('works out the closure of named types, with the missing ones', async () => {
    const { catalog } = await setup();
    await catalog.importManifest(await manifestFor(shop));
    expect(await catalog.typeClosure([q('shop/Product'), q('ghost/Thing')])).toEqual({ order: ['shop/Product'], missing: ['ghost/Thing'] });
  });

  it('checks values against a type, refusing unknown keys and broken constraints', async () => {
    const { catalog } = await setup();
    const manifest = await manifestFor(shop);
    await catalog.importManifest(manifest);
    expect(await catalog.check(SHOP, manifest.config, { currency: 'EUR' })).toEqual([]);
    expect(await catalog.check(SHOP, manifest.config, { currency: 'EURO' })).not.toEqual([]);
    expect((await catalog.check(SHOP, manifest.config, { currency: 'EUR', typo: 1 }))[0]).toMatch(/typo/);
    expect(await catalog.check(SHOP, invalid({ name: 'obj', bad: 1 }), {})).toEqual([expect.stringMatching(/^the type is invalid/)]);
  });

  it('builds a signature once per fn version', async () => {
    const { catalog } = await setup();
    await catalog.importManifest(await manifestFor(shop));
    const first = await catalog.signature(q('shop/get'));
    expect(first.argsJsonSchema).toMatchObject({ type: 'object', required: ['sku'] });
    expect(await catalog.signature(q('shop/get'))).toBe(first);
    await expect(catalog.signature(q('shop/none'))).rejects.toThrow('no fn shop/none');
  });

  it('lists fns by name and availability', async () => {
    const { catalog } = await setup();
    // a manifest's embedders section is still catalogued (the index now takes embedders from providers' embedding models)
    const vectors = system('vectors', { description: 'Embeddings.' }).with({
      embedders: { document: embedder({ dimensions: 3, maxInput: 100, pricePerMillionTokens: 0 }), query: embedder({ dimensions: 3, maxInput: 100, pricePerMillionTokens: 0 }) },
    });
    await catalog.importManifest(await manifestFor(shop));
    await catalog.importManifest(await manifestFor(vectors));
    expect((await catalog.fns({ names: [q('shop/get'), q('shop/none')] })).map((f) => f.name)).toEqual(['shop/get']);
    expect((await catalog.fns({ system: SHOP })).length).toBe(3);
    expect((await catalog.entries('embedders')).map((e) => e.name)).toEqual(['vectors/document', 'vectors/query']);
  });

  it('imports one system at a time', async () => {
    const { catalog } = await setup();
    const manifest = await manifestFor(shop);
    const spy = vi.spyOn(catalog, 'manifest');
    const reports = await Promise.all([catalog.importManifest(manifest), catalog.importManifest(manifest)]);
    expect(reports[1]).toEqual({ added: [], updated: [], removed: [], refused: [] });
    spy.mockRestore();
  });
});
