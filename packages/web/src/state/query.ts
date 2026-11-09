/**
 * A list's query in the URL: every searchable page keeps its `ListQuery` (words, filters, sort) in `?q=`, in the
 * written form a person types into the search box (`status:failed cost>0.01 sort:-cost read`), so a link, a refresh
 * and Back all restore it. The hub filters and sorts; the page sends `queryOf(...)` with its list call.
 */
import { LIST_FIELDS, type FieldDecl, type ListName, type ListQuery, type ListValuesQuery, type FieldValueOption } from '@harness/core';
import { computed, type WritableComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { formatBytes, formatCost, formatDuration, formatTokens } from '../chat/logic/format.ts';
import { readQuery, writeQuery, type NumberFormat, type SearchFields, type SearchQuery, type ValueOption } from '../ui/search.ts';

/** The URL key every list's query lives in. */
export const QUERY_KEY = 'q';

/** A list's fields, as the search box takes them. */
export function fieldsOf(list: ListName): SearchFields {
  return LIST_FIELDS[list].fields;
}

/** A list's query written for a link's `q` (`queryParam('runs', { filters: [{ field: 'fn', op: 'is', value: 'fs/read' }] })`). */
export function queryParam(list: ListName, query: SearchQuery): string {
  return writeQuery(fieldsOf(list), query);
}

/** A list's query read from a `q` value. */
export function readListQuery(list: ListName, written: string): SearchQuery {
  return readQuery(fieldsOf(list), written);
}

/** A number as its field's unit shows it elsewhere in the app: `$0.00042`, `1.2s`, `12.4k`, `4.2 KB`. */
export const formatFigure: NumberFormat = (value: number, decl: FieldDecl) => {
  switch (decl.unit) {
    case 'usd': return formatCost(value);
    case 'ms': return formatDuration(value);
    case 'tokens': return formatTokens(value);
    case 'bytes': return formatBytes(value);
    case 'count': case undefined: return value.toLocaleString();
  }
};

/** A page's list query, read from and written to `?q=` (replacing the history entry, as filters aren't places). */
export function useListQuery(list: ListName): WritableComputedRef<SearchQuery> {
  const route = useRoute();
  const router = useRouter();
  return computed({
    get: () => {
      const written = route.query[QUERY_KEY];
      return readListQuery(list, typeof written === 'string' ? written : '');
    },
    set: (query) => {
      const next = { ...route.query };
      const written = queryParam(list, query);
      if (written === '') { Reflect.deleteProperty(next, QUERY_KEY); } else { next[QUERY_KEY] = written; }
      void router.replace({ query: next, hash: route.hash });
    },
  });
}

/** A query for the hub: the words, filters and sort, without blanks. */
export function hubListQuery(query: SearchQuery): ListQuery {
  return {
    ...(query.text === undefined || query.text === '' ? {} : { text: query.text }),
    ...(query.filters === undefined || query.filters.length === 0 ? {} : { filters: query.filters }),
    ...(query.sort === undefined || query.sort.length === 0 ? {} : { sort: query.sort }),
  };
}

/**
 * A list request with its page (size and cursor) where the hub reads them: inside `query` when the body has one
 * (the hub then ignores the old top-level fields), at the top level otherwise.
 */
export function withPage<B extends object>(body: B & { readonly query?: ListQuery }, limit: number, cursor: string | undefined): B & { readonly limit?: number; readonly cursor?: string } {
  const page = { limit, ...(cursor === undefined ? {} : { cursor }) };
  return body.query === undefined ? { ...body, ...page } : { ...body, query: { ...body.query, ...page } };
}

/** The hub's `listValues` caller, as the search boxes use it. */
export interface ListValuesCaller {
  call(body: ListValuesQuery): Promise<readonly FieldValueOption[]>;
}

/** A list's value lookup for its search box: a field's values in the data matching what is typed. */
export function valuesOf(caller: ListValuesCaller, list: ListName): (field: string, prefix: string) => Promise<readonly ValueOption[]> {
  return async (field, prefix) => caller.call({ list, field, limit: 8, ...(prefix === '' ? {} : { prefix }) });
}

