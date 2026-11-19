/**
 * A list served whole by the database (`HubStore.lists`): its filters, free text, sort and page are SQL over one table,
 * with each field read where it lives in the row (`columns`, `columns.ts`). What SQL can't decide, a viewer's access to
 * one row (another person's memory, a root shared away from them), is checked on each row as the page fills, a chunk at
 * a time, so a page is always full and never repeats or skips a row. The cursor is the offset into the SQL order where
 * the next page starts. Nothing is loaded to be filtered, matched or counted.
 */
import { sortOf, type FieldValueOption, type Filter, type ListField, type ListName, type ListQuery, type Page, type RowOf, type TableName } from '@harness/core';
import type { AccessScope, AccessService } from '../access/index.ts';
import type { HubStore, ListColumn } from '../store/index.ts';
import { valuesOf } from './evaluate.ts';
import type { FieldAccessors, ListSource, QueryViewer } from './index.ts';

/** How a list reads from its table. */
export interface SqlSourceOptions<L extends ListName, K extends TableName> {
  readonly list: L;
  readonly table: K;
  readonly store: HubStore;
  readonly access: Pick<AccessService, 'scope'>;
  /** Where each list field lives in the row, and any other column `own` filters on. */
  readonly columns: { readonly [F in ListField<L>]: ListColumn } & Readonly<Record<string, ListColumn>>;
  readonly fields: FieldAccessors<L, RowOf<K>>;
  /** The columns free text matches: the list's text fields and what else its rows are found by. */
  readonly text: readonly ListColumn[];
  /** The filters every read gets for its viewer, as SQL (a person's own rows). */
  readonly own?: (viewer: QueryViewer) => Filter[];
  /** Refuse a viewer who may not read the list at all. */
  readonly allow?: (viewer: QueryViewer) => void;
  /** Whether the viewer sees a row, where SQL can't say. */
  readonly sees?: (scope: AccessScope, row: RowOf<K>) => boolean;
  /** Rows per page when the query doesn't say. */
  readonly page: number;
  /** The most rows the values menu counts over. */
  readonly scan: number;
}

/** A list over one table, run in SQL. */
export class SqlSource<L extends ListName, K extends TableName> implements ListSource<L, RowOf<K>> {
  readonly list: L;
  readonly fields: FieldAccessors<L, RowOf<K>>;
  readonly #o: SqlSourceOptions<L, K>;

  constructor(options: SqlSourceOptions<L, K>) {
    this.list = options.list;
    this.fields = options.fields;
    this.#o = options;
  }

  async page(query: ListQuery, viewer: QueryViewer): Promise<Page<RowOf<K>>> {
    this.#o.allow?.(viewer);
    const { store, table, columns, text } = this.#o;
    const sees = await this.#seer(viewer);
    const limit = query.limit ?? this.#o.page;
    const words = query.text?.trim() ?? '';
    const filters = [...(this.#o.own?.(viewer) ?? []), ...(query.filters ?? [])];
    const items: Array<RowOf<K>> = [];
    let offset = offsetOf(query.cursor);
    for (;;) {
      const chunk = await store.lists.find({
        table, fields: columns, filters, sort: sortOf(this.list, query), offset, limit: limit + 1, ...(words === '' ? {} : { words: { text: words, columns: text } }),
      });
      for (const [index, row] of chunk.items.entries()) {
        if (!sees(row)) continue;
        if (items.length === limit) return { items, cursor: String(offset + index) };
        items.push(row);
      }
      offset += chunk.items.length;
      if (chunk.items.length <= limit) return { items };
    }
  }

  /** A field's values with counts, over the newest rows the viewer sees (up to the scan bound). */
  async values(field: ListField<L>, prefix: string | undefined, limit: number, viewer: QueryViewer): Promise<FieldValueOption[]> {
    this.#o.allow?.(viewer);
    const { store, table, columns, scan } = this.#o;
    const sees = await this.#seer(viewer);
    const read = await store.lists.find({ table, fields: columns, filters: this.#o.own?.(viewer) ?? [], sort: sortOf(this.list, {}), offset: 0, limit: scan });
    return valuesOf(read.items.filter(sees), { list: this.list, fields: this.fields }, field, prefix, limit);
  }

  /** The viewer's per-row check: every row when SQL decides it all. */
  async #seer(viewer: QueryViewer): Promise<(row: RowOf<K>) => boolean> {
    const sees = this.#o.sees;
    if (sees === undefined) return () => true;
    const scope = await this.#o.access.scope(viewer.id);
    return (row) => sees(scope, row);
  }
}

/** A page cursor as an offset (the start when absent or unreadable). */
export function offsetOf(cursor: string | undefined): number {
  return cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
}
