/**
 * The store's tables, derived from core's `HUB_TABLES`, the single source of truth for what the hub stores. Every
 * top-level field of a row schema becomes a column: scalars (strings, numbers, booleans, enums, literals) are plain
 * columns that can be filtered, ordered and indexed; everything else (objects, arrays, unions of mixed shapes, JSON)
 * is one JSON text column. A row whose schema is a union of objects (an `Actor`) gets the union of their fields.
 *
 * The same derivation runs at the type level (`ScalarKey`), so a filter, an order or an index on a field that isn't
 * a scalar column of the row doesn't compile, and renaming a field in core breaks every index declared on it.
 */
import { HUB_TABLES, type KeyOf, type RowOf, type TableName } from '@harness/core';
import { z } from 'zod';
import type { RowDef } from './codec.ts';
import { StoreError } from './errors.ts';

/** How a column is stored. `bool` is an integer 0/1; `json` is JSON text. */
export const ColumnKind = z.enum(['text', 'integer', 'real', 'bool', 'json']);
export type ColumnKind = z.infer<typeof ColumnKind>;

/** The column that holds a row's stored key (`TableDef.rowKey`). Never a row field. */
export const KEY_COLUMN = '_key';

/**
 * Whether a field's present values (`undefined` is an absent field) go in one scalar column, mirroring
 * `columnKind`: all strings, all numbers or all booleans. `null` and mixed unions (`string | number`) are stored as
 * JSON, so they aren't scalar.
 */
type IsScalar<T> = [T] extends [never] ? false : [T] extends [string] ? true : [T] extends [number] ? true : [T] extends [boolean] ? true : false;

/** The fields of a row stored as scalar columns: the ones that can be filtered, ordered and indexed. */
export type ScalarKey<Row> = {
  [K in keyof Row]-?: IsScalar<Exclude<Row[K], undefined>> extends true ? K : never;
}[keyof Row] &
  string;

/**
 * Every table's definition, by name, typed by its row and key: `TABLE_DEFS[name]` is a `RowDef<RowOf<K>, KeyOf<K>>` even when `name`
 * is a generic `K`, which indexing `HUB_TABLES` itself can't give.
 */
export type TableDefs = { readonly [K in TableName]: RowDef<RowOf<K>, KeyOf<K>> };
export const TABLE_DEFS: TableDefs = HUB_TABLES;

/** Whether a string names a table. */
export const isTableName = (name: string): name is TableName => Object.hasOwn(HUB_TABLES, name);

/** Every table name, in declaration order. */
export const TABLE_NAMES: readonly TableName[] = Object.keys(HUB_TABLES).filter(isTableName);

/** The indexes of one table: each is an ordered list of its scalar fields. */
export type IndexSpec<K extends TableName> = ReadonlyArray<readonly [ScalarKey<RowOf<K>>, ...Array<ScalarKey<RowOf<K>>>]>;

/**
 * The secondary indexes, chosen for the reads the hub's modules make (a session's messages in order, a turn's runs,
 * a user's notifications). Keys are primary keys already.
 */
export const TABLE_INDEXES: { readonly [K in TableName]?: IndexSpec<K> } = {
  memberships: [['user']],
  credentials: [['user']],
  authSessions: [['user']],
  actorSettings: [['actor']],
  policies: [['priority']],
  approvals: [['run'], ['status', 'createdAt']],
  pairings: [['name'], ['status', 'createdAt']],
  pairingTokens: [['expiresAt']],
  types: [['system']],
  kinds: [['system']],
  fns: [['system']],
  context: [['system']],
  sessions: [['owner', 'updatedAt'], ['updatedAt']],
  messages: [['session', 'createdAt'], ['turn']],
  turns: [['session', 'createdAt'], ['status']],
  runs: [['turn', 'createdAt'], ['parent'], ['root'], ['session', 'createdAt'], ['status'], ['fn', 'createdAt']],
  handlerCalls: [['run'], ['status']],
  stateFields: [['session', 'system']],
  deliveries: [['session', 'createdAt'], ['status']],
  llmInteractions: [['turn'], ['run'], ['session', 'queuedAt'], ['status']],
  resources: [['system']],
  sections: [['uri', 'version']],
  index: [['kind'], ['system'], ['embedder']],
  ledger: [['at'], ['actor', 'at'], ['session', 'at'], ['run']],
  notifications: [['user', 'createdAt'], ['user', 'read']],
  pushSubscriptions: [['user']],
  reservations: [['createdAt']],
  fnExamples: [['fn', 'order']],
  fnFacts: [['system'], ['kind'], ['mode']],
  fnTypes: [['type', 'use'], ['fn']],
  fnUses: [['uses'], ['fn']],
  fnVersions: [['fn', 'number']],
};

