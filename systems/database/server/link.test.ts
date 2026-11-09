/**
 * The database system over the SDK's real link runtime and an in-memory hub, on a real SQLite file: the manifest
 * (fns, the query kind, the visuals registry, the secret config fields), get_query writing and keeping a query and
 * then reusing it through the decision model, running a saved query through its kind, edit_query keeping the old
 * version, a write proposed for the person's approval (with its preview) and run once approved, a schema change
 * previewed and applied, and a rescan whose breaking change waits for an admin.
 */
import { readFileSync } from 'node:fs';
import { InstanceName, SystemPackageManifest, mintId, type Json, type LlmForwardChunk, type OutcomeWire } from '@harness/core';
import type { AnyFnRef } from '@harness/sdk';
import { serve, type RunningSystem } from '@harness/sdk/server';
import { FakeHub, TEST_USER, streamOf } from '@harness/sdk/server/testing';
import BetterSqlite3 from 'better-sqlite3';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { database } from '../shared/index.ts';
import { LlmQueryAuthor } from './author.ts';
import { databaseEnv } from './env.ts';
import { NO_ENRICHER, RecordingHub, shopConfig, shopFile } from './fixture.ts';
import { SELF_FLEET, createDatabaseImpl, type DatabaseServer } from './impl.ts';
import { MemoryStore } from './store.ts';

const packageManifest = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8')));
const settings = databaseEnv.parse();

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

/** The model answers these texts in turn (the last one again after that). */
function answers(...texts: string[]): FakeHub['onLlm'] {
  let next = 0;
  return () => {
    const content = texts[Math.min(next, texts.length - 1)] ?? '';
    next += 1;
    const chunks: LlmForwardChunk[] = [
      { type: 'chunk', chunk: { content } },
      { type: 'chunk', chunk: { finishReason: 'stop' } },
      { type: 'done', usage: { input: 1, output: 1 }, cost: 0, interaction: mintId('llmInteraction'), model: 'test/model' },
    ];
    return streamOf(chunks);
  };
}

const ref = (source: string, field: string) => ({ kind: 'field-ref', source, field });
const byStatus = (status: { kind: 'param'; name: string } | { kind: 'literal'; value: string }) => [{ kind: 'comparison', op: '=', left: ref('orders', 'status'), right: status }];

/** The query agent's answer for "orders with a status, biggest first". */
const ORDERS_BY_STATUS = {
  name: 'orders_by_status', title: 'Orders by status', description: 'Orders with a given status, with their customer, biggest first.', sorters: ['total', 'customer'], args: { status: 'paid' },
  query: {
    kind: 'select',
    fields: [{ expr: ref('orders', 'id'), as: 'id' }, { expr: ref('orders', 'total'), as: 'total' }, { expr: ref('customers', 'name'), as: 'customer' }],
    from: { kind: 'type', type: 'orders' },
    joins: [{ on: { kind: 'relation', source: 'orders', field: 'customer', as: 'customers' }, joinType: 'inner' }],
    where: byStatus({ kind: 'param', name: 'status' }),
    order: [{ expr: ref('orders', 'total'), dir: 'desc' }],
  },
};

