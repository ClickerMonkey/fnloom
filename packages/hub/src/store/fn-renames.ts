/**
 * Slice B's steps of the one store migration (`migrate-fn-names.ts`): the prefix rule's renames (core's
 * `HUB_FN_RENAMES`, `hub/load_fns` → `hub/fns_load`, …) in every table that holds a fn's name, beyond the sessions
 * the migration itself rewrites. Each row goes through `renameFnsIn` (every string or key that is exactly an old
 * qualified name); a row keyed by a fn's name is written under its new key and the old one removed. Item switches hold
 * a hub fn's local name, renamed when the switch's system is the hub. Idempotent: a store with no old names is left as
 * it is.
 */
/* eslint-disable @typescript-eslint/consistent-type-assertions -- one generic pass over the rows of many tables: each row is read as plain JSON and written back as the row it was */
import { FN_RENAME_TABLES, HUB_TABLES, renamedHubLocal, renameFnsIn, type Json, type TableName } from '@harness/core';
import type { FnNameMigrationStep } from './migrate-fn-names.ts';
import type { HubStore } from './index.ts';
import { rows } from './rows.ts';

/** The few table operations a step needs, over rows of any table. */
interface AnyTable {
  put(row: Json): Promise<unknown>;
  remove(key: unknown): Promise<boolean>;
}

/** What a reader passes as a row's key: its key field's value, or the row itself for a composite key (it holds the parts). */
function keyOf(table: TableName, row: Readonly<Record<string, Json>>): unknown {
  const { fields } = HUB_TABLES[table];
  return fields.length === 1 && fields[0] !== undefined ? row[fields[0]] : row;
}

/** Every row of a table with its renames applied, written back; returns how many changed. */
async function renameRows(store: HubStore, table: TableName): Promise<number> {
  const changed: Array<{ before: Readonly<Record<string, Json>>; after: Readonly<Record<string, Json>> }> = [];
  for await (const row of rows(store.table(table))) {
    const before = row as unknown as Readonly<Record<string, Json>>;
    const after = renameFnsIn(before) as Readonly<Record<string, Json>>;
    if (after !== before) changed.push({ before, after });
  }
  if (changed.length === 0) return 0;
  const def = HUB_TABLES[table];
  await store.tx(async (tx) => {
    const target = tx.table(table) as unknown as AnyTable;
    for (const { before, after } of changed) {
      // a row keyed by a renamed name moves to its new key
      if (def.rowKey(before as never) !== def.rowKey(after as never)) await target.remove(keyOf(table, before));
      await target.put(after);
    }
  });
  return changed.length;
}

/** The hub's item switches (`itemSwitches`, keyed by system, section and local name) under the renamed local names. */
async function renameHubSwitches(store: HubStore): Promise<number> {
  const changed: Array<{ before: Readonly<Record<string, Json>>; after: Readonly<Record<string, Json>> }> = [];
  for await (const row of rows(store.table('itemSwitches'))) {
    const before = row as unknown as Readonly<Record<string, Json>>;
    const name = before['name'];
    if (before['system'] !== 'hub' || typeof name !== 'string' || renamedHubLocal(name) === name) continue;
    changed.push({ before, after: { ...before, name: renamedHubLocal(name) } });
  }
  if (changed.length === 0) return 0;
  await store.tx(async (tx) => {
    const target = tx.table('itemSwitches') as unknown as AnyTable;
    for (const { before, after } of changed) {
      await target.remove(keyOf('itemSwitches', before));
      await target.put(after);
    }
  });
  return changed.length;
}

/** Slice B's steps, one per table, in `FN_RENAME_TABLES` order. */
export const FN_RENAME_STEPS: readonly FnNameMigrationStep[] = [
  ...FN_RENAME_TABLES.rows.map((table): FnNameMigrationStep => ({ name: `renames.${table}`, run: ({ store }) => renameRows(store, table) })),
  ...FN_RENAME_TABLES.hubLocal.map((table): FnNameMigrationStep => ({ name: `renames.${table}`, run: ({ store }) => renameHubSwitches(store) })),
];
