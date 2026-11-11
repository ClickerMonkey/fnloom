/**
 * Postgres and SQL Server for real, each when a server is given (`DATABASE_TEST_POSTGRES_URL`, and
 * `DATABASE_TEST_SQLSERVER` as `host:port:user:password`; Docker runs both); skipped otherwise. Per server: make the
 * shop's tables with the dialect's DDL writer, scan them into types (keys, foreign keys, check-constraint values),
 * read a page through a saved query with its total and a param, dry-run and run a write, and change a table from a
 * gin type.
 */
import { env } from '@ayepi/env';
import { InstanceName, Json } from '@harness/core';
import type { TableSpec } from '@aeye/query';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Connection } from '../shared/shapes.ts';
import { dialectFor } from './dialects.ts';
import { openDatabase, type Database } from './drivers/index.ts';
import { NO_ENRICHER, RecordingHub, shopConfig, testFolder } from './fixture.ts';
import { DatabaseInstance } from './instance.ts';
import { resultTable } from './results.ts';
import { MemoryStore } from './store.ts';

const live = env({
  DATABASE_TEST_POSTGRES_URL: z.string().min(1).optional(),
  DATABASE_TEST_SQLSERVER: z.string().regex(/^[^:]+:\d+:[^:]+:.+$/).optional(),
}).parse();

const CUSTOMERS: TableSpec = {
  name: 'customers', columns: [
    { name: 'id', type: { kind: 'integer' }, nullable: false, generated: true },
    { name: 'name', type: { kind: 'text', maxLength: 80 }, nullable: false },
    { name: 'tier', type: { kind: 'text', maxLength: 10 }, nullable: false, values: ['basic', 'gold'] },
  ], primaryKey: ['id'], foreignKeys: [], unique: [],
};
const ORDERS: TableSpec = {
  name: 'orders', columns: [
    { name: 'id', type: { kind: 'integer' }, nullable: false, generated: true },
    { name: 'customer_id', type: { kind: 'integer' }, nullable: false },
    { name: 'total', type: { kind: 'decimal', precision: 10, scale: 2 }, nullable: false },
    { name: 'status', type: { kind: 'text', maxLength: 20 }, nullable: false },
  ], primaryKey: ['id'], foreignKeys: [{ columns: ['customer_id'], table: 'customers', references: ['id'] }], unique: [],
};

interface Target {
  readonly name: string;
  readonly fields: z.input<typeof Connection>;
  /** Make an empty database to test in, and the connection to it. */
  prepare(): Promise<void>;
}

function sqlServerParts(value: string): { host: string; port: number; user: string; password: string } {
  const [host = '', port = '1433', user = '', ...rest] = value.split(':');
  return { host, port: Number(port), user, password: rest.join(':') };
}

const targets: Target[] = [];
if (live.DATABASE_TEST_POSTGRES_URL !== undefined) {
  const url = live.DATABASE_TEST_POSTGRES_URL;
  targets.push({
    name: 'postgres',
    fields: { kind: 'postgres', url },
    async prepare() {
      const db = openDatabase({ kind: 'postgres', url }, { dataDir: '.', readonly: false });
      await db.write([{ sql: 'DROP TABLE IF EXISTS notes, orders, customers CASCADE', params: [] }]);
      await db.close();
    },
  });
}
if (live.DATABASE_TEST_SQLSERVER !== undefined) {
  const parts = sqlServerParts(live.DATABASE_TEST_SQLSERVER);
  targets.push({
    name: 'sqlserver',
    fields: { kind: 'sqlserver', host: parts.host, port: parts.port, database: 'shop', user: parts.user, password: parts.password, encrypt: false },
    async prepare() {
      const master = openDatabase({ kind: 'sqlserver', ...parts, database: 'master', encrypt: false }, { dataDir: '.', readonly: false });
      await master.read({ sql: 'IF DB_ID(\'shop\') IS NOT NULL BEGIN ALTER DATABASE shop SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE shop END; CREATE DATABASE shop', params: [] });
      await master.close();
    },
  });
}

