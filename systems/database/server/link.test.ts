/**
 * The database system over the SDK's real link runtime and an in-memory hub, on a real SQLite file: the manifest
 * (the query agents with their prompts and tools, every fn's instructions and examples, the query kind, the visuals
 * registry, the secret config fields), queries kept the one way they are (the authoring agent, scripted: a draft
 * checked, kept in the hub and run, a taken name, a new version), a saved query run through its kind, a write proposed for the person's approval (with its
 * preview) and run once approved, a read-only database refusing writes, a schema change previewed and applied, and a
 * rescan whose breaking change (found through the hub's search) waits for an admin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ActorId, SystemPackageManifest, mintId, type Json, type OutcomeWire } from '@harness/core';
import { hub as hubContract } from '@harness/sdk';
import { TEST_USER, streamOf, type FakeHub } from '@harness/sdk/server/testing';
import { replyChunks, toolCall as callTool } from '@harness/sdk/testing';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { QUERY_KIND, QueryAgentAnswer, QueryRun, database } from '../shared/index.ts';
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
  query: { kind: 'update', type: 'orders', set: { status: { kind: 'literal', value: 'paid' } }, where: byStatus({ kind: 'literal', value: 'open' }) },
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

  /** A query draft as these tests write it. */
  type Draft = { readonly name: string; readonly title: string; readonly description: string; readonly query: Json; readonly sorters?: readonly string[] };

  /**
   * Keep a query the one way queries are kept: `get_query` (or `edit_query` of `replace`) with the authoring model
   * scripted to find, load the tables (or the query), draft it with `args` and save it. Gives the agent's answer.
   */
  async function keep(draft: Draft, options: { args?: Record<string, Json>; askedFor?: string; replace?: string; before?: Draft[] } = {}): Promise<Exclude<QueryAgentAnswer, { ask: string }>> {
    const script = [
      callTool('find_queries', { text: draft.description }),
      options.replace === undefined ? callTool('load_tables', { names: ['orders', 'customers'] }) : callTool('load_query', { fn: options.replace }),
      ...(options.before ?? []).map((earlier) => callTool('draft', { draft: { ...earlier, args: options.args ?? {} } })),
      callTool('draft', { draft: { ...draft, args: options.args ?? {} } }),
      callTool('save', {}),
      replyChunks('Saved.'),
    ];
    hub.onLlm = () => streamOf(script.shift() ?? replyChunks('Done.'));
    const asked = options.askedFor ?? draft.description;
    const answer = QueryAgentAnswer.parse(done(options.replace === undefined
      ? await hub.run('database/get_query', { detailedDescription: asked })
      : await hub.run('database/edit_query', { name: options.replace, instructions: asked })));
    if ('ask' in answer) { throw new Error(`expected a kept query, got a question: ${JSON.stringify(answer)}`); }
    return answer;
  }

  it('declares the authoring fns, every fn with instructions and examples, the query kind, the registry and the secrets', async () => {
    dir = shopFile().dir;
    await start();
    expect(database.name).toBe(packageManifest.name);
    const manifest = hub.manifests[0];
    // every fn is in one of its API groups, which the hub indexes (`<system>/api.<group>`)
    expect(manifest?.groups?.map((group) => group.name)).toEqual(['queries', 'tables', 'schema', 'instances']);
    for (const decl of manifest?.fns ?? []) { expect(['queries', 'tables', 'schema', 'instances'], decl.name).toContain(decl.group); }
    expect(manifest?.kinds.map((item) => item.name)).toEqual(['query']);
    expect(manifest?.fns.map((item) => item.name).sort()).toEqual([
      'alter_table', 'apply_type_changes', 'at_instance', 'author_query', 'change_schema', 'create_table', 'databases', 'drill_down', 'edit_query', 'get_query', 'pick_database', 'read_at_instance', 'run_query',
      'table_fns_available', 'table_fns_generate', 'tables',
    ]);
    // get_query and edit_query are native fns that forward to the authoring agent on the instance with the database
    expect(manifest?.fns.find((item) => item.name === 'get_query')).toMatchObject({ kind: 'native', deps: ['database/author_query'], effects: { mode: 'write' } });
    expect(manifest?.fns.find((item) => item.name === 'edit_query')).toMatchObject({ kind: 'native', deps: ['database/author_query'] });
    expect(manifest?.fns.find((item) => item.name === 'author_query')).toMatchObject({ visibility: 'none', deps: [hubContract.fns.fns_get.name, hubContract.fns.fns_save.name] });
    expect(manifest?.fns.find((item) => item.name === 'run_query')?.effects).toMatchObject({ mode: 'write' });
    expect(manifest?.fns.find((item) => item.name === 'at_instance')).toMatchObject({ visibility: 'none', deps: ['hub/fns_get', 'hub/fns_save'] });
    for (const decl of manifest?.fns ?? []) {
      expect(decl.instructions, decl.name).toBeTruthy();
      expect(decl.examples?.length ?? 0, decl.name).toBeGreaterThan(0);
    }
    expect(manifest?.fns.find((item) => item.name === 'change_schema')).toMatchObject({ approval: { preview: true, remember: false }, visibility: 'none' });
    // its rows are drawn by the app's own result view: it hosts no registry and contributes no visual
    expect(manifest?.registries).toBeUndefined();
    expect(manifest?.contributes ?? []).toEqual([]);
    expect(manifest?.configSecrets).toEqual(['connection.url', 'connection.password']);
    expect(types.upserts[0]?.sort()).toEqual(['main.customers', 'main.orders']);
  });

  it('gives the agent the tables, checks a draft, keeps it in the hub, runs it, and keeps a new version', async () => {
    dir = shopFile().dir;
    await start();
    expect(done(await hub.run('database/databases', {}))).toEqual([{ instance: 'main', label: 'Shop', tables: ['customers', 'orders'], writes: true, schemaChanges: true }]);
    const tables = done(await hub.run('database/tables', { database: 'main' }));
    expect(tables).toMatchObject({ database: { instance: 'main', label: 'Shop', dialect: 'sqlite' }, writes: true, schemaChanges: true });
    expect(JSON.stringify(tables)).toContain('orders');
    expect(await hub.run('database/tables', { database: 'not a name!' })).toMatchObject({ status: 'invalid-input' });

    // a broken draft's problem goes back to the agent, which fixes it before it may save
    const broken = { ...ORDERS_BY_STATUS, query: { kind: 'select', fields: [{ expr: ref('orders', 'ghost') }], from: { kind: 'type', type: 'orders' } } };
    const saved = await keep(ORDERS_BY_STATUS, { args: { status: 'paid' }, askedFor: 'paid orders, biggest first', before: [broken] });
    expect(JSON.stringify(hub.forwards.map((forward) => forward.request.messages))).toContain('ghost');
    expect(saved.fn).toMatchObject({ name: 'database/main.orders_by_status', version: 1, how: 'created' });
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
    // nobody is watching this run: the rows are worded for the model alone; a watched run says they are shown
    expect(JSON.stringify(ran)).toContain('Nobody is watching');
    const watched = hub.runInfo('database/main.orders_by_status', { watched: true });
    const savedPayload = hub.fns.kept.get('database/main.orders_by_status')?.saved.payload ?? null;
    // run directly, a saved read gives its rows as a result table (the hub words it for the model; a widget can read it)
    expect(done(await hub.run('database/main.orders_by_status', { status: 'paid' }, { kind: QUERY_KIND, payload: savedPayload, run: watched }))).toMatchObject({ rows: [[1, 120.5, 'Ada'], [3, 15, 'Bo']], total: 2, truncated: false });
    // a missing required param is refused, never bound as NULL
    expect(await hub.run('database/run_query', { fn: 'database/main.orders_by_status', args: {} })).toMatchObject({ status: 'invalid-input' });
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
    expect((await keep(ORDERS_BY_STATUS, { args: { status: 'open' } })).fn).toMatchObject({ name: 'database/main.orders_by_status_2', how: 'created' });
    const placed = { ...ORDERS_BY_STATUS, query: { ...ORDERS_BY_STATUS.query, fields: [...ORDERS_BY_STATUS.query.fields, { expr: ref('orders', 'placed'), as: 'placed' }] } };
    expect((await keep(placed, { args: { status: 'paid' }, replace: 'database/main.orders_by_status' })).fn).toMatchObject({ name: 'database/main.orders_by_status', version: 2, how: 'edited' });
    expect(hub.fns.kept.get('database/main.orders_by_status')?.history).toHaveLength(1);

    const payload = hub.fns.kept.get('database/main.orders_by_status')?.saved.payload ?? null;
    const paged = done(await hub.run('database/main.orders_by_status', { status: 'paid', limit: 1, sort: [{ column: 'customer', dir: 'desc' }] }, { kind: 'database/query', payload }));
    expect(paged).toMatchObject({ total: 2, truncated: true, offset: 0, limit: 1, sort: [{ column: 'customer', dir: 'desc' }] });
    expect(paged).toMatchObject({ rows: [[expect.anything(), expect.anything(), 'Bo', expect.anything()]] });
    expect(paged).toMatchObject({ columns: [{ name: 'id' }, { name: 'total' }, { name: 'customer' }, { name: 'placed', kind: 'date' }] });
    expect(await hub.run('database/main.orders_by_status', { limit: 1 }, { kind: 'database/query', payload })).toMatchObject({ status: 'invalid-input' });
  });

  it('drills into a saved grouped read: its result says so, and drill_down reads the rows behind one group as the person', async () => {
    dir = shopFile().dir;
    await start();
    const perStatus = {
      name: 'orders_per_status', title: 'Orders per status', description: 'How many orders there are of each status, and their total.',
      query: {
        kind: 'select',
        fields: [{ expr: ref('orders', 'status'), as: 'status' }, { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('orders', 'total') } }, as: 'sales' }],
        from: { kind: 'type', type: 'orders' },
        groupBy: [ref('orders', 'status')],
      },
    };
    expect((await keep(perStatus)).fn).toMatchObject({ name: 'database/main.orders_per_status' });
    const payload = hub.fns.kept.get('database/main.orders_per_status')?.saved.payload ?? null;
    const grouped = done(await hub.run('database/main.orders_per_status', {}, { kind: QUERY_KIND, payload }));
    expect(grouped).toMatchObject({ drill: { fn: 'database/drill_down', args: { fn: 'database/main.orders_per_status', args: {} }, keys: ['status'] } });
    // the chat's attachment of the same read carries it too
    done(await hub.run('database/run_query', { fn: 'database/main.orders_per_status' }));
    expect(hub.attachments.at(-1)?.item).toMatchObject({ data: { drill: { keys: ['status'] } } });
    const rows = done(await hub.run('database/drill_down', { fn: 'database/main.orders_per_status', args: {}, group: { status: 'open' } }));
    expect(rows).toMatchObject({ total: 2, truncated: false });
    expect(rows).not.toHaveProperty('drill');
    expect(await hub.run('database/drill_down', { fn: 'database/main.orders_per_status', group: {} })).toMatchObject({ status: 'invalid-input' });
    expect(await hub.run('database/drill_down', { fn: 'orders', group: { status: 'open' } })).toMatchObject({ status: 'invalid-input' });
    // a plain read has no groups: no drill on its result, and drill_down refuses it
    expect((await keep(ORDERS_BY_STATUS, { args: { status: 'paid' } })).fn).toMatchObject({ name: 'database/main.orders_by_status' });
    const plain = hub.fns.kept.get('database/main.orders_by_status')?.saved.payload ?? null;
    expect(done(await hub.run('database/main.orders_by_status', { status: 'paid' }, { kind: QUERY_KIND, payload: plain }))).not.toHaveProperty('drill');
    expect(await hub.run('database/drill_down', { fn: 'database/main.orders_by_status', args: { status: 'paid' }, group: {} })).toMatchObject({ status: 'invalid-input' });
  });

  it('proposes a write for the person, previews it, and runs it once approved', async () => {
    dir = shopFile().dir;
    await start();
    expect((await keep(MARK_PAID)).fn).toMatchObject({ name: 'database/main.mark_paid' });
    const answer = done(await hub.run('database/run_query', { fn: 'database/main.mark_paid' }));
    expect(answer).toMatchObject({ fn: { name: 'database/main.mark_paid' }, query: { writes: true }, approval: { state: 'waiting' } });
    expect(answer).not.toHaveProperty('result');
    const proposal = hub.proposals.at(-1);
    expect(proposal).toMatchObject({ fn: 'main.mark_paid', approver: 'person', preview: { title: 'Change 2 rows in orders (Shop database)', irreversible: false } });
    expect(proposal?.preview.parts.map((part) => part.type)).toEqual(['text', 'code', 'table']);
    const payload = hub.fns.kept.get('database/main.mark_paid')?.saved.payload ?? null;
    const checked = await hub.peer().call('check', { kind: 'query', payload });
    expect(checked).toMatchObject({ problems: [], description: { approval: { preview: true, remember: false }, types: ['database/main.orders'], effects: { mode: 'write', reads: ['database/main.orders'], writes: ['database/main.orders'], free: true }, parallelClaims: ['table:orders'] } });
    const preview = await hub.preview({ run: mintId('run'), fn: 'main.mark_paid', args: {}, user: TEST_USER, kind: 'database/query', payload });
    expect(preview).toMatchObject({ preview: { title: 'Change 2 rows in orders (Shop database)' } });
    // a write the hub sent with no approval is refused, and changes nothing
    expect(await hub.run('database/main.mark_paid', {}, { kind: 'database/query', payload })).toMatchObject({ status: 'failed', error: { message: 'This write needs the person to approve it first.' } });
    const unchanged = new BetterSqlite3(join(dir, 'shop.db'));
    expect(unchanged.prepare('SELECT count(*) AS n FROM orders WHERE status = \'open\'').get()).toEqual({ n: 2 });
    unchanged.close();
    if (proposal === undefined) throw new Error('no proposal');
    const approved = { by: TEST_USER.id, preview: proposal.preview };
    expect(done(await hub.run('database/main.mark_paid', {}, { kind: 'database/query', payload, approved }))).toMatchObject({ affected: 2 });
    const check = new BetterSqlite3(join(dir, 'shop.db'));
    expect(check.prepare('SELECT count(*) AS n FROM orders WHERE status = \'open\'').get()).toEqual({ n: 0 });
    check.close();

    // a write that returns rows: the rows it changed are attached read-only, carrying how many rows it changed
    const returning = { ...MARK_PAID, name: 'mark_shipped', title: 'Mark paid orders shipped', description: 'Marks every paid order as shipped, giving back the orders changed.', query: { kind: 'update', type: 'orders', set: { status: { kind: 'literal', value: 'shipped' } }, where: byStatus({ kind: 'literal', value: 'paid' }), returning: [{ expr: ref('orders', 'id'), as: 'id' }] } };
    expect((await keep(returning)).fn).toMatchObject({ name: 'database/main.mark_shipped' });
    const shippedPayload = hub.fns.kept.get('database/main.mark_shipped')?.saved.payload ?? null;
    const shipped = done(await hub.run('database/main.mark_shipped', {}, { kind: 'database/query', payload: shippedPayload, approved }));
    expect(shipped).toMatchObject({ affected: 4, returned: { rowCount: 4 } });
    expect(hub.attachments.at(-1)?.item).toMatchObject({ attachment: 'database/result', data: { write: { affected: 4 } } });
  });

  it('never saves a write on a read-only database, and refuses schema changes without schema allowed', async () => {
    dir = shopFile().dir;
    await start(shopConfig({ data: 'read-only', schema: 'none' }));
    const wipe = { name: 'wipe', title: 'Wipe', description: 'Deletes every order.', query: { kind: 'delete', from: 'orders' } };
    const script = [callTool('find_queries', { text: 'wipe' }), callTool('load_tables', { names: ['orders', 'customers'] }), callTool('draft', { draft: { ...wipe, args: {} } }), replyChunks('It cannot be done here.')];
    hub.onLlm = () => streamOf(script.shift() ?? replyChunks('Done.'));
    await hub.run('database/get_query', { detailedDescription: 'Delete every order.' });
    // the draft was refused for the read-only database, so save was never offered
    expect(JSON.stringify(hub.forwards.at(-1)?.request.messages)).toContain('read-only');
    expect((hub.forwards.at(-1)?.request.tools ?? []).map((tool) => tool.name)).not.toContain('save');
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
    await keep(ORDERS_BY_STATUS, { args: { status: 'paid' } });
    const payload = hub.fns.kept.get('database/main.orders_by_status')?.saved.payload ?? null;
    const cy = { ...TEST_USER, id: ActorId.parse('act_cy'), role: 'member' as const };
    const direct = await hub.run('database/main.orders_by_status', { status: 'paid' }, { kind: 'database/query', payload, run: hub.runInfo('database/main.orders_by_status', { user: cy }) });
    expect(direct).toMatchObject({ status: 'invalid-input' });
    expect(done(await hub.run('database/main.orders_by_status', { status: 'paid' }, { kind: 'database/query', payload, run: hub.runInfo('database/main.orders_by_status', { user: bo }) }))).toMatchObject({ total: 2 });
  });

  it('describes saved queries against the scanned tables while the types of a rescan reach the hub', async () => {
    dir = shopFile().dir;
    await start();
    await keep(ORDERS_BY_STATUS, { args: { status: 'paid' } });
    const payload = hub.fns.kept.get('database/main.orders_by_status')?.saved.payload ?? null;
    const described: unknown[] = [];
    afterPatch = async () => { described.push(await hub.peer().call('check', { kind: 'query', payload })); };
    await hub.configure(shopConfig({ label: 'Shop (renamed)' }));
    for (let wait = 0; described.length === 0 && wait < 200; wait += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); }
    expect(described[0]).toMatchObject({ problems: [], description: { args: { name: 'obj', props: { status: {} } }, effects: { mode: 'read' } } });
    // its example gives the param a sample value: every saved query shows how it is called
    const sample: unknown = expect.anything();
    const note: unknown = expect.stringContaining('Sample values for its params');
    expect(described[0]).toMatchObject({ description: { examples: [{ args: { status: sample }, note }] } });
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

  // the owner's chat sent these three to create_table: each failed deep in the DDL code, and the null one was put to
  // the person for approval before anything checked it
  it('create_table takes a gin obj row type, refuses the shapes models guessed as invalid input before anyone is asked, and asks once with the DDL', async () => {
    dir = shopFile().dir;
    await start();
    expect(hub.manifests[0]?.fns.find((item) => item.name === 'create_table')).toMatchObject({ approval: { preview: true, remember: false } });
    const todo = { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, title: { type: { name: 'text' } }, done: { type: { name: 'bool' } }, due: { type: { name: 'optional', generic: { T: { name: 'date' } } } } } };
    const preview = await hub.preview({ run: mintId('run'), fn: 'create_table', args: { table: 'Todo', database: 'main', type: todo }, user: TEST_USER });
    expect(preview).toMatchObject({ preview: { title: 'Create table Todo (Shop database)' } });
    expect(JSON.stringify(preview)).toContain('CREATE TABLE');
    expect(JSON.stringify(done(await hub.run('database/create_table', { table: 'Todo', database: 'main', type: todo })))).toContain('"database/main.Todo"');
    // the shapes the owner's model sent (a JSON string, a key/value list, null) and a column map are not gin types
    const guessed: Json[] = [
      '{"id":"string","title":"string","completed":"boolean","created_at":"datetime"}',
      [{ key: 'id', value: 'integer' }, { key: 'body', value: 'text' }],
      null,
      { id: 'integer', title: 'text' },
      { name: 'obj', props: { id: { type: { name: 'integer' } } } },
    ];
    for (const type of guessed) {
      const refused = await hub.run('database/create_table', { table: 'later', database: 'main', type });
      expect(refused.status, JSON.stringify(type)).toBe('invalid-input');
      expect(refused.status === 'invalid-input' ? refused.invalid.problems.map((problem) => problem.path) : []).toContainEqual(expect.stringMatching(/^type(\.|$)/));
    }
    // the right shape with no columns: refused when asked, before any approval
    expect(JSON.stringify(await hub.preview({ run: mintId('run'), fn: 'create_table', args: { table: 'empty', database: 'main', type: { name: 'obj' } }, user: TEST_USER }))).toContain('no columns');
  });

  // the chat describes queries in words; only the authoring agent writes query JSON
  it('refuses query JSON and other shapes a chat model sends to get_query, edit_query and run_query, by path, before the authoring agent is asked', async () => {
    dir = shopFile().dir;
    await start();
    await keep(ORDERS_BY_STATUS, { args: { status: 'paid' } });
    const problemsOf = async (fn: `${string}/${string}`, args: Json) => {
      const before = hub.forwards.length;
      const refused = await hub.run(fn, args);
      expect(refused.status, `${fn} ${JSON.stringify(args)}`).toBe('invalid-input');
      // nothing reached the authoring model
      expect(hub.forwards.length, `${fn} ${JSON.stringify(args)}`).toBe(before);
      return refused.status === 'invalid-input' ? refused.invalid.problems : [];
    };
    // (a query sent alongside the description is an unknown key, which the hub's strict check refuses before the system
    // sees it: scripts/tool-schemas.test.ts) a description that is not text, and none at all
    expect((await problemsOf('database/get_query', { detailedDescription: { text: 'paid orders' } })).map((problem) => problem.path)).toContain('detailedDescription');
    expect((await problemsOf('database/get_query', {})).map((problem) => problem.path)).toContain('detailedDescription');
    // an edit with the new query JSON in place of instructions, or without saying which query
    expect((await problemsOf('database/edit_query', { name: 'database/main.orders_by_status', instructions: ORDERS_BY_STATUS.query })).map((problem) => problem.path)).toContain('instructions');
    expect((await problemsOf('database/edit_query', { instructions: 'Also show the date.' })).map((problem) => problem.path)).toContain('name');
    // a saved query's args as a JSON string or a list of pairs, not the values by name
    for (const args of ['{"status":"paid"}', [{ name: 'status', value: 'paid' }]]) {
      const problems = await problemsOf('database/run_query', { fn: 'database/main.orders_by_status', args });
      expect(problems.map((problem) => problem.path), JSON.stringify(args)).toContain('args');
    }
  });

  it('alter_table changes a table to the whole gin obj row type it is given, previewing the steps, and refuses wrong shapes before anyone is asked', async () => {
    dir = shopFile().dir;
    await start();
    expect(hub.manifests[0]?.fns.find((item) => item.name === 'alter_table')).toMatchObject({ approval: { preview: true, remember: false } });
    const props = { id: { type: { name: 'num', options: { whole: true } } }, title: { type: { name: 'text' } } };
    expect(JSON.stringify(done(await hub.run('database/create_table', { table: 'Todo', database: 'main', type: { name: 'obj', props } })))).toContain('"database/main.Todo"');
    const wider = { name: 'obj', props: { ...props, priority: { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true } } } } } } };
    const args = { table: 'Todo', database: 'main', type: wider };
    const preview = await hub.preview({ run: mintId('run'), fn: 'alter_table', args, user: TEST_USER });
    expect(preview).toMatchObject({ preview: { title: 'Change table Todo (Shop database) (1 step)', irreversible: false } });
    expect(JSON.stringify(preview)).toContain('ALTER TABLE');
    expect(JSON.stringify(preview)).toContain('priority');
    const changed = done(await hub.run('database/alter_table', args));
    expect(JSON.stringify(changed)).toContain('"database/main.Todo"');
    const db = new BetterSqlite3(join(dir, 'shop.db'));
    expect(db.prepare("SELECT name FROM pragma_table_info('Todo')").pluck().all()).toEqual(['id', 'title', 'priority']);
    db.close();
    // the same type again has nothing to do, and a table that isn't there is create_table's: both said when asked
    expect(JSON.stringify(await hub.preview({ run: mintId('run'), fn: 'alter_table', args, user: TEST_USER }))).toContain('already matches');
    expect(JSON.stringify(await hub.preview({ run: mintId('run'), fn: 'alter_table', args: { ...args, table: 'Nope' }, user: TEST_USER }))).toContain('use create_table');
    // what models send for "add a priority column": only the new column, a column list, the type as a JSON string, a
    // prop whose type is a bare name: none is a gin obj row type
    const guessed: Json[] = [
      { priority: 'integer' },
      [{ name: 'priority', type: 'num' }],
      JSON.stringify(wider),
      { name: 'obj', props: { ...props, priority: { type: 'num' } } },
    ];
    for (const type of guessed) {
      const refused = await hub.run('database/alter_table', { table: 'Todo', database: 'main', type });
      expect(refused.status, JSON.stringify(type)).toBe('invalid-input');
      expect(refused.status === 'invalid-input' ? refused.invalid.problems.map((problem) => problem.path) : []).toContainEqual(expect.stringMatching(/^type(\.|$)/));
    }
  });

  it('holds back a breaking rescan for an admin, naming the saved queries the hub says read the table, and applies it once approved', async () => {
    dir = shopFile().dir;
    await start();
    await keep(ORDERS_BY_STATUS, { args: { status: 'paid' } });
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
