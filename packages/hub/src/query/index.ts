/**
 * The query module (build 3, hub lane): every list served by one filter, sort and page model (`ListQuery` and
 * `LIST_FIELDS` in `@harness/core`). Each list registers a `ListSource`; the web list endpoints, `query`,
 * `listValues` and the hub fn `hub/query` all go through `QueryService`, so a person and the chat LLM get the same.
 */
import type { FieldValueOption, ListField, ListName, ListQuery, ListValuesQuery, Page, QueryFnArgs, QueryFnResult, UserView } from '@harness/core';

/** Who is asking: lists answer only what that person may read through the list's own endpoint. */
export type QueryViewer = Pick<UserView, 'id' | 'role'>;

/** How one field of a list reads off a row: the value filters and sorts compare (undefined is `empty`). */
export type FieldAccessors<L extends ListName, Row> = { readonly [F in ListField<L>]: (row: Row) => string | number | boolean | readonly string[] | undefined };

/** One list's rows. A source may push filters and sorts down to SQL; whatever it leaves, `QueryService` applies. */
export interface ListSource<L extends ListName, Row> {
  readonly list: L;
  readonly fields: FieldAccessors<L, Row>;
  /** A page of rows matching the query (checked with `queryProblems` first), in `sortOf(list, query)` order, with how many matched when known. */
  page(query: ListQuery, viewer: QueryViewer): Promise<Page<Row> & { total?: number }>;
  /** The values a field takes, with counts, matching `prefix`. */
  values(field: ListField<L>, prefix: string | undefined, limit: number, viewer: QueryViewer): Promise<FieldValueOption[]>;
}

/** Every list by name. A query with problems is refused with 422 and the problems in words. */
export interface QueryService {
  query(args: QueryFnArgs, viewer: QueryViewer): Promise<QueryFnResult>;
  values(args: ListValuesQuery, viewer: QueryViewer): Promise<FieldValueOption[]>;
}
