/**
 * The mock hub's database system (build 5), for its admin pages: one instance, `shop`, on Postgres (its URL a kept
 * secret), its table types, its saved query fns, and a rescan's change that breaks a saved query, proposed for an
 * admin to approve with its type diff.
 */
import { ApprovalPreview, RunId, SECRET_KEPT, TypeRecord, type FnRecord, type Json, type GinTypeDef, type QualifiedName } from '@harness/core';
import { fixture } from './fixture.ts';
import { fnRecord } from '../src/admin/test/fakes.ts';

/** The run a rescan proposed: a change to `shop.Orders` that breaks a saved query, waiting for an admin. */
export const PROPOSED_CHANGE = RunId.parse('run_shop_rescan');

const text = { name: 'text' } as const;
const num = { name: 'num' } as const;
const nonEmpty = { name: 'text', options: { minLength: 1 } } as const;
const optional = (inner: GinTypeDef): GinTypeDef => ({ name: 'optional', generic: { T: inner } });
const choice = (...values: readonly string[]): GinTypeDef => ({ name: 'enum', generic: { V: text }, options: { values: Object.fromEntries(values.map((v) => [v, v])) } });

/** The database system's config type, as its contract sends it (`wireType` of `DatabaseConfig`). */
export const DATABASE_CONFIG_TYPE: GinTypeDef = {
  name: 'obj', props: {
    label: { docs: 'What this database is, as people and the model read it ("Shop orders").', type: nonEmpty },
    connection: {
      type: {
        name: 'obj', props: {
          kind: { docs: 'Which database: a new SQLite file, an existing SQLite file, Postgres or SQL Server.', type: choice('sqlite-new', 'sqlite-file', 'postgres', 'sqlserver') },
          path: { docs: 'SQLite: the file. For a new file, a name inside the instance\'s data folder (`shop.db`); for an existing one, its full path.', type: optional(nonEmpty) },
          url: { docs: 'Postgres: the connection URL (`postgres://user:password@host:5432/db`). Kept as a secret.', type: optional(nonEmpty) },
          host: { docs: 'SQL Server: the host name.', type: optional(nonEmpty) },
          port: { docs: 'SQL Server: the port (1433 when empty).', type: optional({ name: 'num', options: { whole: true, min: 1, max: 65535 } }) },
          database: { docs: 'SQL Server: the database name.', type: optional(nonEmpty) },
          user: { docs: 'SQL Server: the user name.', type: optional(nonEmpty) },
          password: { docs: 'SQL Server: the password. Kept as a secret.', type: optional(nonEmpty) },
          encrypt: { docs: 'SQL Server: encrypt the connection (on when empty).', type: optional({ name: 'bool' }) },
        },
      },
    },
    data: { docs: '`read-write` lets queries insert, update and delete rows, each only after the person approves it.', type: choice('read-only', 'read-write') },
    schema: { docs: '`allowed` lets the chat create and change tables from types, each only after approval.', type: choice('none', 'allowed') },
    enrich: {
      type: {
        name: 'obj', props: {
          on: { docs: 'Have a model refine each table\'s type (choices, formats, ranges, descriptions) when its schema changes.', type: { name: 'bool' } },
          model: { docs: 'The model for it (`openrouter/...`); the hub\'s default when empty.', type: optional(nonEmpty) },
        },
      },
    },
    audience: { docs: 'Who may use this database\'s query fns.', type: { name: 'obj', props: { visibility: { type: choice('private', 'shared', 'public') }, with: { type: { name: 'list', generic: { V: text } } } } } },
  },
};

/** The `shop` instance's config as the hub sends it: the Postgres URL is a kept secret. */
export const SHOP_CONFIG: Json = {
  label: 'Shop orders', connection: { kind: 'postgres', url: SECRET_KEPT }, data: 'read-write', schema: 'allowed',
  enrich: { on: true, model: 'openrouter/qwen/qwen3-coder:free' }, audience: { visibility: 'shared', with: [] },
};

