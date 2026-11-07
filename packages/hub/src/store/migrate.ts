/**
 * Migrations, derived from the row schemas. Nothing is written by hand: each table's columns and kinds come from
 * its schema (`layoutOf`), its indexes from `TABLE_INDEXES`, and a meta table remembers what was made last time.
 *
 * - A new table is created; a new field becomes a new column (nullable, since the schema is what requires fields).
 * - A field that left the schema keeps its column (and its data) and is remembered, so if it comes back with another
 *   kind the change is caught.
 * - A field whose kind changed (a string that became an object): rebuilt if the table is empty, refused otherwise.
 * - Indexes that are no longer declared are dropped; new ones are created.
 */
import { sql } from 'kysely';
import { z } from 'zod';
import { type AuxTableName, SQL_TYPE, TableMeta, createAuxTable } from './aux.ts';
import type { Db } from './db.ts';
import { StoreError } from './errors.ts';
import { type ColumnKind, ColumnKind as ColumnKindSchema, KEY_COLUMN, type Layout, indexName } from './schema.ts';

/** The meta table: one row per table this store made. */
export const META_TABLE = '_tables' satisfies AuxTableName;

/** A meta row with its JSON text read back. */
const MetaRow = TableMeta.transform((row) => ({
  ...row,
  columns: z.record(z.string(), ColumnKindSchema).parse(JSON.parse(row.columns)),
  indexes: z.array(z.string()).parse(JSON.parse(row.indexes)),
}));

/** What one table should look like. */
export interface TablePlan {
  readonly name: string;
  readonly layout: Layout;
  readonly indexes: ReadonlyArray<readonly string[]>;
}

/** What a migration did to one table. */
export interface TableChange {
  readonly table: string;
  readonly created: boolean;
  readonly rebuilt: boolean;
  readonly added: readonly string[];
  readonly retired: readonly string[];
  readonly indexesCreated: readonly string[];
  readonly indexesDropped: readonly string[];
}

/** Create the meta table. */
export async function ensureMeta(db: Db): Promise<void> {
  await createAuxTable(db, META_TABLE);
}

/** Bring one table up to its plan. Run inside a transaction. Returns what changed (nothing, when it was current). */
export async function migrateTable(db: Db, plan: TablePlan): Promise<TableChange> {
  const metaCells = await db.selectFrom(META_TABLE).selectAll().where('name', '=', plan.name).executeTakeFirst();
  const meta = metaCells === undefined ? undefined : MetaRow.parse(metaCells);
  const physical = await physicalColumns(db, plan.name);
  const remembered = new Map<string, ColumnKind>(Object.entries(meta?.columns ?? {}));

  const changed = [...plan.layout].filter(([column, kind]) => {
    const was = remembered.get(column);
    return was !== undefined && was !== kind && physical.has(column);
  });
  let rebuilt = false;
  if (changed.length > 0) {
    const rows = await db.selectFrom(plan.name).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
    if (Number(rows['n']) > 0) {
      const list = changed.map(([column, kind]) => `${column}: ${remembered.get(column) ?? '?'} → ${kind}`).join(', ');
      throw new StoreError('migration', `table ${plan.name} holds rows and these columns changed kind: ${list}`);
    }
    await db.schema.dropTable(plan.name).execute();
    physical.clear();
    remembered.clear();
    rebuilt = true;
  }

  const created = physical.size === 0;
  const added: string[] = [];
  if (created) {
    let create = db.schema.createTable(plan.name).addColumn(KEY_COLUMN, 'text', (c) => c.primaryKey().notNull());
    for (const [column, kind] of plan.layout) create = create.addColumn(column, SQL_TYPE[kind]);
    await create.execute();
  } else {
    for (const [column, kind] of plan.layout) {
      if (physical.has(column)) continue;
      await db.schema.alterTable(plan.name).addColumn(column, SQL_TYPE[kind]).execute();
      added.push(column);
    }
  }

  const wanted = new Map(plan.indexes.map((columns) => [indexName(plan.name, columns), columns]));
  const had = new Set(rebuilt ? [] : (meta?.indexes ?? []));
  const indexesDropped = [...had].filter((name) => !wanted.has(name));
  for (const name of indexesDropped) await db.schema.dropIndex(name).ifExists().execute();
  const indexesCreated: string[] = [];
  for (const [name, columns] of wanted) {
    if (had.has(name)) continue;
    await db.schema.createIndex(name).ifNotExists().on(plan.name).columns([...columns]).execute();
    indexesCreated.push(name);
  }

  const retired = [...remembered.keys()].filter((column) => !plan.layout.has(column));
  const columns = Object.fromEntries([...remembered, ...plan.layout]);
  const row: TableMeta = { name: plan.name, columns: JSON.stringify(columns), indexes: JSON.stringify([...wanted.keys()]) };
  await db
    .insertInto(META_TABLE)
    .values(row)
    .onConflict((oc) => oc.column('name').doUpdateSet({ columns: row.columns, indexes: row.indexes }))
    .execute();
  return { table: plan.name, created, rebuilt, added, retired, indexesCreated, indexesDropped };
}

/** Whether a change did anything. */
export const isChange = (change: TableChange): boolean =>
  change.created || change.rebuilt || change.added.length > 0 || change.indexesCreated.length > 0 || change.indexesDropped.length > 0;

const ColumnInfo = z.object({ name: z.string() });

/** The columns a table has in the database (empty when it doesn't exist). */
async function physicalColumns(db: Db, table: string): Promise<Set<string>> {
  const result = await sql`select name from pragma_table_info(${table})`.execute(db);
  return new Set(result.rows.map((row) => ColumnInfo.parse(row).name));
}
