/**
 * The API grouped and indexed (build 8; Decided "Context folders"): a system's fns are grouped (`FnDecl.group`, with
 * each group described once in `Manifest.groups`), and the hub keeps an index context item per system and one per
 * group, written by the catalog in the same transaction as the fns they list, so a small model walks the API the way
 * it walks a context folder: `<system>/api` lists the groups as choices, `<system>/api.<group>` lists the group's fns
 * with one line each. The hub's own fns are grouped the same way. A fn with no group is in `GENERAL_GROUP`.
 */
import { z } from 'zod';
import { LocalName, qualify, type QualifiedName, type SystemName } from './primitives.ts';

/** The group of a fn that names none. */
export const GENERAL_GROUP = 'general';

/** A group of a system's fns (`Manifest.groups`): its name, a title and what its fns are for. */
export const ApiGroupDecl = z.object({ name: LocalName, title: z.string().min(1), description: z.string().min(1) });
export type ApiGroupDecl = z.infer<typeof ApiGroupDecl>;

/** The local name of a system's API index item, or of one group's. */
export function apiContextLocal(group?: string): string {
  return group === undefined ? 'api' : `api.${group}`;
}

/** The qualified name of a system's API index item, or of one group's (`fs/api`, `fs/api.files`). */
export function apiContextName(system: SystemName, group?: string): QualifiedName {
  return qualify(system, apiContextLocal(group));
}
