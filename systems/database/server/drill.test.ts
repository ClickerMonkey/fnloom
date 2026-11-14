/**
 * Drill-downs through the query (build-9 feedback): which saved reads `drillOf` un-ravels (a grouped select, a bare
 * aggregate) and which it refuses (a plain select, a write, a set operation, a window, a HAVING over an aggregate, a
 * group key the select doesn't output), the `drill` a grouped result carries, and `drill_down`'s read of the rows behind
 * one group: the group's values and the query's own params bound, paged with a total, the group's own LIMIT dropped,
 * and a group without a value refused.
 */
import { Json, type ResultTable } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { drillOf, type CompiledQuery } from './compile.ts';
import { databaseEnv } from './env.ts';
import { shopInstance } from './fixture.ts';
import type { DatabaseInstance } from './instance.ts';
import { DRILL_FN, QueryService, drillFor, type StoredQuery } from './queries.ts';

const open: DatabaseInstance[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((instance) => instance.close())); });

const ref = (source: string, field: string) => ({ kind: 'field-ref', source, field });
const sum = (field: string) => ({ kind: 'aggregate', function: 'sum', args: { value: ref('orders', field) } });
const count = { kind: 'aggregate', function: 'count', args: {} };

/** Orders per status: their count and total, for orders placed on or after a day. */
const PER_STATUS = {
  kind: 'select',
  fields: [{ expr: ref('orders', 'status'), as: 'status' }, { expr: count, as: 'orders' }, { expr: sum('total'), as: 'sales' }],
  from: { kind: 'type', type: 'orders' },
  where: [{ kind: 'comparison', op: '>=', left: ref('orders', 'placed'), right: { kind: 'param', name: 'since' } }],
  groupBy: [ref('orders', 'status')],
  order: [{ expr: sum('total'), dir: 'desc' }],
};

async function opened(): Promise<DatabaseInstance> {
  const { instance } = shopInstance();
  open.push(instance);
  await instance.rescan(undefined);
  return instance;
}

function compiled(instance: DatabaseInstance, query: unknown): CompiledQuery {
  const result = instance.compile({ instance: 'main', description: 'test', query: Json.parse(query), sorters: [], list: true });
  if (!('query' in result)) { throw new Error(result.report); }
  return result;
}

/** A query service over the instance, with saved queries read from `saved` (as `hub/fn_get` gives them). */
function service(instance: DatabaseInstance, saved: Record<string, unknown>) {
  const queries = new QueryService({ instance: () => instance, settings: databaseEnv.parse(), refresh: (_here, payload) => payload });
  const getFn = (fn: string): Promise<StoredQuery> => {
    const query = saved[fn];
    if (query === undefined) { return Promise.reject(new Error(`there is no fn ${fn}`)); }
    return Promise.resolve({ fn, kind: 'database/query', version: 1, payload: Json.parse({ instance: 'main', description: 'test', query, sorters: [], list: true }) });
  };
  return { queries, ctx: { getFn } };
}

function table(answer: ResultTable | { invalid: string } | { failed: string }): ResultTable {
  if (!('columns' in answer)) { throw new Error(JSON.stringify(answer)); }
  return answer;
}

