/**
 * Version history for every item a system declares or adds while running (build 8, `core/versions.ts`): one
 * `itemVersions` row per change, numbered from 1 per item, written in the same transaction as the change. The catalog
 * writes them for a manifest import or patch (from the item-by-item changes the review compares, so an unchanged item
 * writes nothing) and for a fn a person saves; the hub fn `hub/item_versions` and the web's `itemVersions` read them.
 */
import type { Logger } from '@ayepi/log';
import {
  ItemSection, itemVersionId, Json, splitName, SystemName,
  type ActorId, type ContractChange, type ItemVersionRecord, type ItemVersionsPage, type ItemVersionsQuery, type Manifest,
} from '@harness/core';
import { canonicalJson, sha256 } from '@harness/sdk';
import type { HubStore } from '../store/index.ts';
import { rows } from '../store/rows.ts';
import { contractChanges } from '../link/lifecycle.ts';

/** How many versions one page holds when the asker gives no limit. */
const VERSIONS_PAGE = 50;

/** One change to write as a version: an item, how it changed and its declaration (before the removal for `removed`). */
export interface ItemChangeInput {
  readonly section: ItemSection;
  readonly name: string;
  readonly change: ItemVersionRecord['change'];
  readonly decl: Json;
  readonly declaredBy?: ItemVersionRecord['declaredBy'];
}

/** The changes from one manifest to the next that are items (a system's grants and config are reviewed, not versioned). */
export function itemChanges(before: Manifest | undefined, after: Manifest): ItemChangeInput[] {
  return contractChanges(before, after).flatMap((change: ContractChange): ItemChangeInput[] => {
    const section = ItemSection.safeParse(change.section);
    const decl = change.change === 'removed' ? change.before : change.after;
    if (!section.success || decl === undefined) { return []; }
    return [{ section: section.data, name: change.name, change: change.change, decl, declaredBy: change.origin }];
  });
}

/** Write one version per change, each numbered after the item's last. Run it in the transaction that makes the change. */
export async function writeItemVersions(store: HubStore, system: SystemName, changes: readonly ItemChangeInput[], at: number, savedBy?: ActorId): Promise<ItemVersionRecord[]> {
  const table = store.table('itemVersions');
  const written: ItemVersionRecord[] = [];
  // a system with no history yet (its first import) numbers every item 1 without asking item by item
  const fresh = changes.length > 1 && (await table.count({ system })) === 0;
  for (const change of changes) {
    const number = fresh ? 1 : (await table.count({ system, section: change.section, name: change.name })) + 1;
    written.push({
      id: itemVersionId(system, change.section, change.name, number), system, section: change.section, name: change.name, number, change: change.change,
      decl: change.decl, hash: await sha256(canonicalJson(change.decl)),
      ...(change.declaredBy === undefined ? {} : { declaredBy: change.declaredBy }),
      ...(savedBy === undefined ? {} : { savedBy }),
      savedAt: at,
    });
  }
  await table.putAll(written);
  return written;
}

/** One item's history, newest first, a page at a time. */
export function itemVersionsPage(store: HubStore, query: ItemVersionsQuery): Promise<ItemVersionsPage> {
  return store.table('itemVersions').find({
    where: { system: query.system, section: query.section, name: query.name }, order: [['number', 'desc']], limit: query.limit ?? VERSIONS_PAGE, cursor: query.cursor,
  });
}

/** How many versions an item has (its current version's number). */
export function itemVersionCount(store: HubStore, system: SystemName, section: ItemSection, name: string): Promise<number> {
  return store.table('itemVersions').count({ system, section, name });
}

/** An item's newest version, if it has one. */
export async function latestItemVersion(store: HubStore, system: SystemName, section: ItemSection, name: string): Promise<ItemVersionRecord | undefined> {
  const page = await store.table('itemVersions').find({ where: { system, section, name }, order: [['number', 'desc']], limit: 1 });
  return page.items[0];
}

/**
 * Move build 5's `fnVersions` and build 7's `typeVersions` rows into `itemVersions` (as `changed` versions with the
 * numbers they had), removing each as it moves. Runs once per start before the catalog imports anything; a store with
 * none left does nothing. Returns how many moved.
 */
export async function migrateOldVersions(store: HubStore, log: Logger): Promise<number> {
  let moved = 0;
  for await (const row of rows(store.table('fnVersions'))) {
    await store.tx(async (tx) => {
      const system = SystemName.parse(splitName(row.fn).system);
      const decl = Json.parse(row.decl);
      await tx.table('itemVersions').put({
        id: itemVersionId(system, 'fns', row.fn, row.number), system, section: 'fns', name: row.fn, number: row.number, change: 'changed', decl,
        hash: await sha256(canonicalJson(decl)), declaredBy: 'runtime', ...(row.savedBy === undefined ? {} : { savedBy: row.savedBy }), savedAt: row.savedAt,
      });
      await tx.table('fnVersions').remove(row.id);
    });
    moved += 1;
  }
  for await (const row of rows(store.table('typeVersions'))) {
    await store.tx(async (tx) => {
      const system = SystemName.parse(splitName(row.type).system);
      const decl = Json.parse(row.decl);
      await tx.table('itemVersions').put({
        id: itemVersionId(system, 'types', row.type, row.number), system, section: 'types', name: row.type, number: row.number, change: 'changed', decl,
        hash: await sha256(canonicalJson(decl)), ...(row.instance === undefined ? {} : { instance: row.instance }), savedAt: row.savedAt,
      });
      await tx.table('typeVersions').remove(row.id);
    });
    moved += 1;
  }
  if (moved > 0) { log.info('catalog.versions.migrated', { moved }); }
  return moved;
}
