/**
 * The mock's reading of a list query: its plain `is` filters on text fields, as the old narrow fields (fn, status,
 * system, session). Enough for the pages the e2e tests open; the real hub evaluates every filter.
 */
import { LlmFilter, PageRequest, ResourceFilter, RunFilter, type ListQuery } from '@harness/core';

/** The query's `is` filters with a text value, by field. */
export function isFilters(query: ListQuery): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const filter of query.filters ?? []) {
    if (filter.op === 'is' && typeof filter.value === 'string') { fields[filter.field] = filter.value; }
  }
  return fields;
}

/** A request's old fields with the list query's words, `is` filters and page laid over them (the query wins, as on the hub); parse the result with the old shape. */
export function legacyOf(body: { readonly query?: ListQuery | undefined }): Record<string, unknown> {
  const { query, ...rest } = body;
  if (query === undefined) { return rest; }
  return {
    ...rest, ...isFilters(query),
    ...(query.text === undefined ? {} : { search: query.text }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

/** The old request shapes the mock pages with, so a mapped query is checked before use. */
export const RunPage = PageRequest.extend(RunFilter.shape);
export const LlmPage = PageRequest.extend(LlmFilter.shape);
export const ResourcePage = PageRequest.extend(ResourceFilter.shape);
