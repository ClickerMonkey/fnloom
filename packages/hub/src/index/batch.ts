/**
 * Embedding requests from everywhere (indexing, search, suggestions as people type, systems asking the hub) are
 * gathered into batches with `@ayepi/work`'s batch work: inputs (texts, and images for the image space) queued within a short wait go to their embedder in
 * one call. Requests come in two lanes, each its own batch type with its own in-memory queue and `priorityDoer`:
 * `interactive` (a person or an agent is waiting: search and suggestions) and `background` (indexing, systems
 * embedding their data). A reindex fills only the background lane, which runs a few batches at a time, so what a
 * person types never queues behind it. The queues are in memory: an embed is only worth doing for a caller that is
 * still waiting.
 */
import type { Logger } from '@ayepi/log';
import { createWork, defineBatchWork, memoryQueue, priorityDoer } from '@ayepi/work';
import type { EmbedInput, QualifiedName } from '@harness/core';
import { messageOf } from '../catalog/scope.ts';
import type { Embedders } from './index.ts';

/** Who waits for an embedding: a person or agent now, or the index catching up. */
export type EmbedLane = 'interactive' | 'background';

/** One input (a text or an image) to embed with one embedder. */
interface EmbedItem {
  readonly embedder: QualifiedName;
  readonly input: EmbedInput;
}

/** How the batches are made and run. */
export interface EmbedBatcherOptions {
  readonly embedders: Embedders;
  readonly log: Logger;
  /** Texts that make a full batch. */
  readonly size: number;
  /** How long a partial batch waits for more after its first text. */
  readonly wait: number;
  /** How often the queues are checked for new texts (work polls; it is not woken by an enqueue). */
  readonly poll: number;
  /** How many batches of each lane run at once. */
  readonly concurrency: Readonly<Record<EmbedLane, number>>;
}

/** Embed a batch: the items grouped by embedder, one call each, the vectors put back in item order. */
function embedAll(embedders: Embedders): (items: EmbedItem[]) => Promise<number[][]> {
  return async (items) => {
    const out: number[][] = new Array<number[]>(items.length);
    const byEmbedder = new Map<QualifiedName, number[]>();
    items.forEach((item, i) => { byEmbedder.set(item.embedder, [...(byEmbedder.get(item.embedder) ?? []), i]); });
    for (const [name, indexes] of byEmbedder) {
      const embedder = embedders.get(name);
      if (embedder === undefined) { throw new Error(`the embedder ${name} is not connected`); }
      const vectors = await embedder.embed(indexes.map((i) => items[i]?.input ?? ''));
      indexes.forEach((at, i) => { out[at] = vectors[i] ?? []; });
    }
    return out;
  };
}

/** The batch work type of one lane. */
function laneWork<L extends EmbedLane>(lane: L, options: EmbedBatcherOptions) {
  return defineBatchWork(`embed.${lane}`, {
    size: options.size,
    maxWait: options.wait,
    retry: { attempts: 1 },
    run: embedAll(options.embedders),
    queue: memoryQueue(),
    doer: priorityDoer({ max: options.concurrency[lane] }),
    logContext: (item: EmbedItem) => ({ embedder: item.embedder, lane }),
  });
}

/** Batches embed calls per embedder, in two lanes. */
export class EmbedBatcher {
  readonly #lanes;
  readonly #work;

  constructor(options: EmbedBatcherOptions) {
    const { log } = options;
    const interactive = laneWork('interactive', options);
    const background = laneWork('background', options);
    this.#lanes = { interactive, background } as const;
    this.#work = createWork({
      work: [interactive, background] as const,
      pollInterval: options.poll,
      logWith: (add, inner) => log.logWith(add, inner),
      onError: (error, phase) => { log.warn('index.embed.engine', { phase, error: messageOf(error) }); },
    });
  }

  /** One vector per input, in order, from the named embedder, batched in the caller's lane. */
  embed(embedder: QualifiedName, inputs: readonly EmbedInput[], lane: EmbedLane): Promise<number[][]> {
    const work = this.#lanes[lane];
    return Promise.all(inputs.map((input) => this.#work.enqueue(work({ embedder, input })).result()));
  }

  /** Stop the batch queues. */
  stop(): Promise<void> {
    return this.#work.stop();
  }
}
