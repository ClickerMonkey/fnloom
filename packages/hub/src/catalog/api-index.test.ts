import { QualifiedName, SystemName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { memoryLog, RecordingBus, testStore } from '../testing.ts';
import { StoreCatalog } from './catalog.ts';
import { manifestFor, shop } from './fixtures.ts';
import { apiIndexDecls } from './api-index.ts';

const SHOP = SystemName.parse('shop');
const describer = { describe: () => Promise.resolve({ problems: [] }) };

describe('the API index', () => {
  it('lists the groups as choices, and each group\'s fns one line each, bringing them', async () => {
    const manifest = await manifestFor(shop);
    const fns = manifest.fns.map((fn) => (fn.name === 'list' ? { ...fn, group: 'browse' } : fn));
    const [index, ...groups] = apiIndexDecls(SHOP, fns, [{ name: 'browse', title: 'Browse', description: 'Look through the products.' }]);
    expect(index).toMatchObject({ name: 'api', choices: [{ to: 'shop/api.browse' }, { to: 'shop/api.general' }], suggest: 'none' });
    expect(index?.content).toContain('**Browse** (`shop/api.browse`): Look through the products.');
    expect(groups.map((g) => [g.name, g.fns])).toEqual([['api.browse', ['shop/list']], ['api.general', ['shop/get', 'shop/Product.discount']]]);
    expect(groups[0]?.content).toContain('- `shop/list`: List every product.');
    expect(groups[0]?.parent).toBe('shop/api');
    expect(apiIndexDecls(SHOP, fns.map((fn) => ({ ...fn, visibility: 'user' as const })), [])).toEqual([]);
  });

  it('is written with the fns it lists, and a group with no fns left goes', async () => {
    const store = await testStore();
    const catalog = new StoreCatalog({ store, bus: new RecordingBus(), log: memoryLog().log, clock: () => 1_000, describer });
    const manifest = await manifestFor(shop);
    const grouped = { ...manifest, groups: [{ name: 'browse', title: 'Browse', description: 'Look through the products.' }], fns: manifest.fns.map((fn) => (fn.name === 'list' ? { ...fn, group: 'browse' } : fn)) };
    await catalog.importManifest(grouped);
    const browse = await catalog.context(QualifiedName.parse('shop/api.browse'));
    expect(browse).toMatchObject({ system: 'shop', declaredBy: 'runtime', origin: { type: 'system' }, decl: { fns: ['shop/list'] } });
    expect((await catalog.context(QualifiedName.parse('shop/api')))?.decl.choices?.map((c) => c.to)).toEqual(['shop/api.browse', 'shop/api.general']);
    await catalog.importManifest({ ...grouped, fns: grouped.fns.filter((fn) => fn.name !== 'list') });
    expect(await catalog.context(QualifiedName.parse('shop/api.browse'))).toBeUndefined();
    expect((await catalog.context(QualifiedName.parse('shop/api')))?.decl.choices?.map((c) => c.to)).toEqual(['shop/api.general']);
  });
});