const ORDERS_BY_STATUS = Json.parse({
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
});

const opened: Array<DatabaseInstance | Database> = [];
afterAll(async () => { await Promise.all(opened.map((item) => item.close())); });

describe.skipIf(targets.length === 0)('live databases', () => {
  for (const target of targets) {
    it(`${target.name}: scans, reads a page, writes after a dry run, and changes a table`, async () => {
      await target.prepare();
      const ddl = dialectFor(target.name === 'postgres' ? 'postgres' : 'sqlserver').ddl;
      const instance = new DatabaseInstance(shopConfig({ connection: target.fields }), {
        instance: InstanceName.parse('main'), dataDir: testFolder(target.name), store: new MemoryStore(), enricher: NO_ENRICHER, hub: new RecordingHub(),
        limits: { page: 50, max: 500 }, distinctMax: 12, now: () => 1_000,
      });
      opened.push(instance);
      await instance.db.write([CUSTOMERS, ORDERS].flatMap((table) => ddl.createTable(table).sql.map((sql) => ({ sql, params: [] }))));
      await instance.db.write([
        { sql: 'INSERT INTO customers (name, tier) VALUES (\'Ada\', \'gold\'), (\'Bo\', \'basic\')', params: [] },
        { sql: 'INSERT INTO orders (customer_id, total, status) VALUES (1, 120.5, \'paid\'), (1, 80, \'open\'), (2, 15, \'paid\')', params: [] },
      ]);

      const report = await instance.rescan(undefined);
      expect([...report.added].sort()).toEqual(['customers', 'orders']);
      const orders = instance.catalog.spec('orders');
      expect(orders?.primaryKey).toEqual(['id']);
      expect(orders?.foreignKeys).toEqual([expect.objectContaining({ columns: ['customer_id'], table: 'customers', references: ['id'] })]);
      expect([...(instance.catalog.spec('customers')?.columns.find((column) => column.name === 'tier')?.values ?? [])].sort()).toEqual(['basic', 'gold']);
      expect(instance.catalog.table('customers')?.hubType.props?.['tier']?.type).toMatchObject({ name: 'enum' });

      const query = instance.compile({ instance: 'main', description: 'x', query: ORDERS_BY_STATUS, sorters: [], list: true });
      if (!('query' in query)) { throw new Error(query.report); }
      const plan = instance.plan(query, { status: 'paid', limit: 1 }, []);
      const table = resultTable(await instance.read(plan), query.columns, plan);
      expect(table).toMatchObject({ rows: [[1, 120.5, 'Ada']], total: 2, truncated: true });

      const update = instance.compile({ instance: 'main', description: 'x', sorters: [], list: false, query: Json.parse({ kind: 'update', type: 'orders', set: { status: 'paid' }, where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'orders', field: 'status' }, right: { kind: 'literal', value: 'open' } }] }) });
      if (!('query' in update)) { throw new Error(update.report); }
      const write = instance.plan(update, {}, []);
      expect((await instance.dryRun(write)).affected).toBe(1);
      expect((await instance.write(write)).affected).toBe(1);
      expect(resultTable(await instance.read(instance.plan(query, { status: 'paid' }, [])), query.columns, plan).total).toBe(3);

      const wanted = instance.tableFor('customers', { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, name: { type: { name: 'text', options: { maxLength: 80 } } }, tier: { type: { name: 'text', options: { maxLength: 10 } } }, phone: { type: { name: 'nullable', generic: { T: { name: 'text', options: { maxLength: 30 } } } } } } });
      const steps = ddl.alterTable(wanted.current ?? wanted.wanted, wanted.wanted);
      await instance.db.write(steps.flatMap((step) => step.sql.map((sql) => ({ sql, params: [] }))));
      const after = await instance.rescan(undefined);
      expect(after.changed).toEqual(['customers']);
      expect(instance.catalog.spec('customers')?.columns.map((column) => column.name)).toContain('phone');
    }, 60_000);
  }
});

