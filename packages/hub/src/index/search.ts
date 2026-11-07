/**
 * Hybrid search over the index: the query is embedded with the query embedder and matched against stored vectors and
 * words at once, merged by reciprocal rank (the store's `HybridSearch`). With no embedder connected, or when
 * embedding the query fails, it is words alone. Results can be limited to some systems.
 */
import type { Logger } from '@ayepi/log';
import { compositeKey, type IndexedKind, type QualifiedName, type SearchHit, type SystemName } from '@harness/core';
import { messageOf } from '../catalog/scope.ts';
import type { HybridSearch } from '../store/hybrid.ts';
import type { HubStore } from '../store/index.ts';
import type { EmbedBatcher } from './batch.ts';
import type { Embedders, Search } from './index.ts';

/** What search needs. */
export interface IndexSearchOptions {
  readonly store: HubStore;
  readonly hybrid: Pick<HybridSearch, 'search'>;
  readonly embedders: Embedders;
  readonly batcher: EmbedBatcher;
  readonly log: Logger;
  /** The document embedder's name: items are stored, and vectors kept, under it. */
  readonly document: QualifiedName;
  /** How many times more candidates to ask for when results are filtered by system. */
  readonly overfetch: number;
}

/** Search over the store's vector and text indexes. */
export class IndexSearch implements Search {
  readonly #options: IndexSearchOptions;

  constructor(options: IndexSearchOptions) {
    this.#options = options;
  }

  async search(query: { text: string; kinds: readonly IndexedKind[]; limit: number; systems?: readonly SystemName[] | 'all' }): Promise<SearchHit[]> {
    const { store, hybrid, document, overfetch } = this.#options;
    const filtered = query.systems !== undefined && query.systems !== 'all';
    const vector = await this.#vector(query.text);
    const hits = await hybrid.search({
      text: query.text, kinds: query.kinds, limit: filtered ? query.limit * overfetch : query.limit,
      ...(vector === undefined ? {} : { vector: { embedder: document, values: vector } }),
    });
    const allowed = filtered ? new Set<string>(query.systems) : undefined;
    const out: SearchHit[] = [];
    for (const hit of hits) {
      const row = await store.table('index').get(compositeKey(document, hit.kind, hit.key));
      if (row === undefined || (allowed !== undefined && (row.system === undefined || !allowed.has(row.system)))) { continue; }
      out.push({ kind: hit.kind, key: hit.key, score: hit.score, text: row.text });
      if (out.length >= query.limit) { break; }
    }
    return out;
  }

  /** The query's embedding, or undefined to search by words alone. */
  async #vector(text: string): Promise<number[] | undefined> {
    const active = this.#options.embedders.active();
    if (active === undefined || text.trim() === '') { return undefined; }
    try {
      return (await this.#options.batcher.embed(active.query.name, [text]))[0];
    } catch (error) {
      this.#options.log.warn('index.search.embed.failed', { error: messageOf(error) });
      return undefined;
    }
  }
}
