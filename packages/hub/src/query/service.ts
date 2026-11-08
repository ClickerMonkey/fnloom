/**
 * `QueryService` over the list sources: checks a query with `queryProblems` (422 with the problems in words), runs it
 * through the list's source, and answers rows as JSON with the sort applied, for the `query` endpoint and `hub/query`.
 * The list endpoints call `page` for their own typed rows.
 */
import { reject } from '@ayepi/core';
import { fieldOf, queryProblems, sortOf, type ListField, type FieldValueOption, type Json, type ListName, type ListQuery, type ListValuesQuery, type Page, type QueryFnArgs, type QueryFnResult } from '@harness/core';
import type { QueryService, QueryViewer } from './index.ts';
import type { ListRows, ListSources } from './sources.ts';

/** A value as JSON: objects without their undefined fields, arrays and scalars as they are, anything else dropped. */
export function toJson(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return value; }
  if (Array.isArray(value)) { return value.map((item: unknown) => (item === undefined ? null : toJson(item))); }
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) { if (item !== undefined && typeof item !== 'function') { out[key] = toJson(item); } }
    return out;
  }
  return null;
}

/** The query service, plus each list's typed page for its own endpoint. */
export class HubQuery implements QueryService {
  readonly #sources: ListSources;

  constructor(sources: ListSources) {
    this.#sources = sources;
  }

  /** A list's typed page for its endpoint; refuses a query with problems (422). */
  async page<L extends ListName>(list: L, query: ListQuery, viewer: QueryViewer): Promise<Page<ListRows[L]> & { total?: number; partial?: true }> {
    const problems = queryProblems(list, query);
    if (problems.length > 0) { throw reject(422, 'BAD_QUERY', problems.join(' ')); }
    const source: ListSources[L] = this.#sources[list];
    return source.page(query, viewer);
  }

  async query(args: QueryFnArgs, viewer: QueryViewer): Promise<QueryFnResult> {
    const found = await this.page(args.list, args.query, viewer);
    return {
      items: found.items.map(toJson), sort: [...sortOf(args.list, args.query)],
      ...(found.cursor === undefined ? {} : { cursor: found.cursor }), ...(found.total === undefined ? {} : { total: found.total }), ...(found.partial === true ? { partial: true } : {}),
    };
  }

  values(args: ListValuesQuery, viewer: QueryViewer): Promise<FieldValueOption[]> {
    return this.#values(args.list, args.field, args.prefix, args.limit ?? VALUES, viewer);
  }

  async #values<L extends ListName>(list: L, field: string, prefix: string | undefined, limit: number, viewer: QueryViewer): Promise<FieldValueOption[]> {
    if (!isField(list, field)) { throw reject(422, 'BAD_QUERY', `${list} has no field "${field}".`); }
    const source: ListSources[L] = this.#sources[list];
    return source.values(field, prefix, limit, viewer);
  }
}

/** How many values `listValues` answers when not asked. */
const VALUES = 20;

/** Whether a name is one of a list's fields. */
function isField<L extends ListName>(list: L, field: string): field is ListField<L> {
  return fieldOf(list, field) !== undefined;
}
