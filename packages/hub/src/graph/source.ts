/**
 * The `graph` list of the query standard: the graph's nodes as a list source, so `hub/query`, `listValues` (the search
 * box's values for the graph pages) and the graph endpoint answer the same query the same way. A page is the graph
 * `HubGraph` builds for the query's text and filters (capped), paged by the shared evaluator's cursor; it is `partial`
 * when the cap left nodes out.
 */
import type { FieldValueOption, GraphNode, ListField, ListQuery, Page } from '@harness/core';
import type { AccessService } from '../access/index.ts';
import { pageRows, valuesOf } from '../query/evaluate.ts';
import type { ListSource, QueryViewer } from '../query/index.ts';
import { GRAPH_EVALUATION, GRAPH_FIELDS, type HubGraph } from './graph.ts';

/** The graph's nodes as a list. */
export class GraphSource implements ListSource<'graph', GraphNode> {
  readonly list = 'graph';
  readonly fields = GRAPH_FIELDS;
  readonly #graph: HubGraph;
  readonly #access: Pick<AccessService, 'scope'>;
  readonly #page: number;

  constructor(options: { graph: HubGraph; access: Pick<AccessService, 'scope'>; page: number }) {
    this.#graph = options.graph;
    this.#access = options.access;
    this.#page = options.page;
  }

  async page(query: ListQuery, viewer: QueryViewer): Promise<Page<GraphNode> & { total: number; partial?: true }> {
    const found = await this.#graph.query({
      ...(query.text === undefined ? {} : { text: query.text }), ...(query.filters === undefined ? {} : { filters: query.filters }),
    }, await this.#access.scope(viewer.id));
    return {
      ...pageRows(found.nodes, query.cursor, query.limit ?? this.#page), total: found.total.nodes,
      ...(found.total.nodes > found.nodes.length ? { partial: true as const } : {}),
    };
  }

  /** A field's values over the global graph the viewer sees (capped): every system is always among its nodes. */
  async values(field: ListField<'graph'>, prefix: string | undefined, limit: number, viewer: QueryViewer): Promise<FieldValueOption[]> {
    const found = await this.#graph.query({}, await this.#access.scope(viewer.id));
    return valuesOf(found.nodes, GRAPH_EVALUATION, field, prefix, limit);
  }
}
