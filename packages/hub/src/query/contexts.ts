/**
 * The context list (`/context`), run by the database. Without text, the list's filters, sort and page are SQL over
 * the `context` table (`SqlSource`, fields mapped in `columns.ts`). With text, it is the one fns and context search
 * (`FnSearch`, `items: ['context']`): words and meaning together when an embedder is up, words alone otherwise, over
 * each item's text and its heading sections, with the list's filters in the same query as SQL; rows come best first,
 * each saying how it was found (`ContextListItem.found`: score, fit, which index, the section). Either way a row the
 * viewer may not see (another person's memory, a context item shared away from them) is never listed.
 */
import type { ContextListItem, FieldValueOption, FnSearchHit, ListField, ListQuery, Page } from '@harness/core';
import type { AccessService } from '../access/index.ts';
import { seesContextAs } from '../access/scope.ts';
import type { FnSearch } from '../fns/index.ts';
import type { HubStore } from '../store/index.ts';
import { CONTEXT_COLUMNS } from './columns.ts';
import type { FieldAccessors, ListSource, QueryViewer } from './index.ts';
import { offsetOf, SqlSource } from './sql-source.ts';

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

  /** Searched: the one search, best first, the list's filters in it; the cursor is the search's offset. */
  async #searched(query: ListQuery, text: string, viewer: QueryViewer): Promise<Page<ContextListItem>> {
    const { store, access, search } = this.#options;
    const found = await search.search({
      text, items: ['context'], off: true, offset: offsetOf(query.cursor), limit: query.limit ?? this.#options.page,
      ...(query.filters === undefined || query.filters.length === 0 ? {} : { filters: query.filters }),
    }, { actor: viewer.id, access: await access.scope(viewer.id) });
    // the hits' records in one read, kept in the search's order
    const names = found.items.map((hit) => hit.name);
    const read = names.length === 0 ? [] : (await store.lists.find({ table: 'context', fields: CONTEXT_COLUMNS, filters: [], sort: [], keys: names, offset: 0, limit: names.length })).items;
    const records = new Map(read.map((record) => [record.name, record]));
    const items = found.items.flatMap((hit): ContextListItem[] => {
      const record = records.get(hit.name);
      return record === undefined ? [] : [{ ...record, found: foundOf(hit) }];
    });
    return { items, ...(found.next === undefined ? {} : { cursor: String(found.next) }) };
  }
}

/** How the search found a row: its score, fit, which index, and the section. */
function foundOf(hit: FnSearchHit): NonNullable<ContextListItem['found']> {
  return {
    ...(hit.score === undefined ? {} : { score: hit.score }), ...(hit.similarity === undefined ? {} : { similarity: hit.similarity }),
    ...(hit.matched === undefined ? {} : { matched: hit.matched }), ...(hit.section === undefined ? {} : { section: hit.section }),
  };
}
