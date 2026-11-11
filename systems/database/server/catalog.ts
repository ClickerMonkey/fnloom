/**
 * One database's tables as the system knows them after a scan: the query engine over their types (what queries are
 * checked against and emitted from), the hub's type of each table, and the schema text the query agent writes
 * against. Each hub type carries its `TableMeta`, so the enrichment is kept with the type in the hub.
 */
import { QueryEngine, createRegistry, describeEngine, tableToQueryType, type Dialect, type TableSpec, type TypeBacking } from '@aeye/query';
import { JsonObject, type GinTypeDef, type InstanceName, type TypeDecl } from '@harness/core';
import type { DatabaseConfig, DialectName } from '../shared/shapes.ts';
import { dialectFor } from './dialects.ts';
import { schemaHash, type ScannedTable } from './schema.ts';
import { engineTypeOf, hubTypeOf, identifierOf, titleOf, typeNameOf, type TableEnrichment, type TableMeta } from './types.ts';

/** The meta a table type carries to the hub: its schema hash and enrichment. */
function metaOf(table: CatalogTable): JsonObject {
  const meta: TableMeta = { schemaHash: table.hash, ...(table.enrichment === undefined ? {} : { enrichment: table.enrichment }) };
  // through JSON, so the optional fields a model left out are dropped rather than kept as undefined
  return JsonObject.parse(JSON.parse(JSON.stringify(meta)));
}

/** One table: its scan, hash, enrichment (when there is one) and hub type. */
export interface CatalogTable {
  readonly scanned: ScannedTable;
  readonly hash: string;
  readonly enrichment: TableEnrichment | undefined;
  /** Its hub type's local name (`main.orders`). */
  readonly typeName: string;
  readonly hubType: GinTypeDef;
}

/** A database's tables, typed for the hub and for the query engine. */
export class TableCatalog {
  readonly instance: InstanceName;
  readonly dialectName: DialectName;
  readonly dialect: Dialect;
  readonly engine: QueryEngine;
  /**
   * The engine over `@aeye/query`'s own table types (`tableToQueryType`), which the generated table fns are written
   * against: a foreign key column is itself the relation there, where `engine` keeps it a value and adds a relation
   * named after it. Made on first use.
   */
  #tableEngine: QueryEngine | undefined;
  readonly tables: readonly CatalogTable[];

  constructor(instance: InstanceName, dialectName: DialectName, scanned: readonly ScannedTable[], enrichments: ReadonlyMap<string, TableEnrichment>) {
    this.instance = instance;
    this.dialectName = dialectName;
    this.dialect = dialectFor(dialectName);
    this.tables = scanned.map((table) => {
      const enrichment = enrichments.get(schemaHash(table.spec));
      return { scanned: table, hash: schemaHash(table.spec), enrichment, typeName: typeNameOf(instance, table.spec.name), hubType: hubTypeOf(table.spec, enrichment) };
    });
    const registry = createRegistry();
    const types = this.tables.map((table) => engineTypeOf(table.scanned, table.enrichment));
    const backings: Record<string, TypeBacking> = {};
    for (const type of types) {
      registry.registerType(registry.parseType(type.def));
      backings[type.def.name] = type.backing;
    }
    this.engine = new QueryEngine(registry, { backings });
  }

  /** The engine the generated table fns run on (see `#tableEngine`). */
  get tableEngine(): QueryEngine {
    if (this.#tableEngine === undefined) {
      const specs = this.tables.map((table) => table.scanned.spec);
      const registry = createRegistry();
      for (const spec of specs) { registry.registerType(registry.parseType(tableToQueryType(spec, { tables: specs, rowCount: Math.max(1, this.tables.find((table) => table.scanned.spec === spec)?.scanned.rows ?? 1) }))); }
      this.#tableEngine = new QueryEngine(registry);
    }
    return this.#tableEngine;
  }

  /** The table with this name (physical or as a type), if there is one. */
  table(name: string): CatalogTable | undefined {
    return this.tables.find((table) => table.scanned.spec.name === name || identifierOf(table.scanned.spec.name) === name || table.typeName === name);
  }

  /** The current shape of a table, if it exists. */
  spec(name: string): TableSpec | undefined {
    return this.table(name)?.scanned.spec;
  }

  /**
   * The hub's declaration of each table's type, belonging to this instance and seen only by the database's audience
   * (the descriptions carry sample values from its rows).
   */
  typeDecls({ label, audience }: Pick<DatabaseConfig, 'label' | 'audience'>): TypeDecl[] {
    return this.tables.map((table) => {
      const title = titleOf(table.scanned.spec);
      return {
        name: table.typeName,
        description: `${table.enrichment?.description ?? `A row of ${table.scanned.spec.name} in ${label}.`} Columns: ${table.scanned.spec.columns.map((column) => column.name).join(', ')}.`,
        def: table.hubType,
        display: { label: table.scanned.spec.name, icon: 'table', ...(title === undefined ? {} : { title }) },
        methods: [],
        instance: this.instance,
        audience,
        meta: metaOf(table),
      };
    });
  }

  /** The schema as the query agent reads it: every table type, the expressions and functions it may use. */
  describe(): string {
    return describeEngine(this.engine, { maxExamples: 1 });
  }

  /** Its tables, each with what it holds when known (`orders (one per checkout)`). */
  tableList(): string[] {
    return this.tables.map((table) => `${table.scanned.spec.name}${table.enrichment === undefined ? '' : ` (${table.enrichment.description})`}`);
  }

  /** A few words on what the database holds, for matching descriptions to databases. */
  summary(label: string): string {
    return `${label}: ${this.tables.map((table) => `${table.scanned.spec.name} (${table.scanned.spec.columns.map((column) => column.name).join(', ')})${table.enrichment === undefined ? '' : ` — ${table.enrichment.description}`}`).join('; ')}`;
  }
}
