/**
 * One database's tables as the system knows them after a scan: the query engine over their types (what queries are
 * checked against and emitted from), the hub's type of each table, and the schema text the query agent writes
 * against.
 */
import { QueryEngine, createRegistry, describeEngine, type Dialect, type TableSpec, type TypeBacking } from '@aeye/query';
import type { GinTypeDef, InstanceName, TypeDecl } from '@harness/core';
import type { DialectName } from '../shared/shapes.ts';
import { dialectFor } from './dialects.ts';
import { schemaHash, type ScannedTable } from './schema.ts';
import { engineTypeOf, hubTypeOf, identifierOf, titleOf, typeNameOf, type TableEnrichment } from './types.ts';

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

  /** The table with this name (physical or as a type), if there is one. */
  table(name: string): CatalogTable | undefined {
    return this.tables.find((table) => table.scanned.spec.name === name || identifierOf(table.scanned.spec.name) === name || table.typeName === name);
  }

  /** The current shape of a table, if it exists. */
  spec(name: string): TableSpec | undefined {
    return this.table(name)?.scanned.spec;
  }

  /** The hub's declaration of each table's type, belonging to this instance. */
  typeDecls(label: string): TypeDecl[] {
    return this.tables.map((table) => {
      const title = titleOf(table.scanned.spec);
      return {
        name: table.typeName,
        description: `${table.enrichment?.description ?? `A row of ${table.scanned.spec.name} in ${label}.`} Columns: ${table.scanned.spec.columns.map((column) => column.name).join(', ')}.`,
        def: table.hubType,
        display: { label: table.scanned.spec.name, icon: 'table', ...(title === undefined ? {} : { title }) },
        methods: [],
        instance: this.instance,
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