describe('drilling into a saved grouped read', () => {
  it('un-ravels a grouped select into the rows behind one group, each key pinned to a param', async () => {
    const instance = await opened();
    const drill = drillOf(compiled(instance, PER_STATUS));
    expect(drill?.keys).toEqual([{ column: 'status', param: 'status' }]);
    expect(drill?.def).toMatchObject({ kind: 'select', from: { kind: 'type', type: 'orders' } });
    expect(drill?.def.groupBy).toBeUndefined();
    // the aggregate's order is un-aggregated (sum(total) → total), so the rows come biggest first
    expect(JSON.stringify(drill?.def.where)).toContain('"name":"status"');
    // a bare aggregate is one group, the whole table: nothing to pin
    expect(drillOf(compiled(instance, { kind: 'select', fields: [{ expr: sum('total'), as: 'sales' }], from: { kind: 'type', type: 'orders' } }))?.keys).toEqual([]);
  });

  it('refuses what has no group to un-ravel, or a group a click could not name', async () => {
    const instance = await opened();
    // a plain select: no grouping
    expect(drillOf(compiled(instance, { kind: 'select', fields: [{ expr: ref('orders', 'id'), as: 'id' }], from: { kind: 'type', type: 'orders' } }))).toBeUndefined();
    // a HAVING over an aggregate has no row-level meaning
    expect(drillOf(compiled(instance, { ...PER_STATUS, having: [{ kind: 'comparison', op: '>', left: count, right: { kind: 'literal', value: 1 } }] }))).toBeUndefined();
    // the group key isn't an output column: a clicked row has no value for it
    expect(drillOf(compiled(instance, { ...PER_STATUS, fields: [{ expr: count, as: 'orders' }] }))).toBeUndefined();
    // a write is never drilled
    expect(drillOf(compiled(instance, { kind: 'update', type: 'orders', set: { status: { kind: 'literal', value: 'paid' } } }))).toBeUndefined();
  });

  it('says how a grouped result is drilled into: drill_down with the fn, its params and the key columns', async () => {
    const instance = await opened();
    const grouped = compiled(instance, PER_STATUS);
    expect(drillFor(grouped, 'database/main.per_status', { since: '2026-09-01', limit: 10, offset: 0 })).toEqual({
      fn: DRILL_FN, args: { fn: 'database/main.per_status', args: { since: '2026-09-01' } }, keys: ['status'],
    });
    expect(DRILL_FN).toBe('database/drill_down');
    expect(drillFor(compiled(instance, { kind: 'select', fields: [{ expr: ref('orders', 'id'), as: 'id' }], from: { kind: 'type', type: 'orders' } }), 'database/main.ids', {})).toBeUndefined();
  });

  it('reads the rows behind one group, a page at a time, with the query\'s own params bound', async () => {
    const instance = await opened();
    const { queries, ctx } = service(instance, { 'database/main.per_status': PER_STATUS, 'database/main.top_status': { ...PER_STATUS, limit: 1 } });
    const paid = table(await queries.drill(instance, { fn: 'database/main.per_status', args: { since: '2026-09-01' }, group: { status: 'paid' } }, ctx));
    expect(paid.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['status', 'total', 'placed']));
    const total = paid.columns.findIndex((column) => column.name === 'sales');
    // the paid orders placed since September, biggest first (sum(total) un-aggregated to total, as sales)
    expect(paid.rows.map((row) => row[total])).toEqual([120.5, 15]);
    expect(paid).toMatchObject({ total: 2, offset: 0, limit: 50, truncated: false });
    // the source's params still filter: only October onwards leaves one paid order
    const later = table(await queries.drill(instance, { fn: 'database/main.per_status', args: { since: '2026-10-01' }, group: { status: 'paid' } }, ctx));
    expect(later.total).toBe(1);
    // a page of one, then the next
    const first = table(await queries.drill(instance, { fn: 'database/main.per_status', args: { since: '2026-01-01' }, group: { status: 'open' }, limit: 1 }, ctx));
    expect(first).toMatchObject({ total: 2, limit: 1, truncated: true });
    const next = table(await queries.drill(instance, { fn: 'database/main.per_status', args: { since: '2026-01-01' }, group: { status: 'open' }, limit: 1, offset: 1 }, ctx));
    expect(next).toMatchObject({ offset: 1, truncated: false });
    // the group's own LIMIT bounds the groups shown, not the rows behind one
    expect(table(await queries.drill(instance, { fn: 'database/main.top_status', args: { since: '2026-01-01' }, group: { status: 'paid' } }, ctx)).total).toBe(2);
  });

  it('refuses a group without a value, args that do not fit, and a query that does not group', async () => {
    const instance = await opened();
    const { queries, ctx } = service(instance, { 'database/main.per_status': PER_STATUS, 'database/main.ids': { kind: 'select', fields: [{ expr: ref('orders', 'id'), as: 'id' }], from: { kind: 'type', type: 'orders' } } });
    expect(await queries.drill(instance, { fn: 'database/main.per_status', args: { since: '2026-01-01' }, group: {} }, ctx)).toEqual({ invalid: 'The group has no value for status to drill into.' });
    expect(await queries.drill(instance, { fn: 'database/main.per_status', args: { since: '2026-01-01' }, group: { status: null } }, ctx)).toEqual({ invalid: 'The group has no value for status to drill into.' });
    expect(JSON.stringify(await queries.drill(instance, { fn: 'database/main.per_status', args: {}, group: { status: 'paid' } }, ctx))).toContain('since is required');
    expect(JSON.stringify(await queries.drill(instance, { fn: 'database/main.ids', group: {} }, ctx))).toContain("can't be drilled into");
  });
});
