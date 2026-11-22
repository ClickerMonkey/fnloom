import { modelFnName, QualifiedName, type Manifest } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from './catalog.ts';
import { StoreFnNames } from './fn-names.ts';
import { ADMIN, declOf, manifestFor, shop } from './fixtures.ts';
import { RecordingBus, memoryLog, testStore } from '../testing.ts';

const q = (name: string) => QualifiedName.parse(name);

async function setup() {
  const store = await testStore();
  const { log } = memoryLog();
  let now = 1_000;
  const catalog = new StoreCatalog({ store, bus: new RecordingBus(), log, clock: () => now, describer: { describe: () => Promise.resolve({ problems: [] }) } });
  return { store, log, catalog, tick: (to: number) => { now = to; } };
}

describe('the fn name registry', () => {
  it('holds every fn the catalog imports, methods included, and reads their model names back', async () => {
    const { catalog } = await setup();
    const manifest = await manifestFor(shop);
    await catalog.importManifest(manifest);
    const { index } = await catalog.modelNames();
    expect(index.fnOf('shop__get')).toBe('shop/get');
    expect(index.fnOf('shop__Product__discount')).toBe('shop/Product.discount');
    expect(index.isFn('shop/get')).toBe(true);
    expect(index.isFn('shop/guide')).toBe(false);
  });

  it('moves a fn that goes to the history table, so an old call still reads back, and it survives a restart', async () => {
    const { catalog, store, log, tick } = await setup();
    const manifest = await manifestFor(shop);
    await catalog.importManifest(manifest);
    await catalog.modelNames();
    tick(2_000);
    const without: Manifest = { ...manifest, fns: manifest.fns.filter((decl) => decl.name !== 'get') };
    await catalog.importManifest(without);
    const { index } = await catalog.modelNames();
    expect(index.isFn('shop/get')).toBe(false);
    expect(index.fnOf('shop__get')).toBe('shop/get');
    await expect.poll(async () => store.table('modelFnNameHistory').get(modelFnName(q('shop/get')))).toEqual({ model: 'shop__get', fn: 'shop/get', until: 2_000 });
    // a fresh registry over the same store reads the history back
    const again = await new StoreFnNames({ store, log, clock: () => 3_000 }).index();
    expect(again.fnOf('shop__get')).toBe('shop/get');
    expect(again.isFn('shop/get')).toBe(false);
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

  it('refuses a second fn whose model name is taken (a cut name\'s hash is the only way)', async () => {
    const { store, log } = await setup();
    const names = new StoreFnNames({ store, log, clock: () => 0 });
    const long = q(`shop/${'a'.repeat(80)}`);
    const claimed = new Map<string, QualifiedName>([[modelFnName(long), q('shop/other')]]);
    expect(await names.problem(long, claimed)).toContain('which is shop/other\'s name');
    // the same fn claiming its own name again is fine
    const mine = new Map<string, QualifiedName>();
    expect(await names.problem(long, mine)).toBeUndefined();
    expect(await names.problem(long, mine)).toBeUndefined();
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
