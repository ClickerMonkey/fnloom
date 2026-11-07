/**
 * The index module: embeddings from embedder systems (the `embedder` system wraps product's EmbeddingGemma, 768
 * dimensions), batched through `@ayepi/work`; hybrid search (vectors + full text, merged by reciprocal rank); the
 * suggestions shown in the composer and added to messages; and sectioning resources by structure.
 *
 * Owner: the hub-systems lane. `SystemEmbedders` (`embedders.ts`), `StoreIndexer` (`indexer.ts`), `IndexSearch`
 * (`search.ts`) and `IndexSuggester` (`suggester.ts`) implement the interfaces below; `EmbedBatcher` (`batch.ts`)
 * batches embeds, `Sectioning` (`sectioning.ts`) picks and runs sectioners (the hub's own are in `sectioners.ts`),
 * and `IndexEmbedding` (`embedding.ts`) answers systems that ask the hub to embed.
 */
import type { IndexedKind, QualifiedName, ResourceUri, SearchHit, SectionDiff, SessionId, SystemName } from '@harness/core';
import type { Suggestion } from '@harness/core';

/** An embed function: one vector per text, in order. */
export interface Embedder {
  readonly name: QualifiedName;
  readonly dimensions: number;
  readonly maxInput: number;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

/** The embedders systems provide, as they connect and go. */
export interface Embedders {
  get(name: QualifiedName): Embedder | undefined;
  /**
   * The pair the index uses: `document` embeds what is stored, `query` embeds what is searched for (same vector space,
   * different task prefix). Vectors live in the document embedder's table. Undefined until both are connected.
   */
  active(): { document: Embedder; query: Embedder } | undefined;
  onChange(listener: () => void): () => void;
}

/** One item to index: what it is, its key within that kind, its text, and the system it belongs to. */
export interface IndexItem {
  readonly kind: IndexedKind;
  readonly key: string;
  readonly text: string;
  readonly system?: SystemName;
}

/** Keeps the index current: fns, context, types, sections and messages, re-embedded only when their text changes. */
export interface Indexer {
  upsert(items: readonly IndexItem[]): Promise<void>;
  remove(kind: IndexedKind, keys: readonly string[]): Promise<void>;
  /** Re-index everything a system contributes (after a manifest import). */
  reindexSystem(system: SystemName): Promise<void>;
  /** Re-section a resource; returns what changed by section key. */
  resource(uri: ResourceUri): Promise<SectionDiff | undefined>;
}

/** Hybrid search. Falls back to words alone while no embedder is connected. */
export interface Search {
  search(query: { text: string; kinds: readonly IndexedKind[]; limit: number; systems?: readonly SystemName[] | 'all' }): Promise<SearchHit[]>;
}

/** Suggestions: fns and context that fit a message, from its embedding, limited to what the session allows. */
export interface Suggester {
  suggest(input: { session: SessionId; text: string; limit: number }): Promise<Suggestion[]>;
}
