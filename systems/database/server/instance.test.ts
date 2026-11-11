/**
 * The database instance over a real SQLite file: scanning tables into types (keys, check-constraint enums, foreign
 * keys as relations), enrichment cached by schema hash, compiling and running queries (params, paging with a total,
 * sorting), the model's result block, a write and its dry run, rescans that patch or wait for an admin, and DDL from a
 * gin type.
 */
import { InstanceName, Json, QualifiedName, type FleetInstance } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseInstance } from './instance.ts';
import { argsTypeOf, signatureOf, type CompiledQuery } from './compile.ts';
import { shopInstance } from './fixture.ts';
import { resultBlock } from '@harness/sdk/server';
import { resultTable } from './results.ts';
import type { Enricher } from './author.ts';
import { HUB_FLEET } from './impl.ts';

const open: DatabaseInstance[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((instance) => instance.close())); });

function compiled(instance: DatabaseInstance, query: unknown): CompiledQuery {
  const result = instance.compile({ instance: 'main', description: 'test', query: Json.parse(query), sorters: [], list: true });
  if (!('query' in result)) { throw new Error(result.report); }
  return result;
}

const ORDERS_BY_STATUS = {
  kind: 'select',
  fields: [
    { expr: { kind: 'field-ref', source: 'orders', field: 'id' }, as: 'id' },
    { expr: { kind: 'field-ref', source: 'orders', field: 'total' }, as: 'total' },
    { expr: { kind: 'field-ref', source: 'customers', field: 'name' }, as: 'customer' },
  ],
  from: { kind: 'type', type: 'orders' },
  joins: [{ on: { kind: 'relation', source: 'orders', field: 'customer', as: 'customers' }, joinType: 'inner' }],
  where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'orders', field: 'status' }, right: { kind: 'param', name: 'status' } }],
  order: [{ expr: { kind: 'field-ref', source: 'orders', field: 'total' }, dir: 'desc' }],
};

