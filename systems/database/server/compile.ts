/**
 * A saved query against its database's table types: parsed and checked by `@aeye/query`, and everything the query
 * kind derives from it: the fn's args (its params, `limit` / `offset` when it is a list, `sort` from its sorters), its
 * result columns, the tables it reads and writes, whether it writes, and the SQL it runs for a call.
 */
import type { TypeDef as GinDef } from '@aeye/gin';
import {
  asFieldType, autoPaginate, canAutoPaginate, parseQueryRequest,
  type FieldTypeDef, type ParamInfo, type Query, type QueryDef, type QueryEngine, type SqlParamValue,
} from '@aeye/query';
import { GinTypeDef, type ColumnKind, type Json, type ResultColumn, type ResultSort } from '@harness/core';
import type { Dialect } from '@aeye/query';
import type { SortArg } from '../shared/shapes.ts';
import { enumValuesOf } from './types.ts';

/** A query that parsed and checked against its database's types. */
export interface CompiledQuery {
  readonly query: Query;
  /** Its JSON, as stored. */
  readonly def: QueryDef;
  /** Whether it inserts, updates or deletes rows. */
  readonly writes: boolean;
  /** Whether it pages with `limit` / `offset` (a read with no row bound of its own). */
  readonly list: boolean;
  /** Its params, as the engine reads them. */
  readonly params: readonly ParamInfo[];
  /** The tables it reads or writes (engine type names). */
  readonly tables: readonly string[];
  /** Its output columns. */
  readonly columns: readonly ResultColumn[];
}

/** Why a query was refused: one line per problem, and the engine's underlined report for the query agent. */
export interface Refusal {
  readonly problems: string[];
  readonly report: string;
}

/** The engine's field kind as a result column kind. */
function columnKindOf(def: FieldTypeDef | undefined): ColumnKind {
  switch (def?.kind) {
    case undefined: return 'json';
    case 'number': return def.whole === true ? 'integer' : 'number';
    case 'money': return 'number';
    case 'text': return 'text';
    case 'bool': return 'boolean';
    case 'date': return 'date';
    case 'timestamp': return 'datetime';
    case 'json': case 'array': case 'relation': return 'json';
  }
}

/** Check a query's JSON against the engine: the compiled query, or why not. */
export function compileQuery(engine: QueryEngine, json: unknown): CompiledQuery | Refusal {
  const parsed = parseQueryRequest(engine, { query: json });
  if (parsed.query === null || parsed.problems.hasErrors) {
    return { problems: parsed.problems.list.filter((problem) => problem.severity === 'error').map((problem) => problem.message), report: parsed.report };
  }
  const query = parsed.query;
  const def = query.toJSON();
  const affected = engine.affected(query).types.map((entry) => entry.type);
  const writes = def.kind === 'insert' || def.kind === 'update' || def.kind === 'delete' || affected.length > 0;
  const scope = engine.globalScope();
  const columns: ResultColumn[] = query.outputFields(engine, scope).map((field) => {
    const type = asFieldType(field.type)?.toJSON();
    return { name: field.name, kind: columnKindOf(type), nullable: field.nullable };
  });
  return {
    query,
    def,
    writes,
    list: !writes && canAutoPaginate(def) && !hasOwnLimit(def),
    params: engine.parameters(query),
    tables: [...new Set([...engine.references(query).types, ...affected])],
    columns,
  };
}

/** Whether a query bounds its own rows (`limit 10`), so callers don't page it. */
function hasOwnLimit(def: QueryDef): boolean {
  switch (def.kind) {
    case 'select': case 'union': case 'intersect': case 'except': return def.limit !== undefined;
    case 'cte': return hasOwnLimit(def.final);
    case 'insert': case 'update': case 'delete': case 'expr': return false;
  }
}

/** A param's gin type: its merged field type, as a value the caller passes (`json` for what has no closer type). */
export function ginOfField(def: FieldTypeDef | undefined): GinDef {
  switch (def?.kind) {
    case undefined: return { name: 'any' };
    case 'number': case 'money': {
      const options = def.kind === 'number' ? def : (def.number ?? {});
      if (options.values !== undefined) { return enumOf(options.values.map((value) => value.value), { name: 'num' }); }
      const bounds = { ...(options.min === undefined ? {} : { min: options.min }), ...(options.max === undefined ? {} : { max: options.max }), ...(options.whole === true ? { whole: true } : {}) };
      return Object.keys(bounds).length === 0 ? { name: 'num' } : { name: 'num', options: bounds };
    }
    case 'text': {
      if (def.values !== undefined) { return enumOf(def.values.map((value) => value.value), { name: 'text' }); }
      const bounds = { ...(def.minLength === undefined ? {} : { minLength: def.minLength }), ...(def.maxLength === undefined ? {} : { maxLength: def.maxLength }), ...(def.pattern === undefined ? {} : { pattern: def.pattern }) };
      return Object.keys(bounds).length === 0 ? { name: 'text' } : { name: 'text', options: bounds };
    }
    case 'bool': return { name: 'bool' };
    case 'date': return { name: 'date' };
    case 'timestamp': return { name: 'timestamp' };
    case 'array': return { name: 'list', generic: { V: ginOfField(def.item) } };
    case 'json': case 'relation': return { name: 'any' };
  }
}

