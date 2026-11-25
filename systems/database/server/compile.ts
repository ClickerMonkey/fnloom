/**
 * A saved query against its database's table types: parsed and checked by `@aeye/query`, and everything the query
 * kind derives from it: the fn's args (its params, `limit` / `offset` when it is a list, `sort` from its sorters), its
 * result columns, the tables it reads and writes, whether it writes, and the SQL it runs for a call.
 */
import { createRegistry, type TypeDef as GinDef } from '@aeye/gin';
import {
  FieldRefExpr, SelectQuery, asFieldType, autoPaginate, canAutoPaginate, drillDown, parseQueryRequest,
  type FieldTypeDef, type ParamInfo, type Query, type QueryDef, type QueryEngine, type SelectDef, type SqlParamValue,
} from '@aeye/query';
import { checkGinValue, GinTypeDef, type ColumnKind, type Json, type ResultColumn, type ResultSort } from '@harness/core';
import type { Dialect } from '@aeye/query';
import type { SortArg } from '../shared/shapes.ts';
import { enumValuesOf } from './types.ts';

/** A query that parsed and checked against its database's types. */
export interface CompiledQuery {
  /** The engine it was checked against, which emits its SQL. */
  readonly engine: QueryEngine;
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
  // references also name subquery aliases (`from (…) as t`): only the engine's types are tables
  const tables = [...new Set([...engine.references(query).types, ...affected])].filter((table) => engine.type(table) !== undefined);
  // the parser leaves a source it can't resolve alone when nothing reads its fields (`count(*) from products`)
  const unknown = [...namedTypes(def)].filter((table) => engine.type(table) === undefined);
  if (unknown.length > 0) { return { problems: unknown.map((table) => `There is no table ${table} in this database.`), report: parsed.report }; }
  const writes = def.kind === 'insert' || def.kind === 'update' || def.kind === 'delete' || affected.length > 0;
  const scope = engine.globalScope();
  const roles = outputRoles(engine, query);
  const columns: ResultColumn[] = query.outputFields(engine, scope).map((field, index) => {
    const type = asFieldType(field.type)?.toJSON();
    return { name: field.name, kind: columnKindOf(type), nullable: field.nullable, ...roles[index] };
  });
  return {
    engine,
    query,
    def,
    writes,
    list: !writes && canAutoPaginate(def) && !hasOwnLimit(def),
    params: engine.parameters(query),
    tables,
    columns,
  };
}

/**
 * What a select's output columns are for, as only the query knows it: in a grouped select (a GROUP BY, or an aggregate
 * in its fields) a field holding an aggregate is a `measure` and any other a `group` key; in a plain select a field
 * that reads a table's primary key is the row's `key`. Other queries (a set operation, a CTE, a write) say nothing,
 * and the hub derives each column's role from its kind and values.
 */
function outputRoles(engine: QueryEngine, query: Query): ReadonlyArray<Pick<ResultColumn, 'role' | 'key'>> {
  if (!(query instanceof SelectQuery)) { return []; }
  const grouped = query.groupBy.length > 0 || query.fields.some((field) => field.expr.containsAggregate());
  return query.fields.map(({ expr }) => {
    if (grouped) { return { role: expr.containsAggregate() ? 'measure' : 'group' }; }
    if (!(expr instanceof FieldRefExpr)) { return {}; }
    // a source is named by its table's type (a join alias that names no table has no key here)
    const table = engine.type(expr.source);
    return table?.primaryKey().some((field) => field.name === expr.field) === true ? { key: true } : {};
  });
}

/** One group key of a drilled query: the output column carrying its value per row, and the param it pins. */
export interface DrillKey {
  readonly column: string;
  readonly param: string;
}

/** The query for the rows behind one group of a grouped read, and the group keys it pins. */
export interface DrillPlan {
  /** The un-ravelled select (`@aeye/query`'s `drillDown`), with no row bound of its own, so it pages. */
  readonly def: SelectDef;
  /** Its group keys, in the group-by's order (none for a bare aggregate: the rows behind the one total). */
  readonly keys: readonly DrillKey[];
}

/**
 * How a saved read's groups are drilled into (build-9 feedback): `drillDown` turns its grouped select into the select
 * for the rows behind one group, each group key pinned to a param. Undefined where it can't: a write, a set operation
 * or CTE, a select with no grouping, one `drillDown` refuses (a window function, a HAVING over an aggregate, an
 * aggregate with no field under it), or a group key the select doesn't output (a click would have no value for it).
 * The select's own LIMIT / OFFSET bound its groups, not the rows in one, so the drilled query drops them and pages.
 */
