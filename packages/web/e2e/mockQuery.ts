/**
 * The mock's reading of a list query: its plain `is` filters on text fields, as the old narrow fields (fn, status,
 * system, session). Enough for the pages the e2e tests open; the real hub evaluates every filter.
 */
import { LlmStatus, Modality, ModelCallStatus, PageRequest, RunId, RunStatus, SessionId, SystemName, type ListQuery } from '@harness/core';
import { z } from 'zod';

/** The narrow fields the mock filters runs by (the hub took these before every list took `query`). */
export const RunFilter = z.object({ status: RunStatus.optional(), fn: z.string().optional(), system: SystemName.optional(), session: SessionId.optional() });
export type RunFilter = z.infer<typeof RunFilter>;
/** The narrow fields the mock filters LLM calls by. */
export const LlmFilter = z.object({ status: LlmStatus.optional(), model: z.string().optional(), system: SystemName.optional(), session: SessionId.optional() });
export type LlmFilter = z.infer<typeof LlmFilter>;
/** The narrow fields the mock filters resources by. */
export const ResourceFilter = z.object({ search: z.string().optional(), system: SystemName.optional() });
export type ResourceFilter = z.infer<typeof ResourceFilter>;
/** The narrow fields the mock filters model calls by. */
export const ModelCallFilter = z.object({
  modality: Modality.optional(), model: z.string().optional(), system: SystemName.optional(), run: RunId.optional(), session: SessionId.optional(), status: ModelCallStatus.optional(),
});
export type ModelCallFilter = z.infer<typeof ModelCallFilter>;

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
export const ModelCallPage = PageRequest.extend(ModelCallFilter.shape);
export type ModelCallPage = z.infer<typeof ModelCallPage>;
export const SessionPage = PageRequest.extend({ search: z.string().optional(), archived: z.boolean().optional() });