describe('a SQLite database instance', () => {
  it('scans tables into hub types and engine types', async () => {
    const { instance, hub } = shopInstance();
    open.push(instance);
    const report = await instance.rescan(undefined);
    expect([...report.added].sort()).toEqual(['customers', 'orders']);
    expect(report.pending).toBeUndefined();
    expect(hub.upserts[0]?.sort()).toEqual(['main.customers', 'main.orders']);
    const customers = instance.catalog.table('customers');
    expect(customers?.hubType.props?.['tier']?.type).toMatchObject({ name: 'enum' });
    const decl = instance.catalog.typeDecls('Shop').find((item) => item.name === 'main.customers');
    expect(decl).toMatchObject({ instance: 'main', display: { title: 'name' } });
    expect(instance.catalog.describe()).toContain('orders');
  });

  it('compiles a query into args, a signature and SQL, and reads a page with its total', async () => {
    const { instance } = shopInstance();
    open.push(instance);
    await instance.rescan(undefined);
    const query = compiled(instance, ORDERS_BY_STATUS);
    expect(query.writes).toBe(false);
    expect(query.list).toBe(true);
    expect(query.columns.map((column) => column.name)).toEqual(['id', 'total', 'customer']);
    const args = argsTypeOf(query, ['total', 'customer'], { page: 50, max: 500 });
    const signature = signatureOf('database/main.orders_by_status', args);
    expect(signature).toContain('status');
    expect(signature).toContain('limit?: num');
    expect(signature).toContain('sort?:');

    const plan = instance.plan(query, { status: 'paid', limit: 1 }, []);
    const table = resultTable(await instance.read(plan), query.columns, plan);
    expect(table.rows).toEqual([[1, 120.5, 'Ada']]);
    expect(table).toMatchObject({ total: 2, truncated: true, offset: 0, limit: 1 });
    const model = resultBlock(table, { fn: { name: 'database/main.orders_by_status', signature }, args: { status: 'paid', limit: 1 }, budget: 400, cellChars: 200 });
    expect(model.shown).toContain('shown to the person');
    expect(model.nextPage).toMatchObject({ offset: 1, limit: 1 });
    expect(model.nextPage?.call).toContain('"offset":1');
    expect(model.sample).toEqual([{ id: 1, total: 120.5, customer: 'Ada' }]);

    const sorted = instance.plan(query, { status: 'paid' }, [{ column: 'customer', dir: 'desc' }]);
    expect(resultTable(await instance.read(sorted), query.columns, sorted).rows.map((row) => row[2])).toEqual(['Bo', 'Ada']);
  });

  it('refuses a query against a field that does not exist, with the engine report', async () => {
    const { instance } = shopInstance();
    open.push(instance);
    await instance.rescan(undefined);
    const result = instance.compile({ instance: 'main', description: 'x', query: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'orders', field: 'ghost' } }], from: { kind: 'type', type: 'orders' } }, sorters: [], list: true });
    expect('problems' in result && result.problems.join(' ')).toContain('ghost');
    // a table this database doesn't have, even when no field of it is read
    const count = instance.compile({ instance: 'main', description: 'x', query: { kind: 'select', fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' }], from: { kind: 'type', type: 'products' } }, sorters: [], list: true });
    expect('problems' in count && count.problems).toEqual(['There is no table products in this database.']);
  });

  it('dry-runs a write without changing anything, then writes it', async () => {
    const { instance } = shopInstance();
    open.push(instance);
    await instance.rescan(undefined);
    const update = compiled(instance, {
      kind: 'update', type: 'orders', set: { status: 'paid' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'orders', field: 'status' }, right: { kind: 'literal', value: 'open' } }],
    });
    expect(update.writes).toBe(true);
    expect(update.list).toBe(false);
    const plan = instance.plan(update, {}, []);
    expect((await instance.dryRun(plan)).affected).toBe(2);
    const count = compiled(instance, { kind: 'select', fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' }], from: { kind: 'type', type: 'orders' }, where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'orders', field: 'status' }, right: { kind: 'literal', value: 'open' } }] });
    const open1 = await instance.read(instance.plan(count, {}, []));
    expect(open1.rows[0]?.[0]).toBe(2);
    expect((await instance.write(plan)).affected).toBe(2);
    expect((await instance.read(instance.plan(count, {}, []))).rows[0]?.[0]).toBe(0);
  });

  it('enriches each table once per schema hash', async () => {
    let calls = 0;
    const enricher: Enricher = {
      enrich: (table) => {
        calls += 1;
        return Promise.resolve(table.spec.name === 'customers'
          ? { description: 'A shop customer.', columns: { email: { format: 'email', description: 'Where receipts go.' } } }
          : { description: 'An order.', columns: { status: { values: ['open', 'paid', 'refunded'] } } });
      },
    };
    const { instance, store, dir } = shopInstance({ config: { enrich: { on: true } }, enricher });
    open.push(instance);
    await instance.rescan(fakeLlm);
    expect(calls).toBe(2);
    const email = instance.catalog.table('customers')?.hubType.props?.['email'];
    expect(JSON.stringify(email)).toContain('@');
    expect(email?.docs).toContain('Where receipts go.');
    expect(instance.catalog.table('orders')?.hubType.props?.['status']?.type).toMatchObject({ name: 'enum' });
    const again = shopInstance({ config: { enrich: { on: true } }, enricher, store, dir });
    open.push(again.instance);
    await again.instance.rescan(fakeLlm);
    expect(calls).toBe(2);
  });

  it('leaves tables plain when the model refuses outside a run, and enriches them in the next run', async () => {
    let refuse = true;
    const enricher: Enricher = {
      enrich: () => (refuse ? Promise.reject(new Error('LLM calls from a system must be made inside a run.')) : Promise.resolve({ description: 'Shop data.', columns: {} })),
    };
    const { instance, hub } = shopInstance({ config: { enrich: { on: true } }, enricher });
    open.push(instance);
    await instance.rescan(fakeLlm);
    expect(hub.upserts[0]?.sort()).toEqual(['main.customers', 'main.orders']);
    expect(instance.catalog.table('orders')?.enrichment).toBeUndefined();
    refuse = false;
    expect(await instance.enrichLater(fakeLlm)).toBe(2);
    expect(hub.upserts.at(-1)?.sort()).toEqual(['main.customers', 'main.orders']);
    expect(instance.catalog.table('orders')?.enrichment?.description).toBe('Shop data.');
    expect(await instance.enrichLater(fakeLlm)).toBe(0);
  });

  it('patches compatible changes and holds back ones that break a saved query', async () => {
    const { instance, store, hub } = shopInstance();
    open.push(instance);
    await instance.rescan(undefined);
    // the hub knows which saved queries read a table
    hub.reading.set('database/main.orders', ['database/main.paid']);
    hub.reading.set('database/main.customers', ['database/main.paid']);
    await instance.db.write([{ sql: 'ALTER TABLE customers ADD COLUMN phone TEXT', params: [] }]);
    const added = await instance.rescan(undefined);
    expect(added.changed).toEqual(['customers']);
    expect(added.pending).toBeUndefined();
    await instance.db.write([{ sql: 'ALTER TABLE orders DROP COLUMN total', params: [] }]);
    const broken = await instance.rescan(undefined);
    expect(broken.pending?.tables.map((table) => table.spec.name)).toEqual(['orders']);
    expect(broken.parts[0]).toMatchObject({ type: 'type-diff', name: 'database/main.orders', breaks: [{ fn: 'database/main.paid' }] });
    expect(broken.parts[0]?.type === 'type-diff' && broken.parts[0].changes).toContain('Column total removed.');
    const scan = broken.pending?.scan ?? '';
    expect(await instance.applyPending('scan_other')).toHaveProperty('problem');
    expect(await instance.applyPending(scan)).toEqual({ applied: ['main.orders'], removed: [] });
    expect(hub.upserts.at(-1)).toEqual(['main.orders']);
    expect(await store.pending()).toBeUndefined();
  });

  it('plans CREATE TABLE and ALTER TABLE from a gin type', async () => {
    const { instance } = shopInstance();
    open.push(instance);
    await instance.rescan(undefined);
    const made = instance.tableFor('notes', { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, body: { type: { name: 'text' } }, customer: { type: { name: 'main.customers' } } } });
    expect(made.current).toBeUndefined();
    const create = instance.catalog.dialect.ddl.createTable(made.wanted);
    expect(create.sql.join(' ')).toContain('CREATE TABLE');
    expect(made.wanted.foreignKeys).toEqual([expect.objectContaining({ table: 'customers' })]);
    await instance.db.write(create.sql.map((sql) => ({ sql, params: [] })));
    await instance.rescan(undefined);
    const changed = instance.tableFor('notes', { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, body: { type: { name: 'text' } }, pinned: { type: { name: 'optional', generic: { T: { name: 'bool' } } } } } });
    const steps = instance.catalog.dialect.ddl.alterTable(changed.current ?? changed.wanted, changed.wanted);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) { await instance.db.write(step.sql.map((sql) => ({ sql, params: [] }))); }
    const after = await instance.rescan(undefined);
    expect(after.changed).toEqual(['notes']);
    expect(instance.catalog.spec('notes')?.columns.map((column) => column.name)).toEqual(['id', 'body', 'pinned']);
  });
});

