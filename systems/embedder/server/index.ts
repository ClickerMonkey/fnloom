/**
 * The embedder system's server: a `GemmaClient` over product's EmbeddingGemma HTTP service, served as the
 * `document` and `query` embedders. Owner: the data lane (implements `HttpGemmaClient` and `main.ts`).
 */
import type { GemmaHealth, GemmaTask } from '../shared/index.ts';

/** Talks to the EmbeddingGemma service. An interface so tests use a fake. */
export interface GemmaClient {
  embed(texts: readonly string[], task: GemmaTask, signal?: AbortSignal): Promise<number[][]>;
  health(signal?: AbortSignal): Promise<GemmaHealth>;
}

export { embedderSystem } from '../shared/index.ts';
