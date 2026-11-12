/**
 * One database instance: its connection, its tables as types, and running queries against it. Nothing here knows
 * the link: the implementation (`impl.ts`) hands it the hub's side through `HubSide` and the run's model calls.
 *
 * - **Scan** (`scan`, on configure and start): read the schema, enrich new and changed tables and rebuild the query
 *   engine, so saved queries can be checked and described against it. A table's enrichment is kept with its type in
 *   the hub (`TableMeta`, by schema hash), so a model enriches a schema once and the system keeps no store.
 * - **Publish** (`publish`, right after): work out what changed since the table types the hub keeps for this
 *   instance (read from the hub each time, so nothing here remembers them). New tables and changes no saved query
 *   minds go to the hub straight away; a dropped table, or a change that breaks a saved query, waits for an admin as
 *   pending changes (with a type diff per table). `rescan` does both.
 * - **Waiting changes** are the only thing an instance holds, in memory: every publish works them out again.
 * - **Run** (`read`, `write`, `dryRun`): a saved query's payload and a call's args become SQL for this dialect.
 */
import { ginTypeToTable, type TableSpec } from '@aeye/query';
import { createHash } from 'node:crypto';
import { Timestamp, type GinTypeDef, type InstanceName, type Json, type PreviewPart, type QualifiedName, type TypeDecl } from '@harness/core';
import type { Llm } from '@harness/sdk';
import { Connection, dialectOf, type DatabaseConfig, type DatabaseInfo, type QueryPayload, type SortArg } from '../shared/shapes.ts';
import type { Enricher } from './author.ts';
import { TableCatalog } from './catalog.ts';
import { compileQuery, planCall, type CallPlan, type CompiledQuery, type PageLimits, type Refusal } from './compile.ts';
import { openDatabase, type Database, type Rows, type Written } from './drivers/index.ts';
import { z } from 'zod';
import { ScannedTable, schemaHash } from './schema.ts';
import { hubTypeOf, identifierOf, qualifiedTypeOf, typeNameOf, type KeptType, type TableEnrichment } from './types.ts';

/** A table type change a rescan found that waits for an admin, with the scan it came from. */
export const PendingChanges = z.object({
  scan: z.string().min(1),
  /** The tables as scanned (each one changed or new). */
  tables: z.array(ScannedTable),
  /** Tables that are gone, by name. */
  dropped: z.array(z.string()),
  foundAt: Timestamp,
});
export type PendingChanges = z.infer<typeof PendingChanges>;

/** The hub's side of an instance's types. */
export interface HubSide {
  /** Add or replace these table types, and take these away (local names). */
  types(upsert: readonly TypeDecl[], remove: readonly string[]): Promise<void>;
  /** The table types the hub keeps for this instance now, by local name (`main.orders`), with their definitions and meta. */
  known(): Promise<ReadonlyMap<string, KeptType>>;
  /**
   * The saved query fns of this instance that read a table type (`database/main.orders`), found in the hub's database
   * (`searchFns` by kind, instance and the types they read).
   */
  readers(type: QualifiedName): Promise<string[]>;
}

/**
 * Whether a table's new shape keeps every query of the old one working: each old column is still there with the same
 * type and nullability (an optional column may become required only the other way), any closed set of values only
 * grows, and the keys are the same. Added columns are fine.
 */
export function widens(before: TableSpec, after: TableSpec): boolean {
  const has = new Map(after.columns.map((column) => [column.name, column]));
  const keys = JSON.stringify(before.primaryKey) === JSON.stringify(after.primaryKey) && JSON.stringify(before.foreignKeys) === JSON.stringify(after.foreignKeys);
  return keys && before.columns.every((old) => {
    const now = has.get(old.name);
    if (now === undefined || JSON.stringify(now.type) !== JSON.stringify(old.type) || (old.nullable && !now.nullable)) { return false; }
    return old.values === undefined ? now.values === undefined : now.values === undefined || old.values.every((value) => now.values?.includes(value) === true);
  });
}

/** Whether two shapes of a table hold the same columns, types and keys (each widens the other). */
function sameShape(a: TableSpec, b: TableSpec): boolean {
  return a.columns.length === b.columns.length && widens(a, b) && widens(b, a);
}

