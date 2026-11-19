/**
 * A system as the admin pages see it: its counts are counted in the database (fns, context, types, other parts with
 * their examples, instances that aren't removed, changes waiting for review, refusals), the systems list sorts and
 * filters on each, and its instance mode is what its instances said in their hello (a fleet until one says).
 */
import { ActorId, FnExampleRecord, InstanceName, MAIN_INSTANCE, mintId, QualifiedName, SystemName, type ListQuery } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../../catalog/catalog.ts';
import { instanceRow, manifestFor, shop, systemRow } from '../../catalog/fixtures.ts';
import { openScope } from '../../access/index.ts';
import { queryEnv } from '../../query/env.ts';
import { HubQuery } from '../../query/service.ts';
import { listSources } from '../../query/sources.ts';
import { memoryLog, RecordingBus, testStore } from '../../testing.ts';
import { partCount } from '../system-parts.ts';
import { systemView } from './systems.ts';

const SHOP = SystemName.parse('shop');
const OPEN_ACCESS = { scope: (actor: ActorId) => Promise.resolve(openScope(actor)) };
const ADMIN = { id: ActorId.parse('act_admin'), role: 'admin' as const };

async function world() {
  const store = await testStore();
  const catalog = new StoreCatalog({ store, bus: new RecordingBus(), log: memoryLog().log, clock: () => 1, describer: { describe: () => Promise.resolve({ problems: [] }) } });
  const manifest = await manifestFor(shop);
  await catalog.importManifest(manifest);
  await store.table('systems').put(systemRow('shop', 'connected', { instances: 'one' }));
  await store.table('systems').put(systemRow('fleet', 'connected'));
  await store.table('instances').put(instanceRow('shop', 'connected'));
  await store.table('instances').put(instanceRow('fleet', 'connected'));
  await store.table('instances').put(instanceRow('fleet', 'connected', { instance: InstanceName.parse('desk') }));
  return { store, catalog, manifest };
}

describe('systemView', () => {
  it('counts what a system has in the database, and says whether it runs one instance', async () => {
    const { store, catalog, manifest } = await world();
    const example = (fn: string, source: FnExampleRecord['source'], order: number): FnExampleRecord => FnExampleRecord.parse({
      id: mintId('fnExample'), fn: QualifiedName.parse(fn), system: SHOP, source, order, text: 'an example', args: {}, createdAt: 1,
    });
    await store.table('fnExamples').put(example('shop/get', 'decl', 0));
    await store.table('fnExamples').put(example('shop/get', 'runtime', 1));
    // a person's own example of the fn is theirs, not one of the system's parts
    await store.table('fnExamples').put(example('shop/list', 'added', 0));
    await store.table('refusals').insert({ id: mintId('refusal'), system: SHOP, instance: MAIN_INSTANCE, rule: 'effects', attempt: 'shop/get', detail: 'refused', at: 1 });
    await store.table('systemReviews').put({
      system: SHOP, updatedAt: 1,
      pending: { version: '1.1.0', hash: 'h2', by: 'contract', since: 1, changes: [{ section: 'fns', name: 'shop/get', change: 'changed', origin: 'contract' }, { section: 'fns', name: 'shop/new', change: 'added', origin: 'contract' }] },
    });
    await store.table('instances').put(instanceRow('shop', 'removed', { instance: InstanceName.parse('old') }));
    const record = await store.table('systems').get(SHOP);
    if (record === undefined) { throw new Error('no shop'); }
    const view = await systemView({ store, catalog }, record);
    const fns = await store.table('fns').count({ system: SHOP });
    expect(fns).toBeGreaterThan(0);
    // kinds, mentions and sectioners (one each), and its two own examples
    expect(await partCount({ store }, SHOP, manifest)).toBe(5);
    // its guide and the context the catalog derives from it, as its Context tab lists them
    expect(view.counts).toEqual({ fns, context: 3, types: 1, parts: 5, instances: 1, pending: 2, refusals: 1 });
    expect(view.instanceMode).toBe('one');
    expect(view).not.toHaveProperty('fns');
    const fleet = await store.table('systems').get(SystemName.parse('fleet'));
    if (fleet === undefined) { throw new Error('no fleet'); }
    expect((await systemView({ store, catalog }, fleet)).instanceMode).toBe('many');
    expect(await partCount({ store }, SystemName.parse('fleet'), undefined)).toBe(0);
  });

  it('lists systems sorted and filtered by each count', async () => {
    const { store, catalog } = await world();
    await store.table('refusals').insert({ id: mintId('refusal'), system: SystemName.parse('fleet'), instance: MAIN_INSTANCE, rule: 'mode', attempt: 'x', detail: 'refused', at: 1 });
    const lists = new HubQuery(listSources({ store, catalog, access: OPEN_ACCESS }, queryEnv.parse()));
    const names = async (query: ListQuery) => (await lists.page('systems', query, ADMIN)).items.map((s) => s.name);
    expect(await names({ filters: [{ field: 'context', op: 'gt', value: 0 }] })).toEqual(['shop']);
    expect(await names({ filters: [{ field: 'types', op: 'gte', value: 1 }] })).toEqual(['shop']);
    expect(await names({ filters: [{ field: 'parts', op: 'gt', value: 0 }] })).toEqual(['shop']);
    expect(await names({ filters: [{ field: 'refusals', op: 'gt', value: 0 }] })).toEqual(['fleet']);
    expect(await names({ filters: [{ field: 'pending', op: 'is', value: 0 }] })).toEqual(['fleet', 'shop']);
    expect(await names({ sort: [{ field: 'fns', dir: 'desc' }] })).toEqual(['shop', 'fleet']);
    expect(await names({ sort: [{ field: 'refusals', dir: 'desc' }] })).toEqual(['fleet', 'shop']);
  });
});
