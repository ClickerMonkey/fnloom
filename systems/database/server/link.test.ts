/**
 * The database system over the SDK's real link runtime and an in-memory hub, on a real SQLite file: the manifest
 * (the query agents with their prompts and tools, every fn's instructions and examples, the query kind, the visuals
 * registry, the secret config fields), the agents' tools (tables, a draft checked, kept in the hub and run, a taken
 * name, a new version), a saved query run through its kind, a write proposed for the person's approval (with its
 * preview) and run once approved, a read-only database refusing writes, a schema change previewed and applied, and a
 * rescan whose breaking change (found through the hub's search) waits for an admin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ActorId, Json, SystemPackageManifest, mintId, type OutcomeWire } from '@harness/core';
import { hub as hubContract } from '@harness/sdk';
import { FakeHub, TEST_USER } from '@harness/sdk/server/testing';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { QUERY_KIND, QueryRun, database } from '../shared/index.ts';
import { serveDatabase, shopConfig, shopFile, type RecordingHub, type ServedDatabase } from './fixture.ts';
import type { DatabaseServer } from './impl.ts';

const packageManifest = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8')));

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}


const ref = (source: string, field: string) => ({ kind: 'field-ref', source, field });
const byStatus = (status: { kind: 'param'; name: string } | { kind: 'literal'; value: string }) => [{ kind: 'comparison', op: '=', left: ref('orders', 'status'), right: status }];

/** A draft for "orders with a status, biggest first". */
const ORDERS_BY_STATUS = {
  name: 'orders_by_status', title: 'Orders by status', description: 'Orders with a given status, with their customer, biggest first.', sorters: ['total', 'customer'],
  query: {
    kind: 'select',
    fields: [{ expr: ref('orders', 'id'), as: 'id' }, { expr: ref('orders', 'total'), as: 'total' }, { expr: ref('customers', 'name'), as: 'customer' }],
    from: { kind: 'type', type: 'orders' },
    joins: [{ on: { kind: 'relation', source: 'orders', field: 'customer', as: 'customers' }, joinType: 'inner' }],
    where: byStatus({ kind: 'param', name: 'status' }),
    order: [{ expr: ref('orders', 'total'), dir: 'desc' }],
  },
};

const MARK_PAID = {
  name: 'mark_paid', title: 'Mark open orders paid', description: 'Marks every open order as paid.',
  query: { kind: 'update', type: 'orders', set: { status: 'paid' }, where: byStatus({ kind: 'literal', value: 'open' }) },
};

