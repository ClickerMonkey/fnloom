/**
 * Hybrid search over the index: the query is embedded with the query embedder and matched against stored vectors and
 * words at once, merged by reciprocal rank (the store's `HybridSearch`). With no embedder connected, when embedding
 * the query fails or takes longer than `embedWait` (the embedder is busy, say indexing), or when the vectors can't be
 * searched with it (no vectors stored yet, or the query is another size), it is words alone, so a person or agent
 * waiting never waits on the embedder for long. Results can be limited to some systems and to what a `keep` check lets
 * through (what the person asking may see); a key `prefix` is applied by the database itself. Each hit says its place
 * in the order (`rank`, a share of the best) and, whenever the vectors were searched and it has one, its similarity of
 * meaning to the query (`similarity`, `store/hybrid.ts`); a search asking for `meaning` (suggestions) gets only hits
 * with a similarity, and none at all rather than ones words alone ranked, since a rank says nothing about fit. Each hit
 * also says which index found it (`matched`: words, meaning or both) and, for a part of an item (a context section),
 * the item it belongs to (`parent`).
 */
import type { Logger } from '@ayepi/log';
import { type QualifiedName, type SearchHit, type SearchMatchedBy } from '@harness/core';
import { messageOf } from '../catalog/scope.ts';
import type { FusedHit, HybridQuery, HybridSearch } from '../store/hybrid.ts';
import type { HubStore } from '../store/index.ts';
import type { EmbedBatcher } from './batch.ts';
import type { Embedders, Search, SearchQuery } from './index.ts';

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
  /** The longest the query's embedding is waited for, in ms (`HARNESS_SEARCH_EMBED_WAIT`). */
  readonly embedWait: number;
}

/** Which index found a hit: the one it ranks in, or both. */
export function matchedBy(hit: Pick<FusedHit, 'ranks'>): SearchMatchedBy {
  if (hit.ranks.vector === undefined) return 'words';
  return hit.ranks.text === undefined ? 'meaning' : 'both';
}

/** Search over the store's vector and text indexes. */
export class IndexSearch implements Search {
  readonly #options: IndexSearchOptions;

  constructor(options: IndexSearchOptions) {
    this.#options = options;
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const { store, hybrid, document, overfetch } = this.#options;
    const bySystem = query.systems !== undefined && query.systems !== 'all';
    const filtered = bySystem || query.keep !== undefined;
    const vector = query.match === 'text' ? undefined : await this.#vector(query.text);
    if (query.meaning === true && vector === undefined) { return []; }
    const words: HybridQuery = {
      text: query.text, kinds: query.kinds, limit: filtered ? query.limit * overfetch : query.limit,
      ...(query.within === undefined ? {} : { within: query.within }), ...(query.prefix === undefined ? {} : { prefix: query.prefix }),
      ...(query.match === undefined ? {} : { match: query.match }),
    };
    const hits = vector === undefined ? await hybrid.search(words) : await this.#hybrid({ ...words, vector: { embedder: document, values: vector } }, query.meaning === true ? undefined : words);
    const allowed = bySystem ? new Set<string>(query.systems) : undefined;
    const out: SearchHit[] = [];
    for (const hit of hits) {
      const row = await store.table('index').get({ embedder: document, kind: hit.kind, key: hit.key });
      if (row === undefined || (allowed !== undefined && (row.system === undefined || !allowed.has(row.system)))) { continue; }
      // an item with no vector yet has no measured meaning
      if (query.meaning === true && hit.similarity === undefined) { continue; }
      const found: SearchHit = {
        kind: hit.kind, key: hit.key, rank: hit.rank, ...(hit.similarity === undefined ? {} : { similarity: hit.similarity }),
        matched: matchedBy(hit), ...(row.parent === undefined ? {} : { parent: row.parent }), text: row.text,
      };
      if (query.keep !== undefined && !(await query.keep(found))) { continue; }
      out.push(found);
      if (out.length >= query.limit) { break; }
    }
    return out;
  }

  /** Search with the query's vector, or by words alone (when given) when the vectors can't be searched with it. */
  async #hybrid(withVector: HybridQuery, words: HybridQuery | undefined): Promise<FusedHit[]> {
    try {
      return await this.#options.hybrid.search(withVector);
    } catch (error) {
      this.#options.log.warn('index.search.vectors.failed', { embedder: this.#options.document, error: messageOf(error) });
      return words === undefined ? [] : this.#options.hybrid.search(words);
    }
  }

  /** The query's embedding, or undefined to search by words alone. */
  async #vector(text: string): Promise<number[] | undefined> {
    const active = this.#options.embedders.active();
    if (active === undefined || text.trim() === '') { return undefined; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, this.#options.embedWait); });
    try {
      const vector = await Promise.race([this.#options.batcher.embed(active.query.name, [text], 'interactive').then((vectors) => vectors[0]), late]);
      if (vector === undefined) { this.#options.log.warn('index.search.embed.slow', { wait: this.#options.embedWait }); }
      return vector;
    } catch (error) {
      this.#options.log.warn('index.search.embed.failed', { error: messageOf(error) });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
