/**
 * Generated fns for a table (`table_fns_available`, `table_fns_generate`). `@aeye/query`'s `tableFns` lists every fn a
 * table's columns, keys and relations make possible (CRUD, column helpers, relation-derived fields and normalized
 * comparisons), each a checked query with its args and signature; no model is involved, so the same tables always give
 * the same fns. Here they are checked against this instance's tables, marked with how they stand in the hub (new,
 * current, or made for an older schema), and kept as `database/query` fns of the instance (`hub/fns_save`), named
 * `<instance>.<table>_<name>`, with instructions and examples. Saving is idempotent by name: an unchanged fn is left
 * alone, a changed one becomes a new version (the hub keeps the old). A generated fn's payload records the op it was
 * built from and the table's schema hash, so its query is rebuilt from the tables as they are now (`refreshPayload`).
 */
import { TableFnError, tableFnQuery, tableFns, tableSchemaHash, type TableFn, type TableFnOp, type TableFnOptions, type TableSpec } from '@aeye/query';
import { Json, qualify, type FnExample } from '@harness/core';
import { canonicalJson, sampleArgs } from '@harness/sdk';
import { QUERY_KIND, database } from '../shared/index.ts';
import { QueryPayload, type GeneratedTableFn, type TableFnEntry, type TableFnGroup, type TableFnOpValue, type TableFnState, type TableFnsList } from '../shared/shapes.ts';
import { argsTypeOf, signatureOf } from './compile.ts';
import type { DatabaseInstance } from './instance.ts';
import type { QueryProblem, QueryRunCtx } from './queries.ts';
import { identifierOf, qualifiedTypeOf, tableRefOf } from './types.ts';

/** The tag every generated fn carries, beside `database`, `query` and its table. */
export const GENERATED_TAG = 'generated';

/** What listing needs from the run: the hub's saved queries as its person, and which of some names exist. */
export interface TableFnsReadCtx extends Pick<QueryRunCtx, 'getFn' | 'log'> {
  /** Which of these qualified fn names exist as saved queries (`hub/fns_search` by names). */
  existing(names: readonly string[]): Promise<Set<string>>;
}

/** What generating needs from the run: what listing needs, and saving fns in the hub as its person. */
export interface TableFnsCtx extends TableFnsReadCtx, Pick<QueryRunCtx, 'saveFn'> {}

/** The generators' tunables (`DATABASE_TABLE_FNS_DEPTH`, `DATABASE_TABLE_FNS_CAP`) and the paging every list uses. */
export interface TableFnLimits {
  readonly depth: number;
  readonly cap: number;
  readonly page: number;
  readonly max: number;
}

/** The hub's local name of a table's generated fn: `<instance>.<table>_<name>` (`main.projects_selectPage`). */
export function generatedLocal(instance: string, table: string, name: string): string {
  return `${instance}.${identifierOf(table)}_${name}`;
}

/** A stored op as `@aeye/query` takes it (its absent parts left out, not undefined). */
export function toTableFnOp(op: TableFnOpValue): TableFnOp {
  return {
    kind: op.kind,
    table: op.table,
    ...(op.column === undefined ? {} : { column: op.column }),
    ...(op.child === undefined ? {} : { child: op.child }),
    ...(op.bucket === undefined ? {} : { bucket: op.bucket }),
    ...(op.derived === undefined ? {} : { derived: op.derived }),
  };
}

/** A generated fn's examples: its required args with sample values, and for a list, the next page. */
function examplesOf(fn: TableFn): FnExample[] {
  const base = sampleArgs(fn.args);
  const first: FnExample = { args: base, note: Object.keys(base).length === 0 ? 'Every arg may be left out.' : 'Sample values: use real ones.' };
  return fn.list ? [first, { args: { ...base, limit: 20, offset: 20 }, note: 'The second page of 20.' }] : [first];
}

/** A generated fn's instructions: what it does, how to call it, and what a write waits for. */
function instructionsOf(fn: TableFn, label: string): string {
  const optional = fn.optional.length === 0 ? '' : ` Leave out ${fn.optional.join(', ')} for no filter (or, in a change, to keep the value).`;
  const writes = fn.mode === 'read'
    ? (fn.list ? ' Page with limit and offset; you get the columns, counts and first rows, and a person watching the chat is shown the rows too.' : ' You get the columns and rows it reads.')
    : ` It ${fn.mode === 'delete' ? 'deletes' : 'changes'} rows: every run waits for the person to approve it.`;
  return `${fn.about} Generated from the ${fn.table} table of the ${label} database; call it as ${fn.signature}.${optional}${writes}`;
}