export function drillOf(compiled: CompiledQuery): DrillPlan | undefined {
  if (compiled.writes || !(compiled.query instanceof SelectQuery)) { return undefined; }
  const drilled = drillDown(compiled.query, compiled.engine);
  if ('error' in drilled) { return undefined; }
  const columns = new Set(compiled.columns.map((column) => column.name));
  if (drilled.params.some((param) => !columns.has(param.field))) { return undefined; }
  const unbounded: SelectDef = { ...drilled.query.toJSON() };
  delete unbounded.limit;
  delete unbounded.offset;
  return { def: unbounded, keys: drilled.params.map((param) => ({ column: param.field, param: param.name })) };
}

/** Every type a query reads from by name (`{ kind: 'type', type }` sources), at any depth. */
function namedTypes(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) { namedTypes(item, found); }
  } else if (typeof node === 'object' && node !== null) {
    if ('kind' in node && node.kind === 'type' && 'type' in node && typeof node.type === 'string') { found.add(node.type); }
    for (const value of Object.values(node)) { namedTypes(value, found); }
  }
  return found;
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

/**
 * The args a saved query's fn takes: its params, every one required unless `optional` names it (a missing required
 * param is refused as invalid input, never bound as NULL), then paging and sorting.
 */
export function argsTypeOf(compiled: CompiledQuery, sorters: readonly string[], limits: PageLimits, optional: readonly string[] = []): GinTypeDef {
  const props: Record<string, { type: GinDef; docs?: string }> = {};
  for (const param of compiled.params) {
    const given = ginOfField(param.type?.toJSON());
    // a generated fn's filters and changes may be left out (bound as NULL: no filter, no change)
    const type: GinDef = optional.includes(param.name) ? { name: 'optional', generic: { T: given } } : given;
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

/** The registry call args are checked with: they use only gin's built-in types. */
const ARGS_REGISTRY = createRegistry();

/**
 * What is wrong with a call's args for a saved query's fn (`argsTypeOf`), one line per problem; empty when they fit.
 * `run_query` takes args as any JSON, so they are checked here as the hub checks a direct call's: the shape (no
 * unknown args), then gin's own checks (whole numbers, ranges, choices).
 */
export function argProblems(type: GinTypeDef, args: Json): string[] {
  const missing = missingArgs(type, args);
  if (missing.length > 0) { return missing.map((name) => `${name} is required: give a value for it.`); }
  const parsed = ARGS_REGISTRY.parse(type);
  const shape = checkGinValue(parsed, args, { unknownKeys: 'refuse' });
  if (!shape.ok) { return shape.problems.map((problem) => (problem.path === '' ? problem.message : `${problem.path}: ${problem.message}`)); }
  try {
    parsed.parse(args);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** The required args (not optional or nullable) a call leaves out, in declaration order. */
export function missingArgs(type: GinTypeDef, args: Json): string[] {
  const given = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {};
  return Object.entries(type.props ?? {})
    .filter(([name, prop]) => prop.type.name !== 'optional' && prop.type.name !== 'nullable' && given[name] === undefined)
    .map(([name]) => name);
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
  /** The most rows the result keeps (`DATABASE_MAX_ROWS`): a query that isn't a list may read one more, to tell. */
  readonly cap: number;
}

/**
 * The SQL for a call with these args. A call's args were checked first (`argProblems`), so every param is given; a
 * param is bound as NULL only for the SQL shown without a call (a draft check, a saved fn's readable SQL).
 */
export function planCall(compiled: CompiledQuery, dialect: Dialect, args: Readonly<Record<string, Json>>, sort: SortArg, limits: PageLimits): CallPlan {
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
  } else if (pageable !== undefined && pageable.kind !== 'cte' && (pageable.limit === undefined || typeof pageable.limit === 'number')) {
    // a read that can't page (its own top-N, a union the engine can't page) still reads at most one past the cap
    def = { ...pageable, limit: Math.min(pageable.limit ?? limits.max + 1, limits.max + 1) };
  }
  const counted = compiled.list;
  const emitted = compiled.engine.toSQL(def, dialect, { params: bound, includeTotal: counted });
  return { sql: emitted.sql, params: emitted.params, bound, offset, limit, sort: sort.map((entry) => ({ column: entry.column, dir: entry.dir })), counted, cap: limits.max };
}

/** What a query does to data, for its fn's facts: the mode (`delete` for a DELETE), and the tables it reads and writes. */
export function effectsOf(compiled: CompiledQuery): { mode: 'read' | 'write' | 'delete'; reads: readonly string[]; writes: readonly string[] } {
  const { def } = compiled;
  switch (def.kind) {
    case 'insert': return { mode: 'write', reads: compiled.tables.filter((table) => table !== def.into), writes: [def.into] };
    case 'update': return { mode: 'write', reads: compiled.tables, writes: [def.type] };
    case 'delete': return { mode: 'delete', reads: compiled.tables, writes: [def.from] };
    case 'select': case 'union': case 'intersect': case 'except': case 'cte': case 'expr': return { mode: 'read', reads: compiled.tables, writes: [] };
  }
}
