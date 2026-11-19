/**
 * Hybrid search: the vector index and the text index asked for candidates, merged by reciprocal rank fusion. RRF
 * needs no score calibration between the two (cosine similarity and BM25 aren't on one scale): an item ranks by
 * `Σ 1 / (k + rank)` over the lists it appears in, so items both indexes rank well come first.
 *
 * The order is the fusion's; the score is not. A fused rank only says where an item came, never how well it fits: the
 * first of any search would score 1 and the twelfth still 0.85 (k = 60), whatever was asked, so no threshold could
 * ever tell a fit from noise (the "You there?" chat, 2026-11-17, offered the web fns at 0.94 to 1 for every message).
 * So when the query's vector was searched, a hit's score is its similarity of meaning to the query (cosine, 0 to 1,
 * read from the database for every hit returned, including those only the words found) and `similarity` says so; an
 * item with no vector yet scores 0 and has none. With words alone there is no measure of fit: the score is then the
 * fused rank as a share of the best possible (first in the list), for ordering only, and no hit has a `similarity`.
 * Works on any `VectorIndex` and `TextIndex`, so a Postgres store gets it too.
 */
import type { IndexedKind, QualifiedName } from '@harness/core';
import { compositeKey } from '@harness/core';
import type { StoreTuning } from './env.ts';
import type { TextIndex, VectorIndex } from './index.ts';

/** An item found by search. */
export interface Ranked {
  readonly kind: IndexedKind;
  readonly key: string;
}

/** A merged hit: its score and similarity (see the file's notes), and its rank in each list it came from (1 = best). */
export interface FusedHit extends Ranked {
  /** Its similarity of meaning when the query's vector was searched; its share of the best fused rank with words alone. */
  readonly score: number;
  /** Its similarity of meaning to the query (0 to 1), when the query's vector was searched and the item has a vector. */
  readonly similarity?: number;
  readonly ranks: { readonly vector?: number; readonly text?: number };
}

/** What to search for. Without `vector` (no embedder connected) it is words alone. */
export interface HybridQuery {
  readonly text: string;
  readonly kinds: readonly IndexedKind[];
  readonly limit: number;
  /** The query's embedding and the embedder whose vectors to compare it with. */
  readonly vector?: { readonly embedder: QualifiedName; readonly values: readonly number[] };
  /** Only these items (filters the database applied first); absent searches everything of `kinds`. */
  readonly within?: readonly Ranked[];
  /** Only items whose key starts with this (the database applies it in both indexes). */
  readonly prefix?: string;
  /** Leave out the words (`semantic`), or the vectors (`text`); both by default. */
  readonly match?: 'text' | 'semantic' | 'hybrid';
}

/**
 * Merge ranked lists by reciprocal rank, `Σ 1 / (k + rank)` divided by the best possible (`lists / (k + 1)`), best
 * first; ties keep first-seen order. The score is a share of the best rank, not a measure of fit.
 */
export function fuseRanks<L extends string>(
  lists: Readonly<Record<L, readonly Ranked[]>>,
  k: number,
): Array<Ranked & { score: number; ranks: Partial<Record<L, number>> }> {
  type Hit = Ranked & { score: number; ranks: Partial<Record<L, number>> };
  const merged = new Map<string, Hit>();
  for (const [name, list] of entries(lists)) {
    list.forEach((item, index) => {
      const id = compositeKey(item.kind, item.key);
      const fresh: Hit = { kind: item.kind, key: item.key, score: 0, ranks: {} };
      const hit = merged.get(id) ?? fresh;
      // an item listed twice in one list counts at its best rank only
      if (hit.ranks[name] !== undefined) return;
      hit.ranks[name] = index + 1;
      hit.score += 1 / (k + index + 1);
      merged.set(id, hit);
    });
  }
  const best = entries(lists).length / (k + 1);
  return [...merged.values()].map((hit) => ({ ...hit, score: hit.score / best })).sort((a, b) => b.score - a.score);
}

function entries<L extends string, V>(record: Readonly<Record<L, V>>): Array<[L, V]> {
  const out: Array<[L, V]> = [];
  for (const name in record) out.push([name, record[name]]);
  return out;
}

/** Hybrid search over a store's indexes. */
export class HybridSearch {
  readonly #vectors: VectorIndex;
  readonly #text: TextIndex;
  readonly #tuning: Pick<StoreTuning, 'HARNESS_SEARCH_RRF_K' | 'HARNESS_SEARCH_DEPTH'>;

  constructor(indexes: { readonly vectors: VectorIndex; readonly text: TextIndex }, tuning: Pick<StoreTuning, 'HARNESS_SEARCH_RRF_K' | 'HARNESS_SEARCH_DEPTH'>) {
    this.#vectors = indexes.vectors;
    this.#text = indexes.text;
    this.#tuning = tuning;
  }

  /** The best `limit` items for the query, from both indexes. */
  async search(query: HybridQuery): Promise<FusedHit[]> {
    if (query.limit < 1 || query.kinds.length === 0) return [];
    const limit = Math.floor(query.limit);
    const depth = limit * this.#tuning.HARNESS_SEARCH_DEPTH;
    const vector = query.match === 'text' ? undefined : query.vector;
    const useText = query.match !== 'semantic' || vector === undefined;
    const [near, text] = await Promise.all([
      vector === undefined ? Promise.resolve([]) : this.#vectors.nearest(vector.embedder, vector.values, depth, query.kinds, query.within, query.prefix),
      useText ? this.#text.search({ text: query.text, kinds: query.kinds, limit: depth, ...(query.within === undefined ? {} : { within: query.within }), ...(query.prefix === undefined ? {} : { prefix: query.prefix }) }) : Promise.resolve([]),
    ]);
    const k = this.#tuning.HARNESS_SEARCH_RRF_K;
    if (vector === undefined) return fuseRanks({ text }, k).slice(0, limit);
    const fused = (useText ? fuseRanks({ vector: near, text }, k) : fuseRanks({ vector: near }, k)).slice(0, limit);
    const similar = await this.#similarities(vector, near, fused, query.kinds);
    return fused.map((hit) => {
      const similarity = similar.get(compositeKey(hit.kind, hit.key));
      return similarity === undefined ? { kind: hit.kind, key: hit.key, score: 0, ranks: hit.ranks } : { kind: hit.kind, key: hit.key, score: similarity, similarity, ranks: hit.ranks };
    });
  }

  /**
   * Every hit's similarity to the query: from the vector list, and for hits only the words found, from the database
   * (a nearest search kept to them, so no vector leaves it). An item with no vector has none.
   */
  async #similarities(vector: NonNullable<HybridQuery['vector']>, near: ReadonlyArray<Ranked & { score: number }>, hits: readonly Ranked[], kinds: readonly IndexedKind[]): Promise<Map<string, number>> {
    const out = new Map<string, number>(near.map((hit) => [compositeKey(hit.kind, hit.key), hit.score]));
    const missing = hits.filter((hit) => !out.has(compositeKey(hit.kind, hit.key)));
    if (missing.length === 0) return out;
    for (const hit of await this.#vectors.nearest(vector.embedder, vector.values, missing.length, kinds, missing)) {
      out.set(compositeKey(hit.kind, hit.key), hit.score);
    }
    return out;
  }
}