const ORDERS_BEFORE: GinTypeDef = {
  name: 'obj', props: { id: { type: num }, customer_id: { type: num, docs: 'The customer (customers.id).' }, city: { type: text }, status: { type: text }, total: { type: num } },
};
const ORDERS_AFTER: GinTypeDef = {
  name: 'obj', props: {
    id: { type: num }, customer_id: { type: num, docs: 'The customer (customers.id).' }, city: { type: text }, state: { type: text }, total: { type: num }, refunded_at: { type: optional({ name: 'date' }) },
  },
};

/** The table types of the `shop` instance. */
export function shopTypes(now: number): TypeRecord[] {
  const type = (local: string, description: string, def: GinTypeDef): TypeRecord => fixture(TypeRecord, {
    name: `database/shop.${local}`, system: 'database', instance: 'shop', description, def, display: { label: local }, references: [], updatedAt: now - 3_600_000,
  });
  return [
    type('Orders', 'One order: who placed it, where it ships, its status and total.', ORDERS_BEFORE),
    type('Customers', 'A customer, with their contact details.', { name: 'obj', props: { id: { type: num }, name: { type: text }, email: { type: { name: 'text', options: { pattern: '^[^@\\s]+@[^@\\s]+$' } } }, city: { type: optional(text) } } }),
    type('OrderItems', 'One line of an order: the product and how many.', { name: 'obj', props: { order_id: { type: num }, product: { type: text }, quantity: { type: num }, price: { type: num } } }),
  ];
}

/** The saved query fns of the `shop` instance, routed to it. */
export function shopFns(now: number): FnRecord[] {
  const query = (local: string, description: string, query: Json, deps: readonly QualifiedName[], runs: number): FnRecord => fnRecord({
    name: `database/shop.${local}`, system: 'database', version: `v${runs}`, origin: 'runtime', available: true, paused: false, disabled: false, updatedAt: now - runs * 60_000,
    stats: { outcomes: { done: runs, 'invalid-input': 0, failed: 0, cancelled: 0 }, averageCost: 0, averageTime: 38 + runs, tokens: 0, lastRunAt: now - runs * 90_000 },
    decl: {
      ...fnRecord().decl, name: `shop.${local}`, description, kind: 'database/query', payload: { instance: 'shop', description, query, sorters: ['total', 'city'], list: true },
      args: { name: 'obj', props: { limit: { type: optional(num) }, offset: { type: optional(num) } } }, returns: { name: 'any' }, deps: [...deps],
      tags: ['database', 'query'], routing: { to: 'instance', instance: 'shop' },
    },
  });
  return [
    query('orders_by_city', 'Orders this month by city, most first.', { kind: 'select', from: 'Orders', groupBy: ['city'], select: { city: 'city', orders: { count: '*' } } }, ['database/shop.Orders'], 42),
    query('latest_orders', 'The newest orders with their customer.', { kind: 'select', from: 'Orders', join: ['Customers'], orderBy: [{ field: 'id', dir: 'desc' }] }, ['database/shop.Orders', 'database/shop.Customers'], 17),
    query('orders_export', 'Every order, every column, for the monthly export.', { kind: 'select', from: 'Orders' }, ['database/shop.Orders', 'database/shop.OrderItems'], 3),
  ];
}

/** What the rescan's proposed change would do. */
export const RESCAN_PREVIEW: ApprovalPreview = ApprovalPreview.parse({
  title: 'Apply a table change from the rescan',
  irreversible: true,
  parts: [
    { type: 'text', text: 'The `orders` table changed in the database: its `status` column is now `state`, and `refunded_at` is new.' },
    {
      type: 'type-diff', name: 'shop.Orders', before: ORDERS_BEFORE, after: ORDERS_AFTER,
      changes: ['Renames status to state', 'Adds refunded_at (an optional date)'],
      breaks: [{ fn: 'database/shop.orders_export', why: 'reads status, which is gone' }],
    },
  ],
});
