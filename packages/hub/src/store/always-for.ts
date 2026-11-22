/**
 * The store migration's `alwaysFor` step: injected context replaced `alwaysFor` ("always loaded for these agents").
 * On hub-made context (a memory, context made from a resource), which only an admin could give `alwaysFor`, it becomes
 * `inject` with the same agents as exact names, already approved (hub-made context is never reviewed; an admin set
 * it). On a system's own context it is dropped: the system declares `inject` itself now, and its new contract waits
 * for review like any change. Idempotent: a row with no `alwaysFor` is left alone. This is the one reader of the
 * legacy field (`StoredContextDecl.alwaysFor`). It runs as a step of the one store migration (`migrate-fn-names.ts`,
 * `ALWAYS_FOR_STEP`).
 */
import type { Logger } from '@ayepi/log';
import { AgentTargetDecl, InjectDecl, type ContextRecord } from '@harness/core';
import type { HubStore } from './index.ts';
import type { FnNameMigrationStep } from './migrate-fn-names.ts';
import { rows } from './rows.ts';

/** Whether a record was made by the hub (a memory, or context made from a resource), not declared by a system. */
const hubMade = (record: ContextRecord): boolean => record.origin?.type === 'memory' || record.origin?.type === 'resource';

/**
 * One record with `alwaysFor` turned into `inject` (hub-made) or dropped (a system's), or undefined when it has none.
 * Agent names that can't be a target are left out (and an `inject` with none left isn't written).
 */
export function alwaysForToInject(record: ContextRecord): ContextRecord | undefined {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the migration is the one reader of the legacy field it moves
  const { alwaysFor, ...decl } = record.decl;
  if (alwaysFor === undefined) { return undefined; }
  const into = alwaysFor.filter((agent) => AgentTargetDecl.safeParse(agent).success);
  const inject = hubMade(record) && decl.inject === undefined && into.length > 0 ? InjectDecl.parse({ into }) : decl.inject;
  return { ...record, decl: { ...decl, ...(inject === undefined ? {} : { inject }) } };
}

/** Move every stored `alwaysFor` (see the module). Returns how many records changed. */
export async function migrateAlwaysFor(store: HubStore, log: Logger): Promise<number> {
  const changed: ContextRecord[] = [];
  for await (const record of rows(store.table('context'))) {
    const next = alwaysForToInject(record);
    if (next !== undefined) { changed.push(next); }
  }
  if (changed.length === 0) { return 0; }
  await store.tx(async (tx) => { for (const record of changed) { await tx.table('context').put(record); } });
  log.info('store.always-for.migrated', { records: changed.length, injected: changed.filter((record) => record.decl.inject !== undefined && hubMade(record)).length });
  return changed.length;
}

/** The step in the one store migration's list (`FN_NAME_MIGRATION_STEPS`). */
export const ALWAYS_FOR_STEP: FnNameMigrationStep = { name: 'always-for', run: ({ store, log }) => migrateAlwaysFor(store, log) };