/** The payload a generated fn is kept with. */
function payloadOf(instance: string, fn: TableFn, hash: string): QueryPayload {
  return QueryPayload.parse({
    instance,
    description: fn.about,
    query: Json.parse(fn.query),
    sorters: [...fn.sorters],
    list: fn.list,
    ...(fn.optional.length === 0 ? {} : { optional: [...fn.optional] }),
    generated: { op: Json.parse(fn.op), hash },
  });
}

/** One instance's generated table fns. */
export class TableFnService {
  readonly #limits: TableFnLimits;

  constructor(limits: TableFnLimits) {
    this.#limits = limits;
  }

  /** `table_fns_available`: the table's fns by group, marked as they stand in the hub, capped. */
  async list(instance: DatabaseInstance, table: string, ctx: TableFnsReadCtx): Promise<TableFnsList | QueryProblem> {
    const found = this.#table(instance, table);
    if ('invalid' in found) { return found; }
    const listed = tableFns(found.spec.name, found.specs, this.#options(this.#limits.cap));
    const usable = listed.fns.filter((fn) => this.#runs(instance, fn));
    const states = await this.#states(instance, usable, listed.hash, ctx);
    const groups: TableFnGroup[] = [];
    for (const fn of usable) {
      const entry: TableFnEntry = {
        name: fn.name, fn: qualify(database.name, generatedLocal(instance.instance, fn.table, fn.name)), about: fn.about,
        signature: fn.signature, mode: fn.mode, ...(states.get(fn.name) ?? { state: 'new' }),
      };
      const group = groups.find((known) => known.group === fn.group);
      if (group === undefined) { groups.push({ group: fn.group, fns: [entry] }); } else { group.fns.push(entry); }
    }
    return {
      database: instance.info, table: found.spec.name, type: qualifiedTypeOf(instance.instance, found.spec.name), hash: listed.hash, groups,
      more: listed.more + (listed.fns.length - usable.length),
    };
  }

  /** `table_fns_generate`: make or bring up to date the named fns; unchanged ones are left as they are. */
  async generate(instance: DatabaseInstance, table: string, names: readonly string[], derived: readonly string[], ctx: TableFnsCtx): Promise<GeneratedTableFn[] | QueryProblem> {
    const found = this.#table(instance, table);
    if ('invalid' in found) { return found; }
    const all = tableFns(found.spec.name, found.specs, this.#options(Number.MAX_SAFE_INTEGER));
    const unknown = names.filter((name) => !all.fns.some((fn) => fn.name === name));
    if (unknown.length > 0) { return { invalid: `${found.spec.name} has no generated fn ${unknown.join(', ')}: use the names table_fns_available lists.` }; }
    const made: TableFn[] = [];
    for (const name of new Set(names)) {
      const listed = all.fns.find((fn) => fn.name === name);
      if (listed === undefined) { continue; }
      let fn = listed;
      if (fn.kind === 'selectPage' && derived.length > 0) {
        try {
          fn = tableFnQuery({ ...fn.op, derived }, found.specs, this.#options(Number.MAX_SAFE_INTEGER));
        } catch (error) {
          if (error instanceof TableFnError) { return { invalid: error.message }; }
          throw error;
        }
      }
      const why = this.#whyNot(instance, fn);
      if (why !== undefined) { return { invalid: why }; }
      made.push(fn);
    }
    const local = (fn: TableFn) => generatedLocal(instance.instance, fn.table, fn.name);
    const existing = await ctx.existing(made.map((fn) => qualify(database.name, local(fn))));
    const out: GeneratedTableFn[] = [];
    for (const fn of made) {
      const name = qualify(database.name, local(fn));
      const payload = payloadOf(instance.instance, fn, all.hash);
      const compiled = instance.compile(payload);
      if (!('query' in compiled)) { return { failed: `${name} was generated but doesn't check: ${compiled.problems.join(' ')}` }; }
      const signature = signatureOf(name, argsTypeOf(compiled, payload.sorters, this.#limits, payload.optional));
      if (existing.has(name)) {
        const stored = await ctx.getFn(name);
        if (stored.payload !== undefined && canonicalJson(stored.payload) === canonicalJson(Json.parse(payload))) {
          out.push({ fn: name, signature, version: stored.version, status: 'unchanged' });
          continue;
        }
      }
      const saved = await ctx.saveFn({
        kind: QUERY_KIND, name: local(fn), payload: Json.parse(payload),
        description: fn.mode === 'read' ? fn.about : `${fn.about} (Writes: waits for approval.)`,
        instructions: instructionsOf(fn, instance.config.label),
        examples: examplesOf(fn),
        tags: ['database', 'query', GENERATED_TAG, identifierOf(fn.table), ...(fn.mode === 'read' ? [] : ['write'])],
        share: instance.config.audience,
        routing: { to: 'instance', instance: instance.instance },
        ...(existing.has(name) ? { replace: true } : {}),
      });
      ctx.log.info('database.generated', { fn: saved.fn, version: saved.version });
      out.push({ fn: saved.fn, signature, version: saved.version, status: saved.created ? 'created' : 'updated' });
    }
    return out;
  }

  /**
   * A saved query's payload as it runs now: a generated one is rebuilt from its op over the tables as they are, so a
   * schema change reaches it at once (its stored version is brought up to date by `table_fns_generate`). Any other
   * payload, or one whose table or columns are gone, is returned as it is, and its compile says what no longer fits.
   */
  refreshPayload(instance: DatabaseInstance, payload: QueryPayload): QueryPayload {
    if (payload.generated === undefined) { return payload; }
    const specs = instance.catalog.tables.map((table) => table.scanned.spec);
    try {
      const fn = tableFnQuery(toTableFnOp(payload.generated.op), specs, this.#options(Number.MAX_SAFE_INTEGER));
      return { ...payloadOf(instance.instance, fn, tableSchemaHash(fn.table, specs)), description: payload.description };
    } catch (error) {
      if (error instanceof TableFnError) { return payload; }
      throw error;
    }
  }

  #options(cap: number): TableFnOptions {
    return { depth: this.#limits.depth, cap, paging: { page: this.#limits.page, max: this.#limits.max } };
  }

  /** The table asked for (by name, local type name or qualified type), and every table's spec. */
  #table(instance: DatabaseInstance, table: string): { spec: TableSpec; specs: TableSpec[] } | { invalid: string } {
    const spec = instance.catalog.spec(tableRefOf(table).table);
    if (spec === undefined) {
      const names = instance.catalog.tables.map((known) => known.scanned.spec.name);
      const listed = names.length === 0 ? 'it has no tables yet' : `its tables are ${names.join(', ')}`;
      return { invalid: `There is no table ${table} in the ${instance.config.label} database: ${listed}. Give \`table\` as one of those names.` };
    }
    return { spec, specs: instance.catalog.tables.map((known) => known.scanned.spec) };
  }

  /** Whether a generated fn checks against this instance's tables, and may run here (a write only where writes are allowed). */
  #runs(instance: DatabaseInstance, fn: TableFn): boolean {
    return this.#whyNot(instance, fn) === undefined;
  }

  /**
   * Why a generated fn can't be made here, in words the model can act on: it writes rows where rows can only be read
   * (whatever schema changes are allowed), or it doesn't check against the tables as they are; undefined when it can.
   */
  #whyNot(instance: DatabaseInstance, fn: TableFn): string | undefined {
    if (fn.mode !== 'read' && !instance.writes) {
      const schema = instance.schemaChanges ? '; tables can still be made and changed there, but rows can\'t be added to them' : '';
      return `${fn.name} writes rows, and rows of the ${instance.config.label} database can only be read (an admin can allow row writes on the system's page)${schema}.`;
    }
    const compiled = instance.compile(payloadOf(instance.instance, fn, 'unchecked'));
    return 'query' in compiled ? undefined : `${fn.name} doesn't fit the ${fn.table} table as it is now: ${compiled.problems.join(' ')}`;
  }

  /** How each listed fn stands in the hub: absent (new), made for this schema (current), or for an older one (stale). */
  async #states(instance: DatabaseInstance, fns: readonly TableFn[], hash: string, ctx: TableFnsReadCtx): Promise<Map<string, { state: TableFnState; version?: number }>> {
    const byName = new Map<string, string>(fns.map((fn) => [qualify(database.name, generatedLocal(instance.instance, fn.table, fn.name)), fn.name]));
    const existing = await ctx.existing([...byName.keys()]);
    const states = new Map<string, { state: TableFnState; version?: number }>();
    for (const name of existing) {
      const stored = await ctx.getFn(name);
      const payload = QueryPayload.safeParse(stored.payload);
      const local = byName.get(name);
      if (local === undefined) { continue; }
      states.set(local, { state: payload.success && payload.data.generated?.hash === hash ? 'current' : 'stale', version: stored.version });
    }
    return states;
  }
}
