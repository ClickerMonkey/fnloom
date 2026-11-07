/** Embeddings systems ask the hub for (`ctx.embed`): the document embedder, priced at its declared rate. */
import type { Catalog } from '../catalog/index.ts';
import type { LinkEmbedding } from '../link/handlers.ts';
import type { EmbedBatcher } from './batch.ts';
import type { Embedders } from './index.ts';

/** About four characters to a token, for pricing embeddings. */
const CHARS_PER_TOKEN = 4;

/** Embeds for systems with the document embedder, through the shared batches. */
export class IndexEmbedding implements LinkEmbedding {
  readonly #embedders: Embedders;
  readonly #batcher: EmbedBatcher;
  readonly #catalog: Catalog;

  constructor(options: { embedders: Embedders; batcher: EmbedBatcher; catalog: Catalog }) {
    this.#embedders = options.embedders;
    this.#batcher = options.batcher;
    this.#catalog = options.catalog;
  }

  async embed(texts: readonly string[]): Promise<{ vectors: number[][]; cost: number }> {
    const active = this.#embedders.active();
    if (active === undefined) { throw new Error('no embedder is connected'); }
    const vectors = await this.#batcher.embed(active.document.name, texts);
    const decl = (await this.#catalog.entries('embedders')).find((e) => e.name === active.document.name)?.decl;
    const tokens = texts.reduce((sum, text) => sum + Math.ceil(Math.min(text.length, active.document.maxInput) / CHARS_PER_TOKEN), 0);
    return { vectors, cost: ((decl?.pricePerMillionTokens ?? 0) * tokens) / 1_000_000 };
  }
}
