/**
 * The resource browser's state, all of it in the URL: the view (list, grid or groups), the grouping, the group
 * narrowed to (`in`), the folder (`under`), the list's query (`q`: words, filters and sort, which the hub applies), a
 * form present or missing, the grid's card size, and the opened resource with its viewer mode. One schema (`BrowserQuery`) is
 * the route's query, so links and the page read the same keys. From it come the hub's `ResourceQuery` for the list,
 * each group's own query, and the folder trail. Grouping keys are the hub's (its facets); the web only asks for them.
 * Pure, so it is tested alone.
 */
import {
  FormKind, HUB_RESOURCE_ROOT, ResourceGrouping, ResourceUri, SectionKey, sortOf,
  type ListField, type ListQuery, type ResourceFacet, type ResourceLink, type ResourceQuery, type ResourceRecord, type Sort,
} from '@harness/core';
import { z } from 'zod';
import { hubListQuery, readListQuery, withPage } from '../../state/query.ts';

/** How the browser lays resources out. */
export const BrowserView = z.enum(['list', 'grid', 'groups']);
export type BrowserView = z.infer<typeof BrowserView>;

/** The list's columns it can be sorted by (each a field of the hub's `resources` list: `SORT_FIELDS`). */
export const BrowserSort = z.enum(['seen', 'name', 'size', 'modified', 'type']);
export type BrowserSort = z.infer<typeof BrowserSort>;

/** The grid's card sizes. */
export const CardSize = z.enum(['s', 'm', 'l']);
export type CardSize = z.infer<typeof CardSize>;

/** The browser's query: every key the `/resources` URL may hold. */
export const BrowserQuery = z.object({
  view: BrowserView,
  group: ResourceGrouping,
  /** Only the resources in one group value (with `group`). */
  in: z.string(),
  /** A folder: a URI prefix. */
  under: z.string(),
  /** The list's written query (`family:code read sort:name`). */
  q: z.string(),
  form: FormKind,
  missing: FormKind,
  size: CardSize,
  /** The opened resource, its viewer mode, a section of it, and a page (pdf). */
  uri: ResourceUri,
  mode: z.string(),
  section: SectionKey,
  page: z.string().regex(/^\d+$/),
}).partial();
export type BrowserQuery = z.infer<typeof BrowserQuery>;

/** What the browser asks the hub for: the resource query, with the list's query when it has one. */
export type BrowseQuery = ResourceQuery & { readonly query?: ListQuery };

/** The default view and grouping. */
export const DEFAULTS = { view: 'list', group: 'type', size: 'm' } as const satisfies Required<Pick<BrowserQuery, 'view' | 'group' | 'size'>>;

/** The `resources` field each column sorts by. */
export const SORT_FIELDS = { seen: 'seenAt', name: 'name', size: 'size', modified: 'modifiedAt', type: 'family' } as const satisfies Record<BrowserSort, ListField<'resources'>>;

/** The column the list is sorted by and which way, from the query's sort (the list's default when it has none). */
export function columnSort(query: BrowserQuery): { readonly sort: BrowserSort; readonly descending: boolean } {
  const [first] = sortOf('resources', readListQuery('resources', query.q ?? ''));
  const column = BrowserSort.options.find((key) => SORT_FIELDS[key] === first?.field) ?? 'seen';
  return { sort: column, descending: first?.dir === 'desc' };
}

/** The sort keys for a column: its field, in `dir`. */
export function sortFor(column: BrowserSort, descending: boolean): Sort[] {
  return [{ field: SORT_FIELDS[column], dir: descending ? 'desc' : 'asc' }];
}

/** How many resources a list or grid page holds, and how many each group shows before "show all". */
export const PAGE_SIZE = 60;
export const GROUP_PREVIEW = 6;

/** The browser's query read from a URL's query (unknown or bad keys dropped, one at a time). */
export function readQuery(raw: Readonly<Record<string, unknown>>): BrowserQuery {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(BrowserQuery.shape)) {
    const value = raw[key];
    const parsed = schema.safeParse(typeof value === 'string' ? value : undefined);
    if (parsed.success && parsed.data !== undefined) { out[key] = parsed.data; }
  }
  return BrowserQuery.parse(out);
}

/** A query with some keys changed (`undefined` or '' removes a key), and the defaults left out of the URL. */
export function patchQuery(query: BrowserQuery, patch: { readonly [K in keyof BrowserQuery]?: BrowserQuery[K] | '' }): Record<string, string> {
  const next: Record<string, string> = {};
  const merged: Record<string, unknown> = { ...query, ...patch };
  for (const key of Object.keys(BrowserQuery.shape)) {
    const value = merged[key];
    if (typeof value !== 'string' || value === '') { continue; }
    if (key in DEFAULTS && Reflect.get(DEFAULTS, key) === value) { continue; }
    next[key] = value;
  }
  return next;
}

