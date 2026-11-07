/**
 * Embedding requests from everywhere (indexing, search, suggestions as people type, systems asking the hub) are
 * gathered into batches with `@ayepi/work`'s batch work: texts queued within a short wait go to their embedder in
 * one call. The queue is in memory: an embed is only worth doing for a caller that is still waiting.
 */
import { createWork, defineBatchWork } from '@ayepi/work';
import type { QualifiedName } from '@harness/core';
import type { Embedders } from './index.ts';

/** One text to embed with one embedder. */
interface EmbedItem {
  readonly embedder: QualifiedName;
  readonly text: string;
}

/** Batches embed calls per embedder. */
export class EmbedBatcher {
  readonly #work;
  readonly #embed;

  /**
   * `size` texts make a full batch; `wait` is how long a partial batch waits for more; `poll` is how often the
   * in-memory queue is checked for new texts (work polls; it is not woken by an enqueue).
   */
  constructor(options: { embedders: Embedders; size: number; wait: number; poll: number }) {
    const { embedders } = options;
    this.#embed = defineBatchWork('embed', {
      size: options.size,
      maxWait: options.wait,
      retry: { attempts: 1 },
      run: async (items: EmbedItem[]): Promise<number[][]> => {
        const out: number[][] = new Array<number[]>(items.length);
        const byEmbedder = new Map<QualifiedName, number[]>();
        items.forEach((item, i) => { byEmbedder.set(item.embedder, [...(byEmbedder.get(item.embedder) ?? []), i]); });
        for (const [name, indexes] of byEmbedder) {
          const embedder = embedders.get(name);
          if (embedder === undefined) { throw new Error(`the embedder ${name} is not connected`); }
          const vectors = await embedder.embed(indexes.map((i) => items[i]?.text ?? ''));
          indexes.forEach((at, i) => { out[at] = vectors[i] ?? []; });
        }
        return out;
      },
    });
    this.#work = createWork({ work: [this.#embed] as const, pollInterval: options.poll });
  }

  /** One vector per text, in order, from the named embedder. */
  embed(embedder: QualifiedName, texts: readonly string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.#work.enqueue(this.#embed({ embedder, text })).result()));
  }

  /** Stop the batch queue. */
  stop(): Promise<void> {
    return this.#work.stop();
  }
}
