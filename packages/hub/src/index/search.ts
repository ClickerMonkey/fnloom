/**
 * Hybrid search over the index: the query is embedded with the query embedder and matched against stored vectors and
 * words at once, merged by reciprocal rank (the store's `HybridSearch`). With no embedder connected, when embedding
 * the query fails or takes longer than `embedWait` (the embedder is busy, say indexing), or when the vectors can't be
 * searched with it (no vectors stored yet, or the query is another size), it is words alone, so a person or agent
 * waiting never waits on the embedder for long. Results can be limited to some systems and to what a `keep` check lets
 * through (what the person asking may see); a key `prefix` and `excludeKeys` are applied by the database itself. Each hit says its place
 * in the order (`rank`, a share of the best) and, whenever the vectors were searched and it has one, its similarity of
 * meaning to the query (`similarity`, `store/hybrid.ts`); a search asking for `meaning` (suggestions) gets only hits
 * with a similarity, and none at all rather than ones words alone ranked, since a rank says nothing about fit. Each hit
 * also says which index found it (`matched`: words, meaning or both) and, for a part of an item (a context section),
 * the item it belongs to (`parent`).
 *
 * Pictures (`image` items) are searched in the image space (`Embedders.images`). When it is the text space (`shared`),
 * there is one search: a text query finds pictures beside text, and a picture query (`image`, embedded by the space's
 * embedder) finds both. When it is a second space, `image` items are searched there apart: by the picture query, or
 * by the text query embedded by the image embedder when it shares its space with text (`crossModal`), else by their
 * captions' words; the two lists are merged by rank. A picture query searches the text space by words alone (its
 * `text`), and with no image space a picture query finds nothing by meaning.
 */
import type { Logger } from '@ayepi/log';
import { type EmbedInput, type IndexedKind, type QualifiedName, type SearchHit, type SearchMatchedBy } from '@harness/core';
import { messageOf } from '../catalog/scope.ts';
import type { FusedHit, HybridQuery, HybridSearch } from '../store/hybrid.ts';
import type { HubStore } from '../store/index.ts';
import type { EmbedBatcher } from './batch.ts';
import type { Embedder, Embedders, ImageSpace, Search, SearchQuery } from './index.ts';

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

/** One vector space a search asks: its kinds, the table its vectors are in, and the query's vector there (none: words alone). */
interface SpaceAsk {
  readonly kinds: readonly IndexedKind[];
  readonly table: QualifiedName;
  readonly vector: readonly number[] | undefined;
}

/** Search over the store's vector and text indexes. */
export class IndexSearch implements Search {
  readonly #options: IndexSearchOptions;

  constructor(options: IndexSearchOptions) {
    this.#options = options;
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const { store, document, overfetch } = this.#options;
    const bySystem = query.systems !== undefined && query.systems !== 'all';
    const filtered = bySystem || query.keep !== undefined;
    const words: HybridQuery = {
      text: query.text, kinds: query.kinds, limit: filtered ? query.limit * overfetch : query.limit,
      ...(query.within === undefined ? {} : { within: query.within }), ...(query.prefix === undefined ? {} : { prefix: query.prefix }),
      ...(query.excludeKeys === undefined || query.excludeKeys.length === 0 ? {} : { excludeKeys: query.excludeKeys }),
      ...(query.match === undefined ? {} : { match: query.match }),
    };
    const lists = await Promise.all((await this.#spaces(query)).map((ask) => this.#ask(ask, words, query)));
    // two spaces' lists, each fused on its own, merge by rank (a share of each list's best, so the two compare)
    const hits = lists.length === 1 ? (lists[0] ?? []) : lists.flat().sort((a, b) => b.rank - a.rank);
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

  /**
   * The vector spaces the query asks, each with its kinds and the query's vector there: the text space (pictures too
   * when the image space is shared), and `image` items apart otherwise: in a second image space when there is one, by
   * their captions' words alone when there is none.
   */
  async #spaces(query: SearchQuery): Promise<SpaceAsk[]> {
    const { document, embedders } = this.#options;
    const semantic = query.match !== 'text';
    const space = embedders.images();
    // pictures are searched apart in a second space, and by their captions alone with no space (vectors left from one aren't asked)
    const apart = space === undefined || !space.shared;
    const textKinds = apart ? query.kinds.filter((kind) => kind !== 'image') : query.kinds;
    const imageKinds = apart ? query.kinds.filter((kind) => kind === 'image') : [];
    const asks: SpaceAsk[] = [];
    if (textKinds.length > 0) {
      const vector = !semantic ? undefined : query.image === undefined ? await this.#textVector(query.text)
        : space?.shared === true ? await this.#vector(space.embedder, query.image) : undefined;
      asks.push({ kinds: textKinds, table: document, vector });
    }
    if (imageKinds.length > 0) {
      const vector = semantic && space !== undefined ? await this.#imageSpaceVector(space, query) : undefined;
      asks.push({ kinds: imageKinds, table: space?.embedder.name ?? document, vector });
    }
    return asks;
  }

  /** Search one space: by its vector and words, or by words alone (none when meaning is asked and there is no vector, or nothing to match). */
  async #ask(ask: SpaceAsk, words: HybridQuery, query: SearchQuery): Promise<FusedHit[]> {
    const inSpace: HybridQuery = { ...words, kinds: ask.kinds };
    if (ask.vector === undefined) {
      return query.meaning === true || query.text.trim() === '' ? [] : this.#options.hybrid.search(inSpace);
    }
    return this.#hybrid({ ...inSpace, vector: { embedder: ask.table, values: ask.vector } }, query.meaning === true || query.text.trim() === '' ? undefined : inSpace);
  }

  /** Search with the query's vector, or by words alone (when given) when the vectors can't be searched with it. */
  async #hybrid(withVector: HybridQuery, words: HybridQuery | undefined): Promise<FusedHit[]> {
    try {
      return await this.#options.hybrid.search(withVector);
    } catch (error) {
      this.#options.log.warn('index.search.vectors.failed', { embedder: withVector.vector?.embedder, error: messageOf(error) });
      return words === undefined ? [] : this.#options.hybrid.search(words);
    }
  }

  /** The text query's embedding by the query embedder, or undefined to search by words alone. */
  #textVector(text: string): Promise<number[] | undefined> {
    const active = this.#options.embedders.active();
    return active === undefined || text.trim() === '' ? Promise.resolve(undefined) : this.#vector(active.query, text);
  }

  /** The query's vector in a second image space: the picture's, or the text's when the space shares it with text. */
  #imageSpaceVector(space: ImageSpace, query: SearchQuery): Promise<number[] | undefined> {
    if (query.image !== undefined) { return this.#vector(space.embedder, query.image); }
    return space.crossModal && query.text.trim() !== '' ? this.#vector(space.embedder, query.text) : Promise.resolve(undefined);
  }

  /** An input's embedding by an embedder, or undefined (words alone) when it fails or takes longer than `embedWait`. */
  async #vector(embedder: Embedder, input: EmbedInput): Promise<number[] | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, this.#options.embedWait); });
    try {
      const vector = await Promise.race([this.#options.batcher.embed(embedder.name, [input], 'interactive').then((vectors) => vectors[0]), late]);
      if (vector === undefined) { this.#options.log.warn('index.search.embed.slow', { embedder: embedder.name, wait: this.#options.embedWait }); }
      return vector;
    } catch (error) {
      this.#options.log.warn('index.search.embed.failed', { embedder: embedder.name, error: messageOf(error) });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