/**
 * The table a type the hub keeps describes, with the physical details (keys, defaults) of the table as scanned, so
 * only what the type says (columns, their types, nullability) is compared. `undefined` when it isn't a table's type.
 */
function keptSpec(current: TableSpec, kept: GinTypeDef): TableSpec | undefined {
  try {
    return ginTypeToTable(current.name, kept, { current });
  } catch {
    return undefined;
  }
}

/** A rescan's id from the changes it found: the same waiting changes always get the same id (and so one proposal). */
function scanId(tables: readonly ScannedTable[], dropped: readonly string[]): string {
  const changes = JSON.stringify([tables.map((table) => schemaHash(table.spec)).sort(), [...dropped].sort()]);
  return `scan_${createHash('sha256').update(changes).digest('hex').slice(0, 16)}`;
}

/** What a rescan found. */
export interface ScanReport {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  /** Changes that wait for an admin (a dropped table, or one that breaks saved queries). */
  readonly pending: PendingChanges | undefined;
  /** The type diff of each waiting change, for the approval. */
  readonly parts: readonly PreviewPart[];
}

/** The sample and value sets the enricher reads for one table. */
export interface TableProfile {
  readonly sample: Rows;
  readonly distinct: Readonly<Record<string, readonly string[]>>;
}

/** What an instance is built from. */
export interface InstanceDeps {
  readonly instance: InstanceName;
  readonly dataDir: string;
  readonly enricher: Enricher;
  readonly hub: HubSide;
  readonly limits: PageLimits;
  /** Distinct values a text column may have for the enricher to see them all. */
  readonly distinctMax: number;
  readonly now: () => number;
  /** Opens the database; the drivers by default (tests may pass their own). */
  readonly open?: (connection: Connection, options: { dataDir: string; readonly: boolean }) => Database;
}

/** Words for how a table changed between two scans. */
export function changeWords(before: TableSpec | undefined, after: TableSpec | undefined): string[] {
  if (before === undefined && after !== undefined) { return [`New table with ${after.columns.length} columns.`]; }
  if (after === undefined) { return ['The table is gone.']; }
  if (before === undefined) { return []; }
  const had = new Map(before.columns.map((column) => [column.name, column]));
  const has = new Map(after.columns.map((column) => [column.name, column]));
  const words: string[] = [];
  for (const column of after.columns) {
    const old = had.get(column.name);
    if (old === undefined) { words.push(`Column ${column.name} added.`); continue; }
    if (JSON.stringify(old.type) !== JSON.stringify(column.type)) { words.push(`Column ${column.name} changed type from ${old.type.kind} to ${column.type.kind}.`); }
    if (old.nullable !== column.nullable) { words.push(`Column ${column.name} is ${column.nullable ? 'now optional' : 'now required'}.`); }
    if (JSON.stringify(old.values ?? null) !== JSON.stringify(column.values ?? null)) { words.push(`Column ${column.name} allows ${column.values === undefined ? 'any value' : `only ${column.values.join(', ')}`}.`); }
  }
  for (const column of before.columns) { if (!has.has(column.name)) { words.push(`Column ${column.name} removed.`); } }
  if (JSON.stringify(before.primaryKey) !== JSON.stringify(after.primaryKey)) { words.push(`Primary key is now ${after.primaryKey.join(', ') || 'none'}.`); }
  if (JSON.stringify(before.foreignKeys) !== JSON.stringify(after.foreignKeys)) { words.push('Foreign keys changed.'); }
  return words.length === 0 ? ['Constraints changed.'] : words;
}

/** A connected database instance. */
export class DatabaseInstance {
  readonly config: DatabaseConfig;
  readonly connection: Connection;
  readonly db: Database;
  readonly #deps: InstanceDeps;
  #catalog: TableCatalog;
  /** The table shapes the hub's types were made from, by table name, as the last publish found them. */
  #applied = new Map<string, TableSpec>();
  /** The changes the last publish left waiting for an admin (worked out again by every publish, so never kept). */
  #pending: PendingChanges | undefined;
  /**
   * Tables whose enrichment couldn't run yet: the hub only takes a system's model calls inside a run, so a scan at
   * start or configure (outside any run) leaves them plain, and the next run on this database enriches them.
   */
  readonly #unenriched = new Set<string>();

