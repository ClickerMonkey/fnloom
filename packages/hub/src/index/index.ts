/**
 * The index module: embeddings from embedder systems (the `embedder` system wraps product's EmbeddingGemma, 768
 * dimensions), batched through `@ayepi/work`; hybrid search (vectors + full text, merged by reciprocal rank); the
 * suggestions shown in the composer and added to messages; and sectioning resources by structure.
 *
 * Owner: the hub-systems lane. `SystemEmbedders` (`embedders.ts`), `StoreIndexer` (`indexer.ts`), `IndexSearch`
 * (`search.ts`) and `IndexSuggester` (`suggester.ts`) implement the interfaces below; `EmbedBatcher` (`batch.ts`)
 * batches embeds, and `Sectioning` (`sectioning.ts`) picks and runs sectioners (the hub's own are in `sectioners.ts`).
 * Systems that need embeddings ask through the hub link's `model` (modality `embed`), recorded like any model call.
 */
import type {
  ConvertedVersion, FormKind, IndexedKind, QualifiedName, ResourceLink, ResourceRoot, ResourceStat, ResourceUri, SearchHit, SectionDiff, SessionId, SystemName,
} from '@harness/core';
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
  /** The item this one is a part of (a `contextSection`'s context item). */
  readonly parent?: string;
}

/**
 * When an upsert resolves: once the items' vectors are stored too (`wait`), or once their words are, with the vectors
 * made in the background (`background`: a person waiting on a write doesn't wait on a busy embedder; search finds the
 * items by words at once and by meaning soon after).
 */
export type VectorTiming = 'wait' | 'background';

/** Keeps the index current: fns, context, types, sections and messages, re-embedded only when their text changes. */
export interface Indexer {
  upsert(items: readonly IndexItem[], options?: { readonly vectors?: VectorTiming }): Promise<void>;
  remove(kind: IndexedKind, keys: readonly string[]): Promise<void>;
  /** Re-index everything a system contributes (after a manifest import). */
  reindexSystem(system: SystemName): Promise<void>;
  /** Re-section a resource; returns what changed by section key. */
  resource(uri: ResourceUri): Promise<SectionDiff | undefined>;
  /**
   * Read resources through `reader` from now on (the resources module's forms: the hub's own resources, and each
   * resource's primary form instead of its raw text). Returns the stop, after which the router's raw text is read again.
   */
  readWith(reader: IndexReader): () => void;
}

/** A resource's text in the form sectioning and the index read. */
export interface PrimaryText {
  readonly stat: ResourceStat;
  readonly links: ResourceLink[];
  readonly text: string;
  /** The form the text is of; the raw text when absent. */
  readonly form?: FormKind;
  /** The converted version the text is of, for sectioners that cut by structure (`hub/tables`). */
  readonly version?: ConvertedVersion;
}

/** Where the indexer reads resources from, when not straight from the router. */
export interface IndexReader {
  /** The system that serves a URI and its root's index policy, or undefined when nothing serves it. */
  route(uri: ResourceUri): { system: SystemName; index: ResourceRoot['index'] } | undefined;
  /** A resource's text in its primary form. Never spends on a model unless the hub is set to (`HARNESS_DESCRIBE_ON_INDEX`). */
  primary(uri: ResourceUri, signal?: AbortSignal): Promise<PrimaryText>;
  /** A resource indexed before was cut again and some of its sections changed or went away. */
  sectioned(diff: SectionDiff): Promise<void>;
}

/** What a search asks for. */
export interface SearchQuery {
  readonly text: string;
  readonly kinds: readonly IndexedKind[];
  readonly limit: number;
  /** Only hits from these systems (all when undefined or `all`). */
  readonly systems?: readonly SystemName[] | 'all';
  /**
   * Only hits this keeps, checked before the limit is counted (more candidates are asked for, as with `systems`).
   * Used to keep to what the person asking may see (`access/hits.ts`).
   */
  readonly keep?: (hit: SearchHit) => boolean | Promise<boolean>;
  /** Only these items: the ones a filter in the database let through (build 5). */
  readonly within?: ReadonlyArray<{ readonly kind: IndexedKind; readonly key: string }>;
  /** Only items whose key starts with this, applied by the database (no extra candidates needed). */
  readonly prefix?: string;
  /** Never items with these keys, of any kind, applied by the database (no extra candidates needed). */
  readonly excludeKeys?: readonly string[];
  /** Words, meaning, or both (the default). */
  readonly match?: 'text' | 'semantic' | 'hybrid';
  /**
   * Only hits with a `similarity` of meaning: none at all when the query can't be embedded in time or its vector
   * searched, and none without a vector, instead of hits ranked by words alone (whose `rank` only says where they
   * came, so the first always reads 1). For what must judge fit, like suggestions.
   */
  readonly meaning?: boolean;
}

/** Hybrid search. Falls back to words alone while no embedder is connected. */
export interface Search {
  search(query: SearchQuery): Promise<SearchHit[]>;
}

/** Suggestions: fns and context that fit a message, from its embedding, limited to what the session allows. */
export interface Suggester {
  suggest(input: { session: SessionId; text: string; limit: number }): Promise<Suggestion[]>;
  /**
   * Every candidate the index finds for a message, best first, up to `pool`: those the session may be offered, and
   * those a rule hides (another system, unavailable, not to be suggested), so what was left out can be told too.
   */
  consider(input: { session: SessionId; text: string; pool: number }): Promise<Considered>;
}

/** What `Suggester.consider` found: the offerable candidates and the hidden ones, each best first. */
export interface Considered {
  readonly offered: Suggestion[];
  readonly hidden: Array<Pick<Suggestion, 'kind' | 'name' | 'score'>>;
}
