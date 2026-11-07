/**
 * Hybrid search: the vector index and the text index asked for candidates, merged by reciprocal rank fusion. RRF
 * needs no score calibration between the two (cosine similarity and BM25 aren't on one scale): an item scores
 * `Σ 1 / (k + rank)` over the lists it appears in, so items both indexes rank well come first. Works on any
 * `VectorIndex` and `TextIndex`, so a Postgres store gets it too.
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

/** A merged hit: its fused score, and its rank in each list it came from (1 = best). */
export interface FusedHit extends Ranked {
  readonly score: number;
  readonly ranks: { readonly vector?: number; readonly text?: number };
}

/** What to search for. Without `vector` (no embedder connected) it is words alone. */
export interface HybridQuery {
  readonly text: string;
  readonly kinds: readonly IndexedKind[];
  readonly limit: number;
  /** The query's embedding and the embedder whose vectors to compare it with. */
  readonly vector?: { readonly embedder: QualifiedName; readonly values: readonly number[] };
}

/** Merge ranked lists by reciprocal rank: `Σ weight / (k + rank)`, best first; ties keep first-seen order. */
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
  return [...merged.values()].sort((a, b) => b.score - a.score);
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
    const depth = Math.floor(query.limit) * this.#tuning.HARNESS_SEARCH_DEPTH;
    const [vector, text] = await Promise.all([
      query.vector === undefined ? Promise.resolve([]) : this.#vectors.nearest(query.vector.embedder, query.vector.values, depth, query.kinds),
      this.#text.search({ text: query.text, kinds: query.kinds, limit: depth }),
    ]);
    return fuseRanks({ vector, text }, this.#tuning.HARNESS_SEARCH_RRF_K).slice(0, Math.floor(query.limit));
  }
}
