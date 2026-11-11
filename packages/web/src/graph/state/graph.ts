/**
 * One graph view's state (the global graph page, or a system's Graph tab): the page of nodes and edges the hub answered
 * for the query shown. Asking again with the same query refreshes quietly; a newer query supersedes one on its way.
 */
import type { GraphPage, GraphQuery } from '@harness/core';
import { Loaded } from '../../state/loaded.ts';
import type { GraphApi } from '../api/graph.ts';

/** One graph view. */
export class GraphStore {
  readonly #api: GraphApi;
  readonly page = new Loaded<GraphPage>();
  #shown: GraphQuery | undefined;

  constructor(api: GraphApi) {
    this.#api = api;
  }

  /** Show the graph for a query (quietly when it is the one shown). */
  async show(query: GraphQuery): Promise<void> {
    const quiet = this.#shown !== undefined && JSON.stringify(query) === JSON.stringify(this.#shown) && this.page.value.value !== undefined;
    this.#shown = query;
    await this.page.load(() => this.#api.graph.call(query), "Couldn't load the graph.", quiet);
  }

  /** Ask again for the query shown. */
  async refresh(): Promise<void> {
    if (this.#shown !== undefined) { await this.show(this.#shown); }
  }
}
