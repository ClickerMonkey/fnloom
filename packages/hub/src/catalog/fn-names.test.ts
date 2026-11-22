import { modelFnName, modelFnNames, QualifiedName, SystemName, type Manifest } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from './catalog.ts';
import { StoreFnNames } from './fn-names.ts';
import { ADMIN, declOf, manifestFor, shop } from './fixtures.ts';
import { RecordingBus, memoryLog, testStore } from '../testing.ts';
import type { HubStore, Table } from '../store/index.ts';
import { allRows } from '../store/rows.ts';

const q = (name: string) => QualifiedName.parse(name);

async function setup() {
  const store = await testStore();
  const { log } = memoryLog();
  let now = 1_000;
  const catalog = new StoreCatalog({ store, bus: new RecordingBus(), log, clock: () => now, describer: { describe: () => Promise.resolve({ problems: [] }) } });
  return { store, log, catalog, tick: (to: number) => { now = to; } };
}

/** A store whose `modelFnNames` and history tables count the page reads they are asked for, to see lookups are batched. */
function counting(store: HubStore): { store: HubStore; pages: () => number } {
  let pages = 0;
  const watched = new Set<string>(['modelFnNames', 'modelFnNameHistory']);
  const wrapped = new Proxy(store, {
    get(target, key, receiver): unknown {
      if (key !== 'table') return Reflect.get(target, key, receiver);
      return (name: Parameters<HubStore['table']>[0]) => {
        const table = target.table(name);
        if (!watched.has(name)) return table;
        return new Proxy(table, {
          get(inner: Table<unknown, unknown>, member, innerReceiver): unknown {
            const value: unknown = Reflect.get(inner, member, innerReceiver);
            if (member !== 'find' || typeof value !== 'function') return value;
            return (...args: unknown[]): unknown => { pages += 1; return Reflect.apply(value, inner, args); };
          },
        });
      };
    },
  });
  return { store: wrapped, pages: () => pages };
}