describe('the database system over the link', () => {
  let served: ServedDatabase | undefined;
  let hub: FakeHub;
  let server: DatabaseServer;
  let types: RecordingHub;
  let dir: string;
  /** Called after each table type patch reaches the hub (the real hub describes saved queries again then). */
  let afterPatch: (() => Promise<void>) | undefined;

  async function start(config = shopConfig()): Promise<void> {
    served = await serveDatabase({ dir, config, afterPatch: async () => { await afterPatch?.(); } });
    ({ hub, server, types } = served);
  }

  afterEach(async () => {
    await served?.stop();
    served = undefined;
    afterPatch = undefined;
  });

  it('declares the query agents with their tools, every fn with instructions and examples, the query kind, the registry and the secrets', async () => {
    dir = shopFile().dir;
    await start();
    expect(database.name).toBe(packageManifest.name);
    const manifest = hub.manifests[0];
    expect(manifest?.kinds.map((item) => item.name)).toEqual(['query']);
    expect(manifest?.fns.map((item) => item.name).sort()).toEqual([
      'alter_table', 'apply_type_changes', 'at_instance', 'change_schema', 'check_query', 'create_table', 'databases', 'edit_query', 'get_query', 'pick_database', 'run_query', 'save_query', 'tables',
    ]);
    const getQuery = manifest?.fns.find((item) => item.name === 'get_query');
    expect(getQuery).toMatchObject({ kind: 'hub/llm' });
    expect(getQuery?.payload).toMatchObject({
      tools: ['database/databases', hubContract.fns.fns_search.name, hubContract.fns.fn_get.name, hubContract.fns.fn_examples.name, 'database/tables', 'database/check_query', 'database/save_query', 'database/run_query'],
    });
    expect(JSON.stringify(getQuery?.payload)).toContain('{{args.detailedDescription}}');
    expect(manifest?.fns.find((item) => item.name === 'edit_query')?.payload).toHaveProperty('tools', expect.arrayContaining(['database/save_query', 'database/run_query']));
    expect(manifest?.fns.find((item) => item.name === 'at_instance')).toMatchObject({ visibility: 'none', deps: ['hub/fn_get', 'hub/save_fn'] });
    for (const decl of manifest?.fns ?? []) {
      expect(decl.instructions, decl.name).toBeTruthy();
      expect(decl.examples?.length ?? 0, decl.name).toBeGreaterThan(0);
    }
    expect(manifest?.fns.find((item) => item.name === 'change_schema')).toMatchObject({ approval: { preview: true, remember: false }, visibility: 'none' });
    expect(manifest?.registries?.map((item) => item.name)).toEqual(['query-visuals']);
    expect(manifest?.contributes).toBeUndefined();
    expect(manifest?.configSecrets).toEqual(['connection.url', 'connection.password']);
    expect(types.upserts[0]?.sort()).toEqual(['main.customers', 'main.orders']);
  });

  it('gives the agent the tables, checks a draft, keeps it in the hub, runs it, and keeps a new version', async () => {
    dir = shopFile().dir;
    await start();
    expect(done(await hub.run('database/databases', {}))).toEqual([{ instance: 'main', label: 'Shop', tables: ['customers', 'orders'] }]);
    const tables = done(await hub.run('database/tables', { database: 'main' }));
    expect(tables).toMatchObject({ database: { instance: 'main', label: 'Shop', dialect: 'sqlite' }, writes: true });
    expect(JSON.stringify(tables)).toContain('orders');
    expect(await hub.run('database/tables', { database: 'not a name!' })).toMatchObject({ status: 'invalid-input' });

    const broken = { ...ORDERS_BY_STATUS, query: { kind: 'select', fields: [{ expr: ref('orders', 'ghost') }], from: { kind: 'type', type: 'orders' } } };
    expect(done(await hub.run('database/check_query', { database: 'main', draft: broken }))).toMatchObject({ ok: false, problems: [expect.stringContaining('ghost')] });
    const checked = done(await hub.run('database/check_query', { database: 'main', draft: ORDERS_BY_STATUS }));
    expect(checked).toMatchObject({ ok: true, problems: [], writes: false });
    expect(checked).toHaveProperty('sql', expect.stringContaining('SELECT'));
    expect(checked).toHaveProperty('signature', expect.stringContaining('database/main.orders_by_status('));
    expect(await hub.run('database/save_query', { database: 'main', draft: broken })).toMatchObject({ status: 'invalid-input' });
    // args given as text (gin reads an open record as any JSON) are refused by name
    expect(await hub.run('database/save_query', { database: 'main', draft: ORDERS_BY_STATUS, args: '{"status":"paid"}' })).toMatchObject({ status: 'invalid-input', invalid: { problems: [{ path: 'args' }] } });

    const saved = done(await hub.run('database/save_query', { database: 'main', draft: ORDERS_BY_STATUS, args: { status: 'paid' }, askedFor: 'paid orders, biggest first' }));
    expect(saved).toMatchObject({ fn: 'database/main.orders_by_status', version: 1, created: true });
    expect(hub.fns.kept.get('database/main.orders_by_status')?.saved).toMatchObject({
      kind: QUERY_KIND, routing: { to: 'instance', instance: 'main' }, share: { visibility: 'public' },
      examples: [{ args: { status: 'paid' }, note: 'paid orders, biggest first' }],
      payload: { instance: 'main', list: true, sorters: ['total', 'customer'] },
    });
    // the system's own manifest is never patched with it: saved queries are the hub's
    expect(hub.patches.filter((patch) => (patch.upsert.fns ?? []).length > 0)).toEqual([]);

    const ran = done(await hub.run('database/run_query', { fn: 'database/main.orders_by_status', args: { status: 'paid' } }));
    expect(ran).toMatchObject({
      fn: { name: 'database/main.orders_by_status' }, query: { writes: false, params: { status: 'paid' } },
      result: { rowCount: 2, total: 2, truncated: false, sample: [{ id: 1, total: 120.5, customer: 'Ada' }, { id: 3, total: 15, customer: 'Bo' }] },
    });
    expect(JSON.stringify(ran)).toContain('shown to the person');
    expect(hub.attachments.at(-1)?.item).toMatchObject({ attachment: 'database/result', data: { rows: [[1, 120.5, 'Ada'], [3, 15, 'Bo']] } });
    expect(await hub.run('database/run_query', { fn: 'database/main.nothing' })).toMatchObject({ status: 'invalid-input' });
    expect(await hub.run('database/run_query', { fn: 'orders' })).toMatchObject({ status: 'invalid-input' });
    // run_query checks the args as the hub checks a direct call's: no unbounded or fractional page, no unknown sort
    for (const args of [{ status: 'paid', limit: -1 }, { status: 'paid', limit: 2.5 }, { status: 'paid', offset: -3 }, { status: 'paid', limit: 0 }, { status: 'paid', sort: [{ column: 'nope', dir: 'asc' }] }, { status: 'paid', stauts: 'paid' }]) {
      expect(await hub.run('database/run_query', { fn: 'database/main.orders_by_status', args })).toMatchObject({ status: 'invalid-input' });
    }
    // a missing param is refused by name, never bound as NULL
    expect(JSON.stringify(await hub.run('database/run_query', { fn: 'database/main.orders_by_status', args: { limit: 5 } }))).toContain('status is required');
    // the next page's call keeps the sort it was read with
    const sorted = done(await hub.run('database/run_query', { fn: 'database/main.orders_by_status', args: { status: 'paid', limit: 1, sort: [{ column: 'customer', dir: 'asc' }] } }));
    expect(QueryRun.parse(sorted).result?.nextPage?.call).toContain('"sort":[{"column":"customer","dir":"asc"}]');

    // a taken name gets the next one; replace keeps the old version in the hub's history
    expect(done(await hub.run('database/save_query', { database: 'main', draft: ORDERS_BY_STATUS }))).toMatchObject({ fn: 'database/main.orders_by_status_2', created: true });
    const placed = { ...ORDERS_BY_STATUS, query: { ...ORDERS_BY_STATUS.query, fields: [...ORDERS_BY_STATUS.query.fields, { expr: ref('orders', 'placed'), as: 'placed' }] } };
    expect(done(await hub.run('database/save_query', { database: 'main', draft: placed, replace: true }))).toMatchObject({ fn: 'database/main.orders_by_status', version: 2, created: false });
    expect(hub.fns.kept.get('database/main.orders_by_status')?.history).toHaveLength(1);

    const payload = hub.fns.kept.get('database/main.orders_by_status')?.saved.payload ?? null;
    const paged = done(await hub.run('database/main.orders_by_status', { status: 'paid', limit: 1, sort: [{ column: 'customer', dir: 'desc' }] }, { kind: 'database/query', payload }));
    expect(paged).toMatchObject({ rowCount: 1, total: 2, truncated: true, sort: [{ column: 'customer', dir: 'desc' }], sample: [{ customer: 'Bo' }], nextPage: { offset: 1, limit: 1 } });
    expect(paged).toMatchObject({ columns: [{ name: 'id' }, { name: 'total' }, { name: 'customer' }, { name: 'placed', kind: 'date' }] });
    expect(await hub.run('database/main.orders_by_status', { limit: 1 }, { kind: 'database/query', payload })).toMatchObject({ status: 'invalid-input' });
  });

  it('proposes a write for the person, previews it, and runs it once approved', async () => {
    dir = shopFile().dir;
    await start();
    expect(done(await hub.run('database/save_query', { database: 'main', draft: MARK_PAID }))).toMatchObject({ fn: 'database/main.mark_paid' });
    const answer = done(await hub.run('database/run_query', { fn: 'database/main.mark_paid' }));
    expect(answer).toMatchObject({ fn: { name: 'database/main.mark_paid' }, query: { writes: true }, approval: { state: 'waiting' } });
    expect(answer).not.toHaveProperty('result');
    const proposal = hub.proposals.at(-1);
    expect(proposal).toMatchObject({ fn: 'main.mark_paid', approver: 'person', preview: { title: 'Change 2 rows in orders (Shop database)', irreversible: false } });
    expect(proposal?.preview.parts.map((part) => part.type)).toEqual(['text', 'code', 'table']);
    const payload = hub.fns.kept.get('database/main.mark_paid')?.saved.payload ?? null;
    const checked = await hub.peer().call('check', { kind: 'query', payload });
    expect(checked).toMatchObject({ problems: [], description: { approval: { preview: true, remember: false }, types: ['database/main.orders'], effects: { mode: 'write', reads: ['database/main.orders'], writes: ['database/main.orders'], free: true } } });
    const preview = await hub.preview({ run: mintId('run'), fn: 'main.mark_paid', args: {}, user: TEST_USER, kind: 'database/query', payload });
    expect(preview).toMatchObject({ preview: { title: 'Change 2 rows in orders (Shop database)' } });
    expect(done(await hub.run('database/main.mark_paid', {}, { kind: 'database/query', payload }))).toMatchObject({ affected: 2 });
    const check = new BetterSqlite3(join(dir, 'shop.db'));
    expect(check.prepare('SELECT count(*) AS n FROM orders WHERE status = \'open\'').get()).toEqual({ n: 0 });
    check.close();
  });

  it('never saves a write on a read-only database, and refuses schema changes without schema allowed', async () => {
    dir = shopFile().dir;
    await start(shopConfig({ data: 'read-only', schema: 'none' }));
    const wipe = { name: 'wipe', title: 'Wipe', description: 'Deletes every order.', query: { kind: 'delete', from: 'orders' } };
    expect(done(await hub.run('database/check_query', { database: 'main', draft: wipe }))).toMatchObject({ ok: false, problems: [expect.stringContaining('read-only')] });
    expect(await hub.run('database/save_query', { database: 'main', draft: wipe })).toMatchObject({ status: 'invalid-input' });
    expect(hub.fns.kept.size).toBe(0);
    expect(hub.proposals).toEqual([]);
    const args = { action: 'create', table: 'notes', database: 'main', type: { name: 'obj', props: { id: { type: { name: 'num' } } } } };
    expect(JSON.stringify(await hub.preview({ run: mintId('run'), fn: 'change_schema', args, user: TEST_USER }))).toContain('allow schema changes');
  });

  it('keeps a database to its audience: refused to a member outside it, served to one it is shared with', async () => {
    dir = shopFile().dir;
    const bo = { ...TEST_USER, id: ActorId.parse('act_bo'), name: 'Bo', role: 'member' as const };
    await start(shopConfig({ audience: { visibility: 'shared', with: [bo.id] } }));
    // the instance answers for the run's person (in the hub, `tables` forwards here as the same person)
    const as = (user: typeof TEST_USER) => ({ run: hub.runInfo('database/at_instance', { user }) });
    const refused = await hub.run('database/at_instance', { op: 'tables' }, as({ ...TEST_USER, id: ActorId.parse('act_cy'), role: 'member' }));
    expect(refused.status === 'invalid-input' ? refused.invalid.problems.map((problem) => problem.message) : refused).toEqual(['You may not use the Shop database; an admin chooses who may on its config.']);
    expect(done(await hub.run('database/at_instance', { op: 'tables' }, as(bo)))).toHaveProperty('tables.schema');
    // a saved query fn called directly is held to the database's audience as it is now
    done(await hub.run('database/save_query', { database: 'main', draft: ORDERS_BY_STATUS }));
    const payload = hub.fns.kept.get('database/main.orders_by_status')?.saved.payload ?? null;
    const cy = { ...TEST_USER, id: ActorId.parse('act_cy'), role: 'member' as const };
    const direct = await hub.run('database/main.orders_by_status', { status: 'paid' }, { kind: 'database/query', payload, run: hub.runInfo('database/main.orders_by_status', { user: cy }) });
    expect(direct).toMatchObject({ status: 'invalid-input' });
    expect(done(await hub.run('database/main.orders_by_status', { status: 'paid' }, { kind: 'database/query', payload, run: hub.runInfo('database/main.orders_by_status', { user: bo }) }))).toMatchObject({ rowCount: 2 });
  });

  it('describes saved queries against the scanned tables while the types of a rescan reach the hub', async () => {
    dir = shopFile().dir;
    await start();
    done(await hub.run('database/save_query', { database: 'main', draft: ORDERS_BY_STATUS }));
    const payload = hub.fns.kept.get('database/main.orders_by_status')?.saved.payload ?? null;
    const described: unknown[] = [];
    afterPatch = async () => { described.push(await hub.peer().call('check', { kind: 'query', payload })); };
    await hub.configure(shopConfig({ label: 'Shop (renamed)' }));
    for (let wait = 0; described.length === 0 && wait < 200; wait += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); }
    expect(described[0]).toMatchObject({ problems: [], description: { args: { name: 'obj', props: { status: {} } }, effects: { mode: 'read' } } });
  });

  it('previews and makes a table from a type, and refuses one that exists', async () => {
    dir = shopFile().dir;
    await start();
    const args = { action: 'create', table: 'notes', database: 'main', type: { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, body: { type: { name: 'text' } } } } };
    const preview = await hub.preview({ run: mintId('run'), fn: 'change_schema', args, user: TEST_USER });
    expect(preview).toMatchObject({ preview: { title: 'Create table notes (Shop database)', irreversible: false } });
    expect(JSON.stringify(preview)).toContain('CREATE TABLE');
    const made = done(await hub.run('database/change_schema', args));
    expect(made).toMatchObject({ database: { instance: 'main' } });
    expect(JSON.stringify(made)).toContain('"database/main.notes"');
    expect(types.upserts.at(-1)).toContain('main.notes');
    expect(JSON.stringify(await hub.preview({ run: mintId('run'), fn: 'change_schema', args, user: TEST_USER }))).toContain('exists already');
  });

  it('holds back a breaking rescan for an admin, naming the saved queries the hub says read the table, and applies it once approved', async () => {
    dir = shopFile().dir;
    await start();
    done(await hub.run('database/save_query', { database: 'main', draft: ORDERS_BY_STATUS }));
    const db = new BetterSqlite3(join(dir, 'shop.db'));
    db.exec('ALTER TABLE orders DROP COLUMN total');
    db.close();
    await hub.configure(shopConfig({ label: 'Shop (renamed)' }));
    for (let wait = 0; hub.proposals.length === 0 && wait < 200; wait += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); }
    const proposal = hub.proposals.at(-1);
    expect(proposal).toMatchObject({ fn: 'apply_type_changes', approver: 'admins', preview: { parts: [{ type: 'type-diff', name: 'database/main.orders', breaks: [{ fn: 'database/main.orders_by_status' }] }] } });
    const scan = server.current()?.pending?.scan ?? '';
    expect(done(await hub.run('database/apply_type_changes', { scan }))).toMatchObject({ types: ['database/main.orders'] });
    expect(await hub.run('database/apply_type_changes', { scan })).toMatchObject({ status: 'invalid-input' });
  });
});
