/**
 * Version history for every item a system declares or adds while running (build 8): fns, types, context, kinds,
 * commands, components, examples, providers and the rest of `ItemSection`. One table, `itemVersions`, written in the
 * same transaction as the change by the catalog (manifest import and `RunningSystem.patch` alike), numbered from 1 per
 * item. It replaces `fnVersions` and `typeVersions`, whose rows a migration copies in.
 */
import { z } from 'zod';
import { ItemSection } from './lifecycle.ts';
import { DeclaredBy } from './records/systems.ts';
import { ActorId, InstanceName, Json, PageRequest, SystemName, Timestamp, page } from './primitives.ts';

/** How an item changed at a version. */
export const ItemChange = z.enum(['added', 'changed', 'removed']);
export type ItemChange = z.infer<typeof ItemChange>;

/**
 * One version of one item. `decl` is the item's declaration as its section stores it (a `FnDecl`, a `TypeDecl`,
 * a `ContextDecl`, ...), the declaration before the removal for `removed`.
 */
export const ItemVersionRecord = z.object({
  /** `<system>:<section>:<name>#<number>`. */
  id: z.string().min(1),
  system: SystemName,
  section: ItemSection,
  /** The name the system page lists it by (`ItemRef.name`). */
  name: z.string().min(1),
  number: z.number().int().min(1),
  change: ItemChange,
  decl: Json,
  /** The hash of `decl`, so an unchanged re-import writes no version. */
  hash: z.string().min(1),
  /** From the contract or added while running. */
  declaredBy: DeclaredBy.optional(),
  /** The instance whose change it was, for a fleet's instance items. */
  instance: InstanceName.optional(),
  /** The person whose run saved it, when one did. */
  savedBy: ActorId.optional(),
  savedAt: Timestamp,
});
export type ItemVersionRecord = z.infer<typeof ItemVersionRecord>;

/** The id of one version. */
export function itemVersionId(system: SystemName, section: ItemSection, name: string, number: number): string {
  return `${system}:${section}:${name}#${String(number)}`;
}

/** One item's history, newest first (web `itemVersions`, hub fn `hub/item_versions`). */
export const ItemVersionsQuery = PageRequest.extend({ system: SystemName, section: ItemSection, name: z.string().min(1) });
export type ItemVersionsQuery = z.infer<typeof ItemVersionsQuery>;

export const ItemVersionsPage = page(ItemVersionRecord);
export type ItemVersionsPage = z.infer<typeof ItemVersionsPage>;