/** The columns of one table: field name → how it is stored. */
export type Layout = ReadonlyMap<string, ColumnKind>;

/** zod's number formats that only hold whole numbers (`z.number().int()` is `safeint`). */
const INTEGER_FORMATS: ReadonlySet<string> = new Set(['safeint', 'int32', 'uint32']);

/** The kind of column a field schema is stored in. */
export function columnKind(schema: z.core.$ZodType): ColumnKind {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault || schema instanceof z.ZodReadonly) {
    return columnKind(schema.unwrap());
  }
  // null must survive a round trip, and a scalar column's NULL means "absent"
  if (schema instanceof z.ZodNullable) return 'json';
  if (schema instanceof z.ZodNumber) return schema.format !== null && INTEGER_FORMATS.has(schema.format) ? 'integer' : 'real';
  if (schema instanceof z.ZodBoolean) return 'bool';
  if (schema instanceof z.ZodTemplateLiteral) return 'text';
  if (schema instanceof z.ZodEnum) return kindOfValues(schema.options);
  if (schema instanceof z.ZodLiteral) return kindOfValues([...schema.values]);
  if (schema instanceof z.ZodUnion) return sameKind(schema.options.map((option) => columnKind(option)));
  // every string format (`z.url()`, `z.email()`, …) has def type `string`, whatever its class
  if (schema._zod.def.type === 'string') return 'text';
  return 'json';
}

function kindOfValues(values: readonly unknown[]): ColumnKind {
  return sameKind(values.map((value): ColumnKind => {
    if (typeof value === 'string') return 'text';
    if (typeof value === 'boolean') return 'bool';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'real';
    return 'json';
  }));
}

function sameKind(kinds: readonly ColumnKind[]): ColumnKind {
  const [first, ...rest] = kinds;
  if (first === undefined) return 'json';
  if (rest.every((kind) => kind === first)) return first;
  // whole numbers and reals mix into reals
  if (kinds.every((kind) => kind === 'integer' || kind === 'real')) return 'real';
  return 'json';
}

/** The fields of a row schema with their kinds: an object's fields, or the union of a union's options' fields. */
export function layoutOf(table: string, row: z.core.$ZodType): Layout {
  const fields = new Map<string, ColumnKind[]>();
  for (const shape of objectShapes(table, row)) {
    for (const [field, schema] of Object.entries(shape)) {
      if (field === KEY_COLUMN) throw new StoreError('migration', `table ${table}: field ${KEY_COLUMN} is reserved for the key`);
      fields.set(field, [...(fields.get(field) ?? []), columnKind(schema)]);
    }
  }
  return new Map([...fields].map(([field, kinds]) => [field, sameKind(kinds)]));
}

function objectShapes(table: string, row: z.core.$ZodType): Array<Readonly<Record<string, z.core.$ZodType>>> {
  if (row instanceof z.ZodObject) return [row.shape];
  if (row instanceof z.ZodUnion) return row.options.flatMap((option) => objectShapes(table, option));
  throw new StoreError('migration', `table ${table}: a row schema must be an object or a union of objects`);
}

/** Every table's layout, derived once. */
const LAYOUTS = new Map<TableName, Layout>(TABLE_NAMES.map((name) => [name, layoutOf(name, HUB_TABLES[name].row)]));

/** The layout of a table. */
export function tableLayout(name: TableName): Layout {
  const layout = LAYOUTS.get(name);
  if (layout === undefined) throw new StoreError('migration', `unknown table ${name}`);
  return layout;
}

/** Whether a column kind can be filtered and ordered. */
export const isScalarKind = (kind: ColumnKind): boolean => kind !== 'json';

/** The declared indexes of a table, as plain column lists. */
export function tableIndexes(name: TableName): ReadonlyArray<readonly string[]> {
  return TABLE_INDEXES[name] ?? [];
}

/** The name of a secondary index: deterministic, so a migration can tell which ones it made. */
export const indexName = (table: string, columns: readonly string[]): string => `ix_${table}__${columns.join('__')}`;
