/**
 * Build 5 on the real stack, over the database fleet the setup boots (`main`, a new SQLite file, and `shop`, an existing
 * one with customers and orders): the shop's tables are hub types; `get_query` writes, saves and runs a query fn with
 * the free model, and a second request like it reuses that fn; a saved query pages and sorts; a write and a
 * `create_table` each wait for approval, run once approved and report who declined and why otherwise.
 */
import { isSettled, QualifiedName, ResultTable, type Json, type Run, type RunId, type SessionId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { admin, clientInfo, invoke, settings, settle } from './kit.ts';

const TURN = settings.HARNESS_E2E_TURN_TIMEOUT;
const GET_QUERY = QualifiedName.parse('database/get_query');

/** A write the person must approve: open orders become paid. */
const MARK_PAID = {
  name: 'mark_open_paid', title: 'Mark open orders paid', description: 'Marks every open order as paid.',
  query: { kind: 'update', type: 'orders', set: { status: 'paid' }, where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'orders', field: 'status' }, right: { kind: 'literal', value: 'open' } }] },
};

let me: SignedIn;
let session: SessionId;

beforeAll(async () => {
  me = await admin();
  await settle(me);
  session = (await me.hub.call('createSession', { title: 'e2e build 5' })).id;
});

afterAll(() => { me.close(); });

/** Start a fn by hand and wait until it settles or waits for approval. */
async function started(fn: string, args: Json): Promise<Run> {
  const { run } = await me.hub.call('invoke', { session, fn: QualifiedName.parse(fn), args, client: clientInfo() });
  return waitFor(`${fn} to settle or wait`, async () => {
    const got = await me.hub.call('run', { run });
    return isSettled(got.status) || got.status === 'awaiting-approval' ? got : undefined;
  }, { timeout: TURN, every: 500 });
}

/** The run of `fn` waiting for approval under a turn, once there is one. */
async function waitingRun(fn: string): Promise<Run> {
  return waitFor(`${fn} to wait for approval`, async () => {
    const page = await me.hub.call('runs', { query: { filters: [{ field: 'fn', op: 'is', value: fn }, { field: 'status', op: 'in', values: ['awaiting-approval'] }], limit: 1 } });
    return page.items[0];
  }, { timeout: TURN, every: 500 });
}

/** Approve or decline a waiting run, and wait for it to settle. */
async function decide(run: RunId, approve: boolean): Promise<Run> {
  const [approval] = await me.hub.call('approvals', { runs: [run] });
  if (approval === undefined) throw new Error(`run ${run} has no approval`);
  await me.hub.call('approve', { approval: approval.id, approve, remember: 'once', ...(approve ? {} : { reason: 'Not now' }) });
  return waitFor(`run ${run} to settle`, async () => {
    const got = await me.hub.call('run', { run });
    return isSettled(got.status) ? got : undefined;
  }, { timeout: TURN, every: 500 });
}

describe('tables as types', () => {
  it('keeps each table of the shop as a hub type of its instance', async () => {
    const found = await waitFor('the shop types', async () => {
      const got = await me.hub.call('types', { names: [QualifiedName.parse('database/shop.orders'), QualifiedName.parse('database/shop.customers')] });
      return got.missing.length === 0 ? got : undefined;
    }, { timeout: 60_000, every: 1_000 });
    expect(found.types.map((type) => [type.name, type.instance])).toEqual([['database/shop.orders', 'shop'], ['database/shop.customers', 'shop']]);
  });
});

describe('get_query with the free model', () => {
  it('writes, saves and runs a query fn, then reuses it for a request like it', { timeout: TURN * 2 }, async () => {
    const first = await invoke(me, session, GET_QUERY, { detailedDescription: 'In the Shop database: every customer with how many orders they placed, most orders first. No filters.' }, TURN);
    expect(first.status).toBe('done');
    const answer = first.outcome?.status === 'done' ? first.outcome.result : null;
    expect(answer).toMatchObject({ database: { instance: 'shop' }, fn: { how: 'created' } });
    const called = typeof answer === 'object' && answer !== null && !Array.isArray(answer) ? answer['fn'] : undefined;
    const fn = typeof called === 'object' && called !== null && !Array.isArray(called) ? called['name'] : undefined;
    expect(fn).toMatch(/^database\/shop\./);
    expect(answer).toHaveProperty('result.fn.name', fn);
    const second = await invoke(me, session, GET_QUERY, { detailedDescription: 'In the Shop database: each customer and their number of orders, the most first.' }, TURN);
    expect(second.outcome).toMatchObject({ status: 'done', result: { fn: { name: fn, how: 'reused' } } });
  });
});

describe('a saved query', () => {
  it('pages and sorts by its args, and says where the next page is', async () => {
    await invoke(me, session, QualifiedName.parse('database/save_query'), {
      database: 'shop', args: {},
      draft: {
        name: 'orders_by_total', title: 'Orders by total', description: 'Every order with its total, biggest first.', sorters: ['total', 'status'],
        query: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'orders', field: 'id' }, as: 'id' }, { expr: { kind: 'field-ref', source: 'orders', field: 'total' }, as: 'total' }, { expr: { kind: 'field-ref', source: 'orders', field: 'status' }, as: 'status' }], from: { kind: 'type', type: 'orders' }, order: [{ expr: { kind: 'field-ref', source: 'orders', field: 'total' }, dir: 'desc' }] },
      },
    });
    const page = await invoke(me, session, QualifiedName.parse('database/shop.orders_by_total'), { limit: 2, offset: 1, sort: [{ column: 'total', dir: 'asc' }] });
    // run directly, a saved read gives its rows as a result table (the hub words it for the model as a summary and the first rows)
    expect(page.outcome).toMatchObject({ status: 'done', result: { offset: 1, limit: 2, total: 5, truncated: true, sort: [{ column: 'total', dir: 'asc' }] } });
    const rows = page.outcome?.status === 'done' ? ResultTable.parse(page.outcome.result).rows : [];
    expect(rows.map((row) => row[1])).toEqual([15, 42]);
  });
});

describe('approval', () => {
  it('runs a write once approved, and reports who declined it and why', async () => {
    await invoke(me, session, QualifiedName.parse('database/save_query'), { database: 'shop', draft: MARK_PAID, args: {} });
    const asked = await started('database/shop.mark_open_paid', {});
    expect(asked.status).toBe('awaiting-approval');
    expect((await decide(asked.id, true)).outcome).toMatchObject({ status: 'done', result: { affected: 2 } });
    const again = await started('database/shop.mark_open_paid', {});
    expect((await decide(again.id, false)).outcome).toMatchObject({ status: 'cancelled', error: { message: 'Declined by e2e: Not now', code: 'denied' } });
  });

  it('makes a table from a gin type once approved, and it becomes a hub type', async () => {
    await me.hub.call('invoke', {
      session, fn: QualifiedName.parse('database/create_table'), client: clientInfo(),
      args: { table: 'notes', database: 'main', type: { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, title: { type: { name: 'text' } } } } },
    });
    // create_table asks once itself, its card showing the DDL (the owner's 2026-11-13 fix), and makes the table once approved
    const change = await waitingRun('database/create_table');
    const [approval] = await me.hub.call('approvals', { runs: [change.id] });
    expect(approval?.preview?.parts.map((part) => part.type)).toContain('code');
    expect((await decide(change.id, true)).status).toBe('done');
    expect((await me.hub.call('types', { names: [QualifiedName.parse('database/main.notes')] })).missing).toEqual([]);
  });
});
