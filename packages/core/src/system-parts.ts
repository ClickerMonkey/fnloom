/**
 * What one system added to the hub beyond its fns, context and types (which have their own lists): its kinds,
 * `/commands`, mentions, hooks, actions, settings, attachments, embedders, sectioners, model providers, registries,
 * the registry entries (components) it contributes, and its fns' examples. Each part says where it came from (the
 * contract, or added while running), its version (a hash of its declaration) and, where it has one, who sees it. The
 * admin's system page lists them, each opening to its declaration (build 6 feedback).
 */
import { z } from 'zod';
import { Audience, Json, QualifiedName, SystemName } from './primitives.ts';
import { DeclaredBy } from './records/systems.ts';

/** The groups a system's other parts are listed in, in the order the page shows them. */
export const SYSTEM_PART_SECTIONS = [
  'kinds', 'commands', 'mentions', 'hooks', 'actions', 'settings', 'attachments', 'embedders', 'sectioners', 'providers', 'registries', 'components', 'examples',
] as const;
export const SystemPartSection = z.enum(SYSTEM_PART_SECTIONS);
export type SystemPartSection = z.infer<typeof SystemPartSection>;

/** One part a system added: a kind, a `/command`, a provider, an example, … */
export const SystemPart = z.object({
  section: SystemPartSection,
  /** Its name as people refer to it: qualified (`database/query`), a `/command`, or a fn's example (`fs/read #2`). */
  name: z.string().min(1),
  /** One line about it (its description, label or the start of its text). */
  about: z.string(),
  /** From the system's contract, or added while it ran. */
  origin: DeclaredBy,
  /** A short hash of its declaration: a change reads as a new version. */
  version: z.string(),
  /** Who sees it, for the parts that say (a `/command`'s context item suggests to them). */
  visibility: Audience.optional(),
  /** The fn or context item it belongs to (an example's fn, a command's context item), whose page it links to. */
  owner: QualifiedName.optional(),
  /** Its declaration, shown when it is opened. */
  decl: Json,
  /** Build 7: switched on (absent counts as on); switched by `switchItem`, stored in `itemSwitches`. */
  on: z.boolean().optional(),
});
export type SystemPart = z.infer<typeof SystemPart>;

/** How many of a system's examples `systemParts` lists. */
export const SYSTEM_PART_EXAMPLES = 100;

/** `systemParts`: one system's other parts, every section in `SYSTEM_PART_SECTIONS` order. */
export const SystemPartsQuery = z.object({ system: SystemName });
export type SystemPartsQuery = z.infer<typeof SystemPartsQuery>;

/** What `systemParts` answers: the parts, and each section cut short (examples past `SYSTEM_PART_EXAMPLES`) with how many it holds in all. */
export const SystemParts = z.object({ parts: z.array(SystemPart), more: z.partialRecord(SystemPartSection, z.number().int().min(0)) });
export type SystemParts = z.infer<typeof SystemParts>;
