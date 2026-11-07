/**
 * The embedder system's server: a `GemmaClient` over product's EmbeddingGemma HTTP service, served as the
 * `document` and `query` embedders. The parts are behind these interfaces so tests use fakes (a fake `fetch`, a fake
 * sleep) and `createEmbedderImpl` wires them to the contract.
 */
import type { ConfigOf } from '@harness/sdk';
import type { EmbedderContract, GemmaHealth, GemmaTask } from '../shared/index.ts';

/** The embedder system's config. */
export type EmbedderConfig = ConfigOf<EmbedderContract['defs']>;

/** Talks to the EmbeddingGemma service. An interface so tests use a fake. */
export interface GemmaClient {
  /** One 768-number vector per text, in order. */
  embed(texts: readonly string[], task: GemmaTask, signal?: AbortSignal): Promise<number[][]>;
  health(signal?: AbortSignal): Promise<GemmaHealth>;
}

/** Waits, or rejects when the signal aborts first. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export { embedderSystem } from '../shared/index.ts';