describe('the fn name registry, in the store', () => {
  it('holds every fn the catalog imports, methods included, as rows, and reads their model names back in a batch', async () => {
    const { catalog, store } = await setup();
    await catalog.importManifest(await manifestFor(shop));
    expect(await store.table('modelFnNames').get(modelFnName(q('shop/get')))).toEqual({ model: 'shop__get', fn: 'shop/get', system: 'shop' });
    const { index } = await catalog.modelNames();
    const read = await index.fnsOf(['shop__get', 'shop__Product__discount', 'shop__nope', 'not a name']);
    expect(Object.fromEntries(read)).toEqual({ shop__get: 'shop/get', shop__Product__discount: 'shop/Product.discount' });
    expect([...await index.fnsAmong([q('shop/get'), q('shop/guide'), q('shop/Product.discount')])].sort()).toEqual(['shop/Product.discount', 'shop/get']);
  });

  it('moves a fn that goes to the history table in the same transaction, so an old call still reads back', async () => {
    const { catalog, store, tick } = await setup();
    const manifest = await manifestFor(shop);
    await catalog.importManifest(manifest);
    tick(2_000);
    const without: Manifest = { ...manifest, fns: manifest.fns.filter((decl) => decl.name !== 'get') };
    await catalog.importManifest(without);
    expect(await store.table('modelFnNames').get(modelFnName(q('shop/get')))).toBeUndefined();
    expect(await store.table('modelFnNameHistory').get(modelFnName(q('shop/get')))).toEqual({ model: 'shop__get', fn: 'shop/get', until: 2_000 });
    // a fresh registry over the same store: the gone fn is no fn now, and its name still reads back
    const again = new StoreFnNames(store);
    expect((await again.fnsAmong([q('shop/get')])).size).toBe(0);
    expect((await again.fnsOf(['shop__get'])).get('shop__get')).toBe('shop/get');
  });

  it('answers a prompt\'s names with one query per table, however many it asks about', async () => {
    const { catalog, store } = await setup();
    await catalog.importManifest(await manifestFor(shop));
    const watched = counting(store);
    const registry = new StoreFnNames(watched.store);
    const names = modelFnNames({ index: registry, mode: { type: 'tools' } });
    const texts = Array.from({ length: 50 }, (_, i) => `Use shop/get or shop/Product.discount, not shop/missing_${i}.`);
    await names.learn(texts);
    // one query of the names table: the bare names, all at once (no cut names here, so the history isn't asked)
    expect(watched.pages()).toBe(1);
    expect(names.text(texts[0] ?? '')).toBe('Use shop__get or shop__Product__discount, not shop/missing_0.');
    // what it learned is kept: learning the same texts again asks nothing
    await names.learn(texts);
    expect(watched.pages()).toBe(1);
  });

  it('reads a cut name back through the table, and a gone one through the history', async () => {
    const { store } = await setup();
    const registry = new StoreFnNames(store);
    const long = q(`shop/${'a'.repeat(80)}`);
    const gone = q(`shop/${'b'.repeat(80)}`);
    await store.table('modelFnNames').put({ model: modelFnName(long), fn: long, system: SystemName.parse('shop') });
    await store.table('modelFnNameHistory').put({ model: modelFnName(gone), fn: gone, until: 5 });
    const names = modelFnNames({ index: registry, mode: { type: 'tools' } });
    await names.learn([`call ${modelFnName(long)} or ${modelFnName(gone)}`]);
    expect(names.fn(modelFnName(long))).toBe(long);
    expect(names.fn(modelFnName(gone))).toBe(gone);
  });

  it('writes the names of fns stored before the table, once', async () => {
    const { catalog, store } = await setup();
    await catalog.importManifest(await manifestFor(shop));
    for (const row of await allRows(store.table('modelFnNames'))) await store.table('modelFnNames').remove(row.model);
    const registry = new StoreFnNames(store);
    expect(await registry.backfill()).toBeGreaterThan(0);
    expect((await registry.fnsOf(['shop__get'])).get('shop__get')).toBe('shop/get');
    expect(await registry.backfill()).toBe(0);
  });

  it('refuses a fn whose local name its model name can\'t carry, and keeps the rest of the manifest', async () => {
    const { catalog } = await setup();
    const manifest = await manifestFor(shop);
    const get = declOf(manifest, 'get');
    const report = await catalog.importManifest({ ...manifest, fns: [...manifest.fns, { ...get, name: 'get__all' }, { ...get, name: 'x._y' }] });
    expect(report.refused).toEqual([
      { name: 'shop/get__all', problems: [expect.stringContaining('`__`')] },
      { name: 'shop/x._y', problems: [expect.stringContaining('starts or ends with `_`')] },
    ]);
    expect(await catalog.fn(q('shop/get'))).toBeDefined();
  });

  it('refuses a second fn whose model name is taken (a cut name\'s hash is the only way), stored or in the same import', async () => {
    const { store } = await setup();
    const names = new StoreFnNames(store);
    const long = q(`shop/${'a'.repeat(80)}`);
    const claimed = new Map<string, QualifiedName>([[modelFnName(long), q('shop/other')]]);
    expect(await names.problem(long, claimed)).toContain('which is shop/other\'s name');
    // the same fn claiming its own name again is fine
    const mine = new Map<string, QualifiedName>();
    expect(await names.problem(long, mine)).toBeUndefined();
    expect(await names.problem(long, mine)).toBeUndefined();
    // a stored holder is found by key
    await store.table('modelFnNames').put({ model: modelFnName(long), fn: q('shop/holder'), system: SystemName.parse('shop') });
    expect(await names.problem(long)).toContain('which is shop/holder\'s name');
  });

  it('refuses a saved fn with a bad name too', async () => {
    const { catalog } = await setup();
    const manifest = await manifestFor(shop);
    await catalog.importManifest(manifest);
    const get = declOf(manifest, 'get');
    const report = await catalog.declare(manifest.name, { ...get, name: 'main.__x' }, ADMIN);
    expect(report.refused[0]?.problems[0]).toContain('`__`');
  });
});