/** A gin enum of values over a scalar. */
function enumOf(values: readonly (string | number)[], scalar: GinDef): GinDef {
  const members: Record<string, string | number> = {};
  for (const value of values) { members[String(value)] = value; }
  return { name: 'enum', generic: { V: scalar }, options: { values: members } };
}

/** The most rows one call reads, and the page size when the caller gives none. */
export interface PageLimits {
  readonly max: number;
  readonly page: number;
}

/** The args a saved query's fn takes: its params (all optional: a missing one binds NULL), then paging and sorting. */
export function argsTypeOf(compiled: CompiledQuery, sorters: readonly string[], limits: PageLimits): GinTypeDef {
  const props: Record<string, { type: GinDef; docs?: string }> = {};
  for (const param of compiled.params) {
    const type = ginOfField(param.type?.toJSON());
    const column = param.uses.find((use) => use.field !== undefined)?.field;
    props[param.name] = { type, ...(column === undefined ? {} : { docs: `Compared with ${column.type}.${column.field}.` }) };
  }
  if (compiled.list) {
    props['limit'] = { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true, min: 1, max: limits.max } } } }, docs: `How many rows (${limits.page} when empty).` };
    props['offset'] = { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true, min: 0 } } } }, docs: 'How many rows to skip, for the next page.' };
  }
  const sortable = sorters.filter((name) => compiled.columns.some((column) => column.name === name));
  if (sortable.length > 0 && compiled.def.kind === 'select') {
    props['sort'] = {
      type: { name: 'optional', generic: { T: { name: 'list', generic: { V: { name: 'obj', props: { column: { type: enumOf(sortable, { name: 'text' }) }, dir: { type: enumOf(['asc', 'desc'], { name: 'text' }) } } } } } } },
      docs: 'Sort by these columns, in order (the query\'s own order when empty).',
    };
  }
  return GinTypeDef.parse({ name: 'obj', props });
}

/** A gin def as a short type word for a signature (`text`, `num`, `"open" | "paid"`, `list<…>`). */
function typeWord(def: GinDef): string {
  switch (def.name) {
    case 'optional': case 'nullable': return typeWord(def.generic?.['T'] ?? { name: 'any' });
    case 'enum': return enumValuesOf(def).map((value) => JSON.stringify(value)).join(' | ');
    case 'list': return `list<${typeWord(def.generic?.['V'] ?? { name: 'any' })}>`;
    case 'obj': return `{ ${Object.entries(def.props ?? {}).map(([name, prop]) => `${name}: ${typeWord(prop.type)}`).join(', ')} }`;
    default: return def.name;
  }
}

/** A fn's one-line signature: `database/main.overdue(customer?: text, limit?: num, offset?: num)`. */
export function signatureOf(fn: string, args: GinTypeDef): string {
  const props = args.props ?? {};
  const parts = Object.entries(props).map(([name, prop]) => `${name}${prop.type.name === 'optional' || prop.type.name === 'nullable' ? '?' : ''}: ${typeWord(prop.type)}`);
  return `${fn}(${parts.join(', ')})`;
}

/** What one call runs: its SQL, the values bound, and the page and sort it reads. */
export interface CallPlan {
  readonly sql: string;
  readonly params: readonly Json[];
  readonly bound: Readonly<Record<string, Json>>;
  readonly offset: number;
  readonly limit: number | undefined;
  readonly sort: readonly ResultSort[];
  /** Whether the SQL has the engine's `$total` column (a counted list). */
  readonly counted: boolean;
}

/** The SQL for a call with these args. */
export function planCall(engine: QueryEngine, compiled: CompiledQuery, dialect: Dialect, args: Readonly<Record<string, Json>>, sort: SortArg, limits: PageLimits): CallPlan {
  const bound: Record<string, SqlParamValue> = {};
  for (const param of compiled.params) { bound[param.name] = args[param.name] ?? null; }
  let def: QueryDef = compiled.def;
  if (def.kind === 'select' && sort.length > 0) {
    def = { ...def, order: sort.map((entry) => ({ expr: { kind: 'output', name: entry.column }, dir: entry.dir })) };
  }
  let limit: number | undefined;
  let offset = 0;
  const pageable = def.kind === 'select' || def.kind === 'union' || def.kind === 'intersect' || def.kind === 'except' || def.kind === 'cte' ? def : undefined;
  if (compiled.list && pageable !== undefined) {
    const asked = args['limit'];
    limit = Math.min(typeof asked === 'number' ? asked : limits.page, limits.max);
    offset = typeof args['offset'] === 'number' ? args['offset'] : 0;
    def = autoPaginate(pageable);
    bound['limit'] = limit;
    bound['offset'] = offset;
  }
  const counted = compiled.list;
  const emitted = engine.toSQL(def, dialect, { params: bound, includeTotal: counted });
  return { sql: emitted.sql, params: emitted.params, bound, offset, limit, sort: sort.map((entry) => ({ column: entry.column, dir: entry.dir })), counted };
}
