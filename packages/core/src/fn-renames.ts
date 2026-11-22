/**
 * The prefix rule's renames (docs/plans/injected-context-2026-11-22.md, section 3): every hub fn about fns starts
 * `fns_`, every one about context starts `ctx_`. A clean rename with no aliases, so the store migration
 * (`store/migrate.ts`'s data step) rewrites the names stored data holds with these: sessions' loaded tools, policies'
 * and MCP rules' fn matches, approvals and the policies an "always" answer made, item switches, search and suggestion
 * settings in `hubOptions`, examples, facts, metrics and runs. The card tags the model reads (`<loaded_context>` and
 * the rest) say `ctx` too; stored transcripts keep the tags they were sent with, since they are history.
 */
import { type Json } from './primitives.ts';
import type { TableName } from './records/tables.ts';

/** The hub fns renamed by the prefix rule: old local name → new local name. */
export const HUB_FN_RENAMES = {
  load_fns: 'fns_load',
  drop_fns: 'fns_drop',
  fn_examples: 'fns_examples',
  fn_get: 'fns_get',
  save_fn: 'fns_save',
  fn_metrics: 'fns_metrics',
  load_context: 'ctx_load',
  context_get: 'ctx_get',
  context_crawl: 'ctx_crawl',
  context_from_resource: 'ctx_from_resource',
  context_link: 'ctx_link',
  context_unlink: 'ctx_unlink',
} as const satisfies Readonly<Record<string, string>>;

/** An old hub fn's local name. */
export type RenamedHubFn = keyof typeof HUB_FN_RENAMES;

/** The same renames as qualified names: `hub/load_fns` → `hub/fns_load`. */
export const QUALIFIED_FN_RENAMES: ReadonlyMap<string, string> = new Map(
  Object.entries(HUB_FN_RENAMES).map(([from, to]) => [`hub/${from}`, `hub/${to}`]),
);

/** The card and result tags renamed with them: old tag → new tag (fn tags are unchanged). */
export const CTX_TAG_RENAMES = {
  context: 'ctx',
  loaded_context: 'loaded_ctx',
  refused_context: 'refused_ctx',
  more_context: 'more_ctx',
  suggested_context: 'suggested_ctx',
  crawled_context: 'crawled_ctx',
  skipped_context: 'skipped_ctx',
} as const satisfies Readonly<Record<string, string>>;

/** The renames by old local name. */
const LOCAL_RENAMES: ReadonlyMap<string, string> = new Map(Object.entries(HUB_FN_RENAMES));

/** A hub fn's local name as it is now: renamed when it is one of the old names, else as given. */
export function renamedHubLocal(local: string): string {
  return LOCAL_RENAMES.get(local) ?? local;
}

/** A fn's qualified name as it is now: `hub/load_fns` is `hub/fns_load`; any other name is as given. */
export function renamedFn(name: string): string {
  return QUALIFIED_FN_RENAMES.get(name) ?? name;
}

/**
 * A stored value with every old hub fn name in it renamed: each string (and object key) that is exactly an old
 * qualified name. Patterns (`hub/*`) and text that merely mentions a name are left as they are. Returns the same
 * value (`===`) when nothing changed, so a migration writes only the rows that did.
 */
export function renameFnsIn(value: Json): Json {
  return renameDeep(value);
}

/** One value renamed, the same value when nothing in it was. */
function renameDeep(value: Json): Json {
  if (typeof value === 'string') return renamedFn(value);
  if (Array.isArray(value)) {
    const items = value.map(renameDeep);
    return items.some((item, at) => item !== value[at]) ? items : value;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) {
      const renamedKey = renamedFn(key);
      const renamedItem = renameDeep(item);
      if (renamedKey !== key || renamedItem !== item) changed = true;
      out[renamedKey] = renamedItem;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * How the store migration applies the renames, table by table: `rows` rewrites each row with `renameFnsIn` (a row
 * keyed by a fn name is re-keyed: written under its new key, the old one removed); `hubLocal` renames the `name`
 * field of rows whose `system` is `hub` (item switches hold a fn's local name). Tables whose fn names are history
 * (model calls, the raw requests) are not listed.
 */
export const FN_RENAME_TABLES = {
  rows: [
    'sessions', 'turns', 'runs', 'policies', 'approvals', 'mcps', 'hubOptions', 'access', 'actorSettings', 'fnExamples',
    'fnFacts', 'fnTypes', 'fnUses', 'fnSignatureTypes', 'fnLinks', 'fnMetrics', 'contextLinks',
  ],
  hubLocal: ['itemSwitches'],
} as const satisfies { readonly rows: readonly TableName[]; readonly hubLocal: readonly TableName[] };
