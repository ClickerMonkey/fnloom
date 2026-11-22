/**
 * What a `FnPill` shows and where it leads, from the name it is given: a qualified fn name opens the fn modal; a glob
 * (`hub/*`, `hub/search_*`) or a whole system (`database`, as grants and policies name them) can't open as one fn, so
 * it links to the fns list filtered to what it matches. (A model's tool name, `hub__fns_search`, reads back to its fn
 * with core's display-only `fnOfStoredToolName` before it is given to a pill.)
 * The off look comes from the structured block (`FnBlock`) where the caller has one, or a fn's availability.
 */
import { fnLabel, humanize, QualifiedName, SystemName, type Availability, type FnBlock, type FnBlockCode } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { links } from '../../app/routes.ts';
import { queryParam } from '../../state/query.ts';
import type { SearchQuery } from '../../ui/search.ts';

/** What a pill stands for. */
export type PillTarget =
  | { readonly kind: 'fn'; readonly fn: QualifiedName; readonly label: string }
  | { readonly kind: 'match'; readonly label: string; readonly query: SearchQuery }
  | { readonly kind: 'text'; readonly label: string };

/** What blocks the fn a pill shows, as far as the pill needs it. */
export type PillBlock = Pick<FnBlock, 'code' | 'reason'>;

/** The fns list's query for a glob or a whole system: its system when the glob names one, its local name's literal pieces as `contains`. */
export function matchQuery(pattern: string): SearchQuery | undefined {
  const system = SystemName.safeParse(pattern);
  if (system.success) { return { filters: [{ field: 'system', op: 'is', value: system.data }] }; }
  const at = pattern.indexOf('/');
  if (at <= 0 || !pattern.includes('*')) { return undefined; }
  const owner = pattern.slice(0, at);
  const pieces = pattern.slice(at + 1).split('*').filter((piece) => piece !== '');
  return {
    filters: [
      ...(owner.includes('*') ? [] : [{ field: 'system', op: 'is' as const, value: owner }]),
      ...pieces.map((piece) => ({ field: 'name', op: 'contains' as const, value: piece })),
    ],
  };
}

/** How a glob or system reads: "All hub fns", "Hub fns like search_*". */
function matchLabel(pattern: string): string {
  const at = pattern.indexOf('/');
  if (at < 0) { return `All ${pattern} fns`; }
  const owner = pattern.slice(0, at);
  const local = pattern.slice(at + 1);
  const whose = owner === '*' ? 'Fns' : `${humanize(owner)} fns`;
  return local === '*' ? (owner === '*' ? 'All fns' : `All ${owner} fns`) : `${whose} like ${local}`;
}

/** What a name given to a pill stands for: a fn, a match (a glob or a whole system), or plain text. */
export function pillTarget(name: string): PillTarget {
  const match = matchQuery(name);
  if (match !== undefined) { return { kind: 'match', label: matchLabel(name), query: match }; }
  const fn = QualifiedName.safeParse(name).data;
  return fn === undefined ? { kind: 'text', label: name } : { kind: 'fn', fn, label: fnLabel(fn) };
}

/** Where a match pill leads: the fns list, filtered. */
export function matchLink(query: SearchQuery): RouteLocationRaw {
  return links.fns({ q: queryParam('fns', query) });
}

/** A fn's availability as the block a pill reads (undefined when it can be used). */
export function blockOfAvailability(available: Availability | undefined): PillBlock | undefined {
  return available === undefined || available === true ? undefined : { code: available.unavailable, reason: available.detail };
}

/** A block code in a word, for the pill's mark. */
const BLOCK_WORDS: Partial<Record<FnBlockCode, string>> = { disabled: 'off', held: 'held', paused: 'paused', 'no-such-fn': 'missing', 'connect-account': 'connect' };

/** The pill's short state word ('unavailable' when no word fits the code). */
export function blockWord(block: PillBlock): string {
  return BLOCK_WORDS[block.code] ?? 'unavailable';
}

/** The pill's hover text: the qualified name, and what blocks it. */
export function pillTitle(name: string, block: PillBlock | undefined): string {
  return block === undefined ? name : `${name}: ${block.reason}`;
}