/** A model the enricher never really calls (the test's enricher answers itself). */
const fakeLlm = {
  text: () => Promise.reject(new Error('unused')),
  object: () => Promise.reject(new Error('unused')),
  stream: () => { throw new Error('unused'); },
  embed: () => Promise.resolve([]),
  image: () => Promise.reject(new Error('unused')),
  transcribe: () => Promise.reject(new Error('unused')),
  speak: () => Promise.reject(new Error('unused')),
};

describe('the fleet as the hub lists it', () => {
  it('describes every online, configured instance by its label and table types, this one included', async () => {
    const member = (instance: string, online: boolean, config: Json, types: FleetInstance['types']): FleetInstance => ({ instance: InstanceName.parse(instance), description: '', online, config, types });
    const audience = { visibility: 'public', with: [] };
    const listed = [
      member('shop', true, { label: 'Shop', audience }, [{ name: QualifiedName.parse('database/shop.customers'), description: 'Customers. Columns: id, name.' }]),
      member('stock', false, { label: 'Stock', audience }, [{ name: QualifiedName.parse('database/stock.products'), description: 'Products.' }]),
      member('fresh', true, null, []),
    ];
    const members = await HUB_FLEET.members({ instance: 'shop', label: 'Shop', tables: [] }, { fleet: () => Promise.resolve(listed) });
    expect(members).toEqual([{ instance: 'shop', label: 'Shop', audience, tables: ['customers (Customers. Columns: id, name.)'] }]);
  });
});
