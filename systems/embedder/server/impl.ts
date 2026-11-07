/**
 * The embedder system's implementation: `document` and `query` embedders over a `GemmaClient`, query vectors kept in
 * a small LRU (searches repeat as people type), and the service URL following the system's config.
 */
import type { Log, SystemImpl } from '@harness/sdk';
import type { EmbedderContract, GemmaTask } from '../shared/index.ts';
import type { EmbedderConfig, GemmaClient } from './index.ts';

/** The most recently used vectors by text, up to a count. */
export class VectorCache {
  private readonly entries = new Map<string, number[]>();
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  get(text: string): number[] | undefined {
    const vector = this.entries.get(text);
    if (vector !== undefined) {
      // re-insert so it is the most recently used
      this.entries.delete(text);
      this.entries.set(text, vector);
    }
    return vector;
  }

  set(text: string, vector: number[]): void {
    if (this.max === 0) { return; }
    this.entries.delete(text);
    this.entries.set(text, vector);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.max) { break; }
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Embed texts, taking what the cache has and asking the client for the rest (each distinct text once). */
export async function embedCached(cache: VectorCache, texts: readonly string[], embed: (texts: string[]) => Promise<number[][]>): Promise<number[][]> {
  const missing = [...new Set(texts.filter((text) => cache.get(text) === undefined))];
  if (missing.length > 0) {
    const vectors = await embed(missing);
    missing.forEach((text, i) => { const vector = vectors[i]; if (vector !== undefined) { cache.set(text, vector); } });
  }
  return texts.map((text) => {
    const vector = cache.get(text);
    if (vector === undefined) { throw new Error('The embedder returned fewer vectors than texts.'); }
    return vector;
  });
}

/** What the implementation is built from. */
export interface EmbedderDeps {
  readonly client: GemmaClient;
  /** The URL used when the config names none. */
  readonly defaultUrl: string;
  readonly queryCache: number;
}

/** The implementation and the URL the client should use now. */
export interface EmbedderServer {
  readonly impl: SystemImpl<EmbedderContract['defs']>;
  url(): string;
}

/** Build the embedder implementation. */
export function createEmbedderImpl(deps: EmbedderDeps): EmbedderServer {
  const cache = new VectorCache(deps.queryCache);
  let url = deps.defaultUrl;
  const follow = async (config: EmbedderConfig, log: Log) => {
    const next = config.url ?? deps.defaultUrl;
    if (next !== url) { cache.clear(); }
    url = next;
    try {
      const health = await deps.client.health();
      log.info('embedder.ready', { url, model: health.model, status: health.status, dim: health.dim });
    } catch (error) {
      // embedding calls retry and fail on their own; starting must not, so the hub sees the system
      log.warn('embedder.unavailable', { url, detail: error instanceof Error ? error.message : 'unknown error' });
    }
  };
  const embed = (task: GemmaTask) => (texts: string[]) => deps.client.embed(texts, task);
  const impl: SystemImpl<EmbedderContract['defs']> = {
    embedders: {
      document: embed('document'),
      query: (texts) => embedCached(cache, texts, embed('query')),
    },
    lifecycle: {
      started: (ctx) => follow(ctx.config, ctx.log),
      configured: (ctx) => follow(ctx.config, ctx.log),
    },
  };
  return { impl, url: () => url };
}
