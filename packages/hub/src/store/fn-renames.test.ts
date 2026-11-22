import { afterEach, describe, expect, it } from 'vitest';
import { ActorId, PolicyId, QualifiedName, SystemName, type Policy } from '@harness/core';
import { memoryLog, testStore } from '../testing.ts';
import type { SqliteStore } from './sqlite.ts';
import { FN_NAME_MIGRATION_STEPS, FN_RENAMES, migrateFnNames } from './migrate-fn-names.ts';
import { FN_RENAME_STEPS } from './fn-renames.ts';

const ADMIN = ActorId.parse('act_admin');
const q = (name: string) => QualifiedName.parse(name);

let store: SqliteStore | undefined;
afterEach(async () => { await store?.close(); store = undefined; });

describe('the store migration\'s renames (slice B)', () => {
  it('fills the migration\'s extension points with the prefix rule\'s renames and a step per table', () => {
    expect(FN_RENAMES.get(q('hub/load_fns'))).toBe('hub/fns_load');
    expect(FN_RENAMES.get(q('hub/load_context'))).toBe('hub/ctx_load');
    expect(FN_RENAMES.get(q('hub/fns_search'))).toBeUndefined();
    for (const step of FN_RENAME_STEPS) expect(FN_NAME_MIGRATION_STEPS).toContain(step);
  });

  it('renames old fn names in sessions, policies, rows keyed by a fn and the hub\'s item switches, once', async () => {
    store = await testStore();
    const s = store;
    const policy: Policy = {
      id: PolicyId.parse('pol_1'), description: 'Always save fns.', subject: { everyone: true }, target: { fn: 'hub/save_fn' }, decision: { effect: 'allow' },
      priority: 0, createdBy: ADMIN, createdAt: 0,
    };
    const glob: Policy = { ...policy, id: PolicyId.parse('pol_2'), target: { fn: 'hub/*' } };
    await s.table('policies').put(policy);
    await s.table('policies').put(glob);
    await s.table('fnUses').put({ fn: q('hub/load_context'), uses: q('hub/fn_get') });
    await s.table('itemSwitches').put({ system: SystemName.parse('hub'), section: 'fns', name: 'context_crawl', by: ADMIN, at: 0 });
    await s.table('itemSwitches').put({ system: SystemName.parse('fs'), section: 'fns', name: 'context_crawl', by: ADMIN, at: 0 });
    const { log } = memoryLog();

    const report = await migrateFnNames(s, log);
    expect(report).toMatchObject({ 'renames.policies': 1, 'renames.fnUses': 1, 'renames.itemSwitches': 1 });
    expect((await s.table('policies').get(policy.id))?.target).toEqual({ fn: 'hub/fns_save' });
    // a glob is a pattern, not a name: left as it is
    expect((await s.table('policies').get(glob.id))?.target).toEqual({ fn: 'hub/*' });
    // keyed by the fn: moved to its new key
    expect(await s.table('fnUses').get({ fn: q('hub/ctx_load'), uses: q('hub/fns_get') })).toEqual({ fn: 'hub/ctx_load', uses: 'hub/fns_get' });
    expect(await s.table('fnUses').get({ fn: q('hub/load_context'), uses: q('hub/fn_get') })).toBeUndefined();
    // only the hub's switch holds a hub fn's local name
    expect(await s.table('itemSwitches').get({ system: SystemName.parse('hub'), section: 'fns', name: 'ctx_crawl' })).toBeDefined();
    expect(await s.table('itemSwitches').get({ system: SystemName.parse('hub'), section: 'fns', name: 'context_crawl' })).toBeUndefined();
    expect(await s.table('itemSwitches').get({ system: SystemName.parse('fs'), section: 'fns', name: 'context_crawl' })).toBeDefined();

    // idempotent: a migrated store is left as it is
    const again = await migrateFnNames(s, log);
    expect(Object.values(again).every((n) => n === 0)).toBe(true);
  });
});