/** Whether the browser narrows the resources at all (words or filters, a form, a folder or a group). */
export function isFiltered(query: BrowserQuery): boolean {
  const list = readListQuery('resources', query.q ?? '');
  return (list.text ?? '') !== '' || (list.filters ?? []).length > 0 || [query.form, query.missing, query.under, query.in].some((v) => v !== undefined && v !== '');
}

/** The hub's query for the list or grid: the list's query, the form filter, the folder, and the group narrowed to. */
export function hubQuery(query: BrowserQuery): BrowseQuery {
  const group = query.group ?? DEFAULTS.group;
  const list = hubListQuery(readListQuery('resources', query.q ?? ''));
  return {
    ...(Object.keys(list).length === 0 ? {} : { query: list }),
    ...(query.form === undefined ? {} : { form: query.form }),
    ...(query.missing === undefined ? {} : { missing: query.missing }),
    ...(query.under === undefined || query.under === '' ? {} : { under: query.under }),
    group,
    ...(query.in === undefined || query.in === '' ? {} : { in: query.in }),
  };
}

/** The query for one group's first resources in the groups view. */
export function groupQuery(query: BrowserQuery, facet: ResourceFacet): BrowseQuery {
  return withPage(hubQuery({ ...query, in: facet.value }), GROUP_PREVIEW, undefined);
}

/** The query for the folders under `under` (the hub's `path` facets), for the folder tree. */
export function folderQuery(query: BrowserQuery, under: string): BrowseQuery {
  const { in: _in, under: _under, ...rest } = hubQuery(query);
  return { ...rest, group: 'path', ...(under === '' ? {} : { under }), limit: 1 };
}

/** One step of the folder trail. */
export interface Crumb {
  readonly label: string;
  /** The `under` it goes to ('' for every resource). */
  readonly under: string;
}

/**
 * The folder trail of `under`: every resource, then the root (`fs://work`), then each folder down to it. A trailing
 * slash is kept on folders so a prefix never matches a sibling (`docs/` and not `docs-old`).
 */
export function crumbsOf(under: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'All resources', under: '' }];
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i.exec(under);
  if (match === null) { return crumbs; }
  const scheme = match[1] ?? '';
  const parts = (match[2] ?? '').split('/').filter((p) => p !== '');
  let at = scheme;
  parts.forEach((part, i) => {
    at = i === 0 ? `${at}${part}` : `${at}/${part}`;
    crumbs.push({ label: i === 0 ? `${scheme}${part}` : part, under: `${at}/` });
  });
  return crumbs;
}

/** A resource's name for display: its stat's name, or the last part of its URI. */
export function nameOf(record: { readonly uri: string; readonly stat: Pick<ResourceRecord['stat'], 'name'> }): string {
  return record.stat.name || record.uri.split('/').filter((p) => p !== '').at(-1) || record.uri;
}

/**
 * An address short enough for one line, cut in the middle: its scheme and first part, then its distinguishing end
 * (`file:///C:/Users/…/harness/README.md`). An address that fits is unchanged.
 */
export function shortAddress(uri: string, max = 56): string {
  if (uri.length <= max) { return uri; }
  const tail = Math.ceil((max - 1) * 0.6);
  return `${uri.slice(0, max - 1 - tail)}…${uri.slice(uri.length - tail)}`;
}

/** A link's words as a list shows them: its title with inline-code marks (backticks) taken out, else the link as written. */
export function linkLabel(link: Pick<ResourceLink, 'title' | 'raw'>): string {
  const plain = (text: string): string => text.replace(/`+/g, '').trim();
  return plain(link.title ?? '') || plain(link.raw) || link.raw;
}

/** Whether a resource lives in the hub (an upload, a web page, a fn's output): only these rename and delete. */
export function isHubResource(uri: string): boolean {
  return uri.startsWith(HUB_RESOURCE_ROOT);
}

/** The facets of two pages of the same query merged: a value's count is the latest one, new values are added. */
export function mergeFacets(older: readonly ResourceFacet[], newer: readonly ResourceFacet[]): ResourceFacet[] {
  const byValue = new Map(older.map((f) => [f.value, f]));
  for (const facet of newer) { byValue.set(facet.value, facet); }
  return [...byValue.values()];
}

/** The total count of a grouping's facets. */
export function facetTotal(facets: readonly ResourceFacet[]): number {
  return facets.reduce((sum, f) => sum + f.count, 0);
}
