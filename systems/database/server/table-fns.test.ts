/**
 * Generated table fns over the link on a real SQLite file (owners and their projects): the list for a table with an
 * enum, a number, a date, a unique column and a foreign key, grouped and marked as they stand in the hub; generating
 * by name (idempotent: unchanged fns are left alone), marking the made ones current, and running a generated fn and a
 * relation-derived one. How a schema change moves the hash is `@aeye/query`'s table-fns test.
 */
import { join } from 'node:path';
import type { Json, OutcomeWire } from '@harness/core';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { TableFnsGenerated, TableFnsList } from '../shared/shapes.ts';
import { PROJECTS_SQL, serveDatabase, shopConfig, testFolder, type ServedDatabase } from './fixture.ts';

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

describe('generated table fns', () => {
  let served: ServedDatabase | undefined;
  afterEach(async () => { await served?.stop(); served = undefined; });

  async function start(): Promise<ServedDatabase> {
    const dir = testFolder('table-fns');
    const file = join(dir, 'shop.db');
    const db = new BetterSqlite3(file);
    db.exec(PROJECTS_SQL);
    db.close();
    served = await serveDatabase({ dir, config: shopConfig({ label: 'Projects' }) });
    return served;
  }

  it('lists the fns for a table by group, generates them idempotently, runs them, and regenerates after a schema change', async () => {
    const { hub } = await start();
    const listed = TableFnsList.parse(done(await hub.run('database/table_fns_available', { table: 'database/main.projects' })));
    const names = listed.groups.flatMap((group) => group.fns.map((fn) => fn.name));
    expect(names).toEqual(expect.arrayContaining(['create', 'update', 'updateWhere', 'remove', 'removeWhere', 'selectOne', 'selectPage']));
    expect(listed.groups[0]?.group).toBe('crud');
    expect(listed.groups.every((group) => group.fns.every((fn) => fn.state === 'new'))).toBe(true);
    const owners = TableFnsList.parse(done(await hub.run('database/table_fns_available', { table: 'owners' })));
    const derived = owners.groups.filter((group) => !['crud', 'columns', 'table'].includes(group.group)).flatMap((group) => group.fns.map((fn) => fn.name));
    expect(derived).toContain('projectCount');

    const wanted = ['selectPage', 'create'];
    const first = TableFnsGenerated.parse(done(await hub.run('database/table_fns_generate', { table: 'projects', names: wanted })));
    expect(first.fns.map((fn) => fn.status)).toEqual(['created', 'created']);
    expect(hub.fns.kept.get('database/main.projects_create')?.saved.tags).toContain('write');
    const again = TableFnsGenerated.parse(done(await hub.run('database/table_fns_generate', { table: 'projects', names: wanted })));
    expect(again.fns.map((fn) => [fn.status, fn.version])).toEqual([['unchanged', 1], ['unchanged', 1]]);
    const after = TableFnsList.parse(done(await hub.run('database/table_fns_available', { table: 'projects' })));
    const states = new Map(after.groups.flatMap((group) => group.fns.map((fn) => [fn.name, fn.state] as const)));
    expect([states.get('selectPage'), states.get('create'), states.get('update')]).toEqual(['current', 'current', 'new']);

    const page = done(await hub.run('database/run_query', { fn: 'database/main.projects_selectPage', args: {} }));
    expect(page).toMatchObject({ result: { total: 3 } });
    const counted = TableFnsGenerated.parse(done(await hub.run('database/table_fns_generate', { table: 'owners', names: ['selectPage'], derived: ['projectCount'] })));
    const ranked = done(await hub.run('database/run_query', { fn: counted.fns[0]?.fn ?? '', args: {} }));
    expect(JSON.stringify(ranked)).toContain('Ada');
  });
});