  constructor(config: DatabaseConfig, deps: InstanceDeps) {
    this.config = config;
    this.#deps = deps;
    this.connection = Connection.parse(config.connection);
    const readonly = config.data === 'read-only' && config.schema === 'none';
    this.db = (deps.open ?? openDatabase)(this.connection, { dataDir: deps.dataDir, readonly });
    this.#catalog = new TableCatalog(deps.instance, dialectOf(this.connection.kind), [], new Map());
  }

  get instance(): InstanceName {
    return this.#deps.instance;
  }

  get catalog(): TableCatalog {
    return this.#catalog;
  }

  /** The database as the model reads it. */
  get info(): DatabaseInfo {
    return { instance: this.instance, label: this.config.label, dialect: this.#catalog.dialectName };
  }

  /** Whether queries may write and tables may change. */
  get writes(): boolean {
    return this.config.data === 'read-write';
  }

  get schemaChanges(): boolean {
    return this.config.schema === 'allowed';
  }

  /** Read the schema again and tell the hub; see the file's docs. `llm` makes enrichment possible (when it is on). */
  async rescan(llm: Llm | undefined): Promise<ScanReport> {
    await this.scan(llm);
    return await this.publish();
  }

  /** Read the schema, enrich it and rebuild the query engine; the hub is not told (`publish` does that). */
  async scan(llm: Llm | undefined): Promise<void> {
    const scanned = await this.db.schema();
    const kept = await this.#keptEnrichments();
    // the enricher reads samples through a plain catalog of the tables as they are
    const plain = new TableCatalog(this.instance, dialectOf(this.connection.kind), scanned, new Map());
    const enrichments = new Map<string, TableEnrichment>();
    for (const table of scanned) {
      const enrichment = kept.get(schemaHash(table.spec)) ?? await this.#enrichment(table, plain, llm);
      if (enrichment !== undefined) { enrichments.set(schemaHash(table.spec), enrichment); }
    }
    this.#catalog = new TableCatalog(this.instance, dialectOf(this.connection.kind), scanned, enrichments);
  }

  /** Compare the scanned tables with the table types the hub keeps for this instance; see the file's docs. */
  async publish(): Promise<ScanReport> {
    const known = await this.#deps.hub.known();
    const applied = new Map<string, TableSpec>();
    const added: string[] = [];
    const changed: string[] = [];
    const waiting: ScannedTable[] = [];
    const parts: PreviewPart[] = [];
    const upsert: TypeDecl[] = [];
    const decls = new Map(this.#catalog.typeDecls(this.config).map((decl) => [decl.name, decl]));
    for (const table of this.#catalog.tables) {
      const spec = table.scanned.spec;
      const decl = decls.get(table.typeName);
      if (decl === undefined) { continue; }
      const kept = known.get(table.typeName);
      const before = kept === undefined ? undefined : keptSpec(spec, kept.def);
      if (before === undefined) { added.push(spec.name); upsert.push(decl); applied.set(spec.name, spec); continue; }
      if (sameShape(before, spec)) { upsert.push(decl); applied.set(spec.name, spec); continue; }
      // only a change that narrows the table can break a saved query; the hub knows which saved queries read it
      const breaks = widens(before, spec) ? [] : (await this.#deps.hub.readers(qualifiedTypeOf(this.instance, spec.name)))
        .map((fn) => ({ fn, why: `It reads ${spec.name}: ${changeWords(before, spec).join(' ')}` }));
      if (breaks.length === 0) { changed.push(spec.name); upsert.push(decl); applied.set(spec.name, spec); continue; }
      // the hub keeps the type it has until an admin applies the change
      waiting.push(table.scanned);
      applied.set(spec.name, before);
      parts.push({ type: 'type-diff', name: qualifiedTypeOf(this.instance, spec.name), before: kept?.def ?? hubTypeOf(before), after: table.hubType, changes: changeWords(before, spec), breaks });
    }
    // a type the hub keeps for this instance with no table behind it any more is a dropped table's
    const present = new Set(this.#catalog.tables.map((table) => table.typeName));
    const prefix = `${this.instance}.`;
    const dropped = [...known.keys()].filter((name) => name.startsWith(prefix) && !present.has(name)).map((name) => name.slice(prefix.length));
    for (const name of dropped) {
      const before = known.get(typeNameOf(this.instance, name))?.def;
      const breaks = (await this.#deps.hub.readers(qualifiedTypeOf(this.instance, name))).map((fn) => ({ fn, why: `It reads ${name}, which is gone.` }));
      parts.push({ type: 'type-diff', name: qualifiedTypeOf(this.instance, name), ...(before === undefined ? {} : { before }), changes: changeWords(undefined, undefined), breaks });
    }
    await this.#deps.hub.types(upsert, []);
    this.#applied = applied;
    const pending = waiting.length === 0 && dropped.length === 0 ? undefined : { scan: scanId(waiting, dropped), tables: waiting, dropped, foundAt: this.#deps.now() };
    this.#pending = pending;
    return { added, changed, pending, parts };
  }

  /**
   * Enrich the tables a scan outside a run had to leave plain, with a run's model, and send their types again. Only
   * tables whose type the hub has as they are now (not ones waiting for an admin) are sent. Returns how many.
   */
  async enrichLater(llm: Llm): Promise<number> {
    if (this.#unenriched.size === 0) { return 0; }
    const scanned = this.#catalog.tables.map((table) => table.scanned);
    const plain = new TableCatalog(this.instance, dialectOf(this.connection.kind), scanned, new Map());
    const enrichments = new Map<string, TableEnrichment>();
    const done = new Set<string>();
    for (const table of this.#catalog.tables) {
      const name = table.scanned.spec.name;
      const enrichment = this.#unenriched.has(name) ? await this.#enrichment(table.scanned, plain, llm) : table.enrichment;
      if (enrichment !== undefined) { enrichments.set(table.hash, enrichment); }
      // one try per run-less scan: a table its model can't enrich stays plain until the schema changes
      if (this.#unenriched.has(name)) { this.#unenriched.delete(name); } else if (enrichment !== undefined && table.enrichment === undefined) { done.add(name); }
    }
    this.#catalog = new TableCatalog(this.instance, dialectOf(this.connection.kind), scanned, enrichments);
    const current = new Set(this.#catalog.tables.filter((table) => {
      const applied = this.#applied.get(table.scanned.spec.name);
      return done.has(table.scanned.spec.name) && applied !== undefined && schemaHash(applied) === table.hash;
    }).map((table) => table.typeName));
    const upsert = this.#catalog.typeDecls(this.config).filter((decl) => current.has(decl.name));
    if (upsert.length > 0) { await this.#deps.hub.types(upsert, []); }
    return upsert.length;
  }

  /** The changes waiting for an admin, as the last publish found them. */
  get pending(): PendingChanges | undefined {
    return this.#pending;
  }

  /** The table shapes the hub's types now come from. */
  get applied(): ReadonlyMap<string, TableSpec> {
    return this.#applied;
  }

  /** Apply the changes a rescan left waiting: the hub's types follow the tables, and dropped tables' types go. */
  async applyPending(scan: string): Promise<{ applied: string[]; removed: string[] } | { problem: string }> {
    const pending = this.#pending;
    if (pending?.scan !== scan) { return { problem: 'These changes were replaced by a newer rescan, or were applied already.' }; }
    const decls = new Map(this.#catalog.typeDecls(this.config).map((decl) => [decl.name, decl]));
    const upsert = pending.tables.flatMap((table) => {
      const decl = decls.get(typeNameOf(this.instance, table.spec.name));
      return decl === undefined ? [] : [decl];
    });
    const removed = pending.dropped.map((name) => typeNameOf(this.instance, name));
    await this.#deps.hub.types(upsert, removed);
    for (const table of pending.tables) { this.#applied.set(table.spec.name, table.spec); }
    for (const name of pending.dropped) { this.#applied.delete(name); }
    this.#pending = undefined;
    return { applied: upsert.map((decl) => decl.name), removed };
  }

  /** Check a payload's query against the tables as they are now. */
  compile(payload: QueryPayload): CompiledQuery | Refusal {
    // a generated table fn is written against the library's own table types
    return compileQuery(payload.generated === undefined ? this.#catalog.engine : this.#catalog.tableEngine, payload.query);
  }

  /** The SQL for a call. */
  plan(compiled: CompiledQuery, args: Readonly<Record<string, Json>>, sort: SortArg): CallPlan {
    return planCall(compiled, this.#catalog.dialect, args, sort, this.#deps.limits);
  }

  read(plan: CallPlan): Promise<Rows> {
    return this.db.read({ sql: plan.sql, params: plan.params });
  }

  write(plan: CallPlan): Promise<Written> {
    return this.db.write([{ sql: plan.sql, params: plan.params }]);
  }

  /** What a write would do, run in a transaction that is rolled back. */
  dryRun(plan: CallPlan): Promise<Written> {
    return this.db.dryRun([{ sql: plan.sql, params: plan.params }]);
  }

  /** The table a gin row type describes: a new one, or the current one changed to fit. */
  tableFor(name: string, type: Parameters<typeof ginTypeToTable>[1]): { current: TableSpec | undefined; wanted: TableSpec } {
    const current = this.#catalog.spec(name);
    const wanted = ginTypeToTable(current?.name ?? name, type, {
      ...(current === undefined ? {} : { current }),
      resolveTable: (typeName) => this.#catalog.spec(typeName.replace(/^database\//, '').replace(new RegExp(`^${this.instance}\\.`), '')),
    });
    return { current, wanted };
  }

  /** A sample of a table's rows and the full value sets of its text columns with few values, for the enricher. */
  async profile(table: ScannedTable, catalog: TableCatalog = this.#catalog): Promise<TableProfile> {
    const engine = catalog.engine;
    const type = identifierOf(table.spec.name);
    const fields = table.spec.columns.map((column) => ({ expr: { kind: 'field-ref' as const, source: type, field: identifierOf(column.name) }, as: column.name }));
    const sampleSql = engine.toSQL({ kind: 'select', fields, from: { kind: 'type', type }, limit: 8 }, catalog.dialect);
    const sample = await this.db.read({ sql: sampleSql.sql, params: sampleSql.params });
    const distinct: Record<string, string[]> = {};
    for (const column of table.spec.columns) {
      if (column.type.kind !== 'text' || column.values !== undefined || table.rows <= this.#deps.distinctMax) { continue; }
      const sql = engine.toSQL({ kind: 'select', distinct: true, fields: [{ expr: { kind: 'field-ref', source: type, field: identifierOf(column.name) }, as: 'value' }], from: { kind: 'type', type }, limit: this.#deps.distinctMax + 1 }, catalog.dialect);
      const values = (await this.db.read({ sql: sql.sql, params: sql.params })).rows.flatMap((row) => (typeof row[0] === 'string' ? [row[0]] : []));
      if (values.length <= this.#deps.distinctMax) { distinct[column.name] = values; }
    }
    return { sample, distinct };
  }

  close(): Promise<void> {
    return this.db.close();
  }

  async #enrichment(table: ScannedTable, catalog: TableCatalog, llm: Llm | undefined): Promise<TableEnrichment | undefined> {
    if (!this.config.enrich.on || llm === undefined) { return undefined; }
    const profile = await this.profile(table, catalog);
    try {
      const written = await this.#deps.enricher.enrich(table, profile.sample, profile.distinct, llm, this.config.enrich.model);
      this.#unenriched.delete(table.spec.name);
      return written;
    } catch {
      // outside a run the hub refuses the call, and an answer that doesn't fit throws: a run enriches it later (`enrichLater`)
      this.#unenriched.add(table.spec.name);
      return undefined;
    }
  }

  /**
   * The enrichments already made, by schema hash: those the hub keeps with this instance's table types, and those of
   * the current catalog (made by this process, maybe not sent yet because their change waits for an admin).
   */
  async #keptEnrichments(): Promise<Map<string, TableEnrichment>> {
    const kept = new Map<string, TableEnrichment>();
    for (const type of (await this.#deps.hub.known()).values()) {
      if (type.meta?.enrichment !== undefined) { kept.set(type.meta.schemaHash, type.meta.enrichment); }
    }
    for (const table of this.#catalog.tables) {
      if (table.enrichment !== undefined) { kept.set(table.hash, table.enrichment); }
    }
    return kept;
  }
}
