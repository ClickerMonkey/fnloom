/**
 * The context list (`/context`), run by the database. Without text, the list's filters, sort and page are SQL over
 * the `context` table (`SqlSource`, fields mapped in `columns.ts`). With text, it is the one fns and context search
 * (`FnSearch`, `items: ['context']`): words and meaning together when an embedder is up, words alone otherwise, over
 * each item's text and its heading sections, with the list's filters in the same query as SQL. Rows come best first
 * (rank is the default sort with text, never a forced one): with a sort of its own, the best `SORTED_MATCHES` matches
 * are sorted and paged by the database instead. Each says how it was found (`ContextListItem.found`: rank, fit, which
 * index, the section). Either way a row the viewer may not see (another person's memory, a context item shared away
 * from them) is never listed.
 */
import { sortOf, type ContextListItem, type FieldValueOption, type FnSearchHit, type ListField, type ListQuery, type Page } from '@harness/core';
import type { AccessService } from '../access/index.ts';
import { seesContextAs } from '../access/scope.ts';
import type { FnSearch } from '../fns/index.ts';
import type { HubStore } from '../store/index.ts';
import { CONTEXT_COLUMNS } from './columns.ts';
import type { FieldAccessors, ListSource, QueryViewer } from './index.ts';
import { offsetOf, SqlSource } from './sql-source.ts';

/** The most matches a searched list with a sort of its own sorts (the search's largest page): the best of them, by rank. */
export const SORTED_MATCHES = 100;

/** What the context list reads. */
export interface ContextSourceOptions {
  readonly store: HubStore;
  readonly access: Pick<AccessService, 'scope'>;
  readonly search: Pick<FnSearch, 'search'>;
  /** Rows per page when the query doesn't say. */
  readonly page: number;
  /** The most rows the values menu counts over. */
  readonly scan: number;
}

/** The context list's source. */
export class ContextSource implements ListSource<'contexts', ContextListItem> {
  readonly list = 'contexts';
  readonly fields: FieldAccessors<'contexts', ContextListItem>;
  readonly #options: ContextSourceOptions;
  readonly #listed: SqlSource<'contexts', 'context'>;

  constructor(options: ContextSourceOptions) {
    this.#options = options;
    this.#listed = new SqlSource({
      list: 'contexts', table: 'context', store: options.store, access: options.access, columns: CONTEXT_COLUMNS, page: options.page, scan: options.scan,
      // free text never reaches here: the search answers it
      text: [],
      sees: (scope, record) => seesContextAs(scope, record),
      fields: {
        name: (c) => c.name, system: (c) => c.system, origin: (c) => c.origin?.type ?? 'system', tags: (c) => c.decl.tags, disabled: (c) => c.disabled === true,
        stale: (c) => c.stale, tokens: (c) => c.tokens?.full, updatedAt: (c) => c.updatedAt,
      },
    });
    this.fields = this.#listed.fields;
  }

  async page(query: ListQuery, viewer: QueryViewer): Promise<Page<ContextListItem>> {
    const text = query.text?.trim() ?? '';
    return text === '' ? this.#listed.page(query, viewer) : this.#searched(query, text, viewer);
  }

  values(field: ListField<'contexts'>, prefix: string | undefined, limit: number, viewer: QueryViewer): Promise<FieldValueOption[]> {
    return this.#listed.values(field, prefix, limit, viewer);
  }

  /**
   * Searched: the one search, the list's filters in it. Without a sort of its own, best first, the cursor the search's
   * offset; with one, the best `SORTED_MATCHES` matches sorted and paged by the database, the cursor its offset.
   */
  async #searched(query: ListQuery, text: string, viewer: QueryViewer): Promise<Page<ContextListItem>> {
    const { store, access, search } = this.#options;
    const sorted = query.sort !== undefined && query.sort.length > 0;
    const limit = query.limit ?? this.#options.page;
    const offset = offsetOf(query.cursor);
    const found = await search.search({
      text, items: ['context'], off: true, ...(sorted ? { limit: SORTED_MATCHES } : { offset, limit }),
      ...(query.filters === undefined || query.filters.length === 0 ? {} : { filters: query.filters }),
    }, { actor: viewer.id, access: await access.scope(viewer.id) });
    const hits = new Map(found.items.map((hit) => [hit.name, hit]));
    const names = [...hits.keys()];
    if (names.length === 0) return { items: [] };
    // the hits' records in one read: in the search's order, or sorted and paged as asked by the database
    const read = await store.lists.find({
      table: 'context', fields: CONTEXT_COLUMNS, filters: [], keys: names, ...(sorted ? { sort: sortOf('contexts', query), offset, limit: limit + 1 } : { sort: [], offset: 0, limit: names.length }),
    });
    const byName = new Map(read.items.map((record) => [record.name, record]));
    const records = sorted ? read.items.slice(0, limit) : names.flatMap((name) => byName.get(name) ?? []);
    const items = records.flatMap((record): ContextListItem[] => {
      const hit = hits.get(record.name);
      return hit === undefined ? [] : [{ ...record, found: foundOf(hit) }];
    });
    const next = sorted ? (read.items.length > limit ? offset + limit : undefined) : found.next;
    return { items, ...(next === undefined ? {} : { cursor: String(next) }) };
  }
}

/** How the search found a row: its rank, fit, which index, and the section. */
function foundOf(hit: FnSearchHit): NonNullable<ContextListItem['found']> {
  return {
    ...(hit.rank === undefined ? {} : { rank: hit.rank }), ...(hit.similarity === undefined ? {} : { similarity: hit.similarity }),
    ...(hit.matched === undefined ? {} : { matched: hit.matched }), ...(hit.section === undefined ? {} : { section: hit.section }),
  };
}
