import { QualifiedName, SystemName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { memoryLog, testStore } from '../testing.ts';
import { ADMIN, declOf, manifestFor, shop } from './fixtures.ts';
import { itemChanges, itemVersionsPage, migrateOldVersions, writeItemVersions } from './versions.ts';

describe('item versions', () => {
  it('numbers each item\'s versions from 1 and pages them newest first', async () => {
    const store = await testStore();
    const manifest = await manifestFor(shop);
    const first = itemChanges(undefined, manifest);
    expect(first.every((c) => c.change === 'added')).toBe(true);
    expect(first.map((c) => c.section)).toEqual(expect.arrayContaining(['types', 'fns']));
    await writeItemVersions(store, manifest.name, first, 1);
    const get = declOf(manifest, 'get');
    const next = { ...manifest, fns: manifest.fns.map((f) => (f.name === 'get' ? { ...get, description: 'Get one product.' } : f)) };
    const changes = itemChanges(manifest, next);
    expect(changes).toEqual([expect.objectContaining({ section: 'fns', name: 'shop/get', change: 'changed' })]);
    await writeItemVersions(store, manifest.name, changes, 2, ADMIN);
    const page = await itemVersionsPage(store, { system: manifest.name, section: 'fns', name: 'shop/get', limit: 1 });
    expect(page.items).toMatchObject([{ number: 2, change: 'changed', savedBy: ADMIN, decl: { description: 'Get one product.' } }]);
    expect(page.cursor).toBeDefined();
    expect((await itemVersionsPage(store, { system: manifest.name, section: 'fns', name: 'shop/get', cursor: page.cursor })).items.map((v) => v.number)).toEqual([1]);
  });

  it('moves the old fn and type version rows into the one table', async () => {
    const store = await testStore();
    const manifest = await manifestFor(shop);
    const product = manifest.types[0];
    if (product === undefined) throw new Error('no type');
    await store.table('fnVersions').put({ id: 'shop/get#1', fn: QualifiedName.parse('shop/get'), number: 1, decl: declOf(manifest, 'get'), savedBy: ADMIN, savedAt: 4 });
    await store.table('typeVersions').put({ id: `shop/${product.name}#1`, type: QualifiedName.parse(`shop/${product.name}`), number: 1, decl: product, savedAt: 5 });
    expect(await migrateOldVersions(store, memoryLog().log)).toBe(2);
    expect(await store.table('fnVersions').count()).toBe(0);
    expect(await store.table('typeVersions').count()).toBe(0);
    const shopName = SystemName.parse('shop');
    expect((await itemVersionsPage(store, { system: shopName, section: 'fns', name: 'shop/get' })).items).toMatchObject([{ number: 1, savedBy: ADMIN, savedAt: 4 }]);
    expect((await itemVersionsPage(store, { system: shopName, section: 'types', name: `shop/${product.name}` })).items).toMatchObject([{ number: 1, savedAt: 5 }]);
    expect(await migrateOldVersions(store, memoryLog().log)).toBe(0);
  });
});