describe('the database system over the link', () => {
  let running: RunningSystem<'database'> | undefined;
  let hub: FakeHub;
  let server: DatabaseServer;
  let types: RecordingHub;
  let dir: string;

  const added = new Map<string, AnyFnRef>();

  async function start(store = new MemoryStore(), config = shopConfig()): Promise<void> {
    hub = new FakeHub({ config });
    types = new RecordingHub();
    server = createDatabaseImpl({
      settings, instance: InstanceName.parse('main'), dataDir: dir, store, fleet: SELF_FLEET,
      author: new LlmQueryAuthor({ retries: 2 }), enricher: NO_ENRICHER, hub: () => types, now: () => 1_000,
      runtime: () => (running === undefined ? undefined : {
        add: async (name, def) => { if (running !== undefined) { added.set(name, await running.add(name, def)); } },
        remove: async (name) => { const fn = added.get(name); if (fn !== undefined) { await running?.remove(fn); added.delete(name); } },
      }),
    });
    running = await serve(database, server.impl, { hub: 'ws://hub.test/link', state: 'unused', version: packageManifest.version }, hub.host());
    await running.ready();
    for (let wait = 0; server.current() === undefined && wait < 200; wait += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }

  afterEach(async () => {
    await running?.stop();
    await server.close();
    running = undefined;
  });

  it('declares its fns, the query kind, the visuals registry and its secret config fields', async () => {
    dir = shopFile().dir;
    await start();
    expect(database.name).toBe(packageManifest.name);
    const manifest = hub.manifests[0];
    expect(manifest?.kinds.map((item) => item.name)).toEqual(['query']);
    expect(manifest?.fns.map((item) => item.name).sort()).toEqual(['alter_table', 'apply_type_changes', 'change_schema', 'create_table', 'edit_on', 'edit_query', 'get_query', 'query_on']);
    expect(manifest?.fns.find((item) => item.name === 'change_schema')).toMatchObject({ approval: { preview: true, remember: false }, visibility: 'none' });
    expect(manifest?.registries?.map((item) => item.name)).toEqual(['query-visuals']);
    expect(manifest?.contributes?.map((item) => item.name)).toEqual(['table', 'bar', 'value']);
    expect(manifest?.configSecrets).toEqual(['connection.url', 'connection.password']);
    expect(types.upserts[0]?.sort()).toEqual(['main.customers', 'main.orders']);
  });

  it('writes and keeps a query, reuses it through the decision model, runs it by its kind, and edits it', async () => {
    dir = shopFile().dir;
    const store = new MemoryStore();
    await start(store);
    hub.onLlm = answers('Here you go:\n```json\n{"name":"broken","title":"x","description":"x","query":{"kind":"select","fields":[{"expr":{"kind":"field-ref","source":"orders","field":"ghost"}}],"from":{"kind":"type","type":"orders"}}}\n```', JSON.stringify(ORDERS_BY_STATUS));
    const created = done(await hub.run('database/get_query', { detailedDescription: 'Paid orders with their customer, biggest first.' }));
    expect(created).toMatchObject({
      database: { instance: 'main', label: 'Shop', dialect: 'sqlite' },
      fn: { name: 'database/main.orders_by_status', how: 'created' },
      query: { writes: false, params: { status: 'paid' } },
      result: { rowCount: 2, total: 2, truncated: false, sample: [{ id: 1, total: 120.5, customer: 'Ada' }, { id: 3, total: 15, customer: 'Bo' }] },
    });
    expect(JSON.stringify(created)).toContain('shown to the person');
    expect(hub.attachments.at(-1)?.item).toMatchObject({ attachment: 'database/result', data: { columns: [{ name: 'id' }, { name: 'total' }, { name: 'customer' }], rows: [[1, 120.5, 'Ada'], [3, 15, 'Bo']] } });
    expect(hub.patches.at(-1)?.upsert.fns?.[0]).toMatchObject({ name: 'main.orders_by_status', kind: 'database/query' });
    expect(hub.shares.at(-1)).toMatchObject({ fn: 'main.orders_by_status', share: { visibility: 'public' } });
    const signature = (await store.queries())[0];
    expect(signature?.payload).toMatchObject({ instance: 'main', list: true, sorters: ['total', 'customer'] });

    hub.onDecide = (request) => Promise.resolve({ by: 'decision', picked: [{ id: request.candidates[0]?.id ?? '', why: 'It lists orders by status.' }] });
    hub.onLlm = answers('{"status":"open"}');
    const reused = done(await hub.run('database/get_query', { detailedDescription: 'Open orders and who placed them' }));
    expect(reused).toMatchObject({ fn: { how: 'reused', why: 'It lists orders by status.' }, query: { params: { status: 'open' } }, result: { rowCount: 2 } });
    expect(hub.decisions.at(-1)?.candidates[0]).toMatchObject({ id: 'main.orders_by_status' });

    const payload = signature?.payload ?? null;
    const paged = done(await hub.run('database/main.orders_by_status', { status: 'paid', limit: 1, sort: [{ column: 'customer', dir: 'desc' }] }, { kind: 'database/query', payload }));
    expect(paged).toMatchObject({ rowCount: 1, total: 2, truncated: true, sort: [{ column: 'customer', dir: 'desc' }], sample: [{ customer: 'Bo' }], nextPage: { offset: 1, limit: 1 } });

    const edited = { ...ORDERS_BY_STATUS, args: { status: 'paid' }, query: { ...ORDERS_BY_STATUS.query, fields: [...ORDERS_BY_STATUS.query.fields, { expr: ref('orders', 'placed'), as: 'placed' }] } };
    hub.onLlm = answers(JSON.stringify(edited));
    const after = done(await hub.run('database/edit_query', { name: 'orders_by_status', instructions: 'Add when it was placed.' }));
    expect(after).toMatchObject({ fn: { how: 'edited' }, result: { columns: [{ name: 'id' }, { name: 'total' }, { name: 'customer' }, { name: 'placed', kind: 'date' }] } });
    expect((await store.queries())[0]?.history).toHaveLength(1);
    expect(await hub.run('database/edit_query', { name: 'main.nothing', instructions: 'x' })).toMatchObject({ status: 'invalid-input' });
  });

  it('proposes a write for the person, previews it, and runs it once approved', async () => {
    dir = shopFile().dir;
    await start();
    const markPaid = {
      name: 'mark_paid', title: 'Mark open orders paid', description: 'Marks every open order as paid.', sorters: [], args: {},
      query: { kind: 'update', type: 'orders', set: { status: 'paid' }, where: byStatus({ kind: 'literal', value: 'open' }) },
    };
    hub.onLlm = answers(JSON.stringify(markPaid));
    const answer = done(await hub.run('database/get_query', { detailedDescription: 'Mark all open orders as paid.' }));
    expect(answer).toMatchObject({ fn: { name: 'database/main.mark_paid', how: 'created' }, query: { writes: true }, approval: { state: 'waiting' } });
    expect(answer).not.toHaveProperty('result');
    const proposal = hub.proposals.at(-1);
    expect(proposal).toMatchObject({ fn: 'main.mark_paid', approver: 'person', preview: { title: 'Change 2 rows in orders', irreversible: false } });
    expect(proposal?.preview.parts.map((part) => part.type)).toEqual(['text', 'code', 'table']);
    const payload = hub.patches.at(-1)?.upsert.fns?.[0]?.payload ?? null;
    const checked = await hub.peer().call('check', { kind: 'query', payload });
    expect(checked).toMatchObject({ problems: [], description: { approval: { preview: true, remember: false }, types: ['database/main.orders'] } });
    const preview = await hub.preview({ run: mintId('run'), fn: 'main.mark_paid', args: {}, user: TEST_USER, kind: 'database/query', payload });
    expect(preview).toMatchObject({ preview: { title: 'Change 2 rows in orders' } });
    expect(done(await hub.run('database/main.mark_paid', {}, { kind: 'database/query', payload }))).toMatchObject({ affected: 2 });
    const check = new BetterSqlite3(join(dir, 'shop.db'));
    expect(check.prepare('SELECT count(*) AS n FROM orders WHERE status = \'open\'').get()).toEqual({ n: 0 });
    check.close();
  });

  it('never saves a write on a read-only database, and refuses schema changes without schema allowed', async () => {
    dir = shopFile().dir;
    const store = new MemoryStore();
    await start(store, shopConfig({ data: 'read-only', schema: 'none' }));
    hub.onLlm = answers(JSON.stringify({ name: 'wipe', title: 'Wipe', description: 'Deletes every order.', sorters: [], args: {}, query: { kind: 'delete', from: 'orders' } }));
    expect(await hub.run('database/get_query', { detailedDescription: 'Delete all orders.' })).toMatchObject({ status: 'invalid-input' });
    expect(await store.queries()).toEqual([]);
    expect(hub.proposals).toEqual([]);
    const args = { action: 'create', table: 'notes', database: 'main', type: { name: 'obj', props: { id: { type: { name: 'num' } } } } };
    expect(JSON.stringify(await hub.preview({ run: mintId('run'), fn: 'change_schema', args, user: TEST_USER }))).toContain('allow schema changes');
  });

  it('previews and makes a table from a type, and refuses one that exists', async () => {
    dir = shopFile().dir;
    await start();
    const args = { action: 'create', table: 'notes', database: 'main', type: { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, body: { type: { name: 'text' } } } } };
    const preview = await hub.preview({ run: mintId('run'), fn: 'change_schema', args, user: TEST_USER });
    expect(preview).toMatchObject({ preview: { title: 'Create table notes', irreversible: false } });
    expect(JSON.stringify(preview)).toContain('CREATE TABLE');
    const made = done(await hub.run('database/change_schema', args));
    expect(made).toMatchObject({ database: { instance: 'main' } });
    expect(JSON.stringify(made)).toContain('"database/main.notes"');
    expect(types.upserts.at(-1)).toContain('main.notes');
    expect(JSON.stringify(await hub.preview({ run: mintId('run'), fn: 'change_schema', args, user: TEST_USER }))).toContain('exists already');
  });

  it('holds back a breaking rescan for an admin, and applies it once approved', async () => {
    dir = shopFile().dir;
    const store = new MemoryStore();
    await start(store);
    hub.onLlm = answers(JSON.stringify(ORDERS_BY_STATUS));
    done(await hub.run('database/get_query', { detailedDescription: 'Paid orders with their customer.' }));
    const db = new BetterSqlite3(join(dir, 'shop.db'));
    db.exec('ALTER TABLE orders DROP COLUMN total');
    db.close();
    await hub.configure(shopConfig({ label: 'Shop (renamed)' }));
    for (let wait = 0; hub.proposals.length === 0 && wait < 200; wait += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); }
    const proposal = hub.proposals.at(-1);
    expect(proposal).toMatchObject({ fn: 'apply_type_changes', approver: 'admins', preview: { parts: [{ type: 'type-diff', name: 'database/main.orders', breaks: [{ fn: 'database/main.orders_by_status' }] }] } });
    const scan = (await store.pending())?.scan ?? '';
    expect(done(await hub.run('database/apply_type_changes', { scan }))).toMatchObject({ types: ['database/main.orders'] });
    expect(await hub.run('database/apply_type_changes', { scan })).toMatchObject({ status: 'invalid-input' });
  });
});
