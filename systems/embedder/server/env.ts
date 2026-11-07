/** The embedder system's tunables, an `@ayepi/env` slice. Durations are milliseconds. */
import { env } from '@ayepi/env';
import { systemFields } from '@harness/sdk/server';
import { z } from 'zod';

export const embedderEnv = env({
  ...systemFields('embedder'),
  /** The EmbeddingGemma service, used when the system's config names none. */
  HARNESS_EMBEDDER_URL: z.string().default('http://127.0.0.1:8760'),
  /** Most texts per request (the service's own `max_batch` also caps it). */
  EMBEDDER_BATCH: z.number().int().min(1).default(64),
  /** Tries after a busy (429) or loading (503) answer before giving up. */
  EMBEDDER_RETRIES: z.number().int().min(0).default(4),
  /** How long to wait before a retry when the service doesn't say. */
  EMBEDDER_RETRY_DELAY: z.number().int().min(0).default(1_000),
  /** The longest wait before one retry, whatever the service says. */
  EMBEDDER_RETRY_MAX: z.number().int().min(0).default(15_000),
  /** How much of each backoff wait may be shaved off at random (0 to 1), so clients don't retry in step. */
  EMBEDDER_RETRY_JITTER: z.number().min(0).max(1).default(0.2),
  /** How long one request may take. */
  EMBEDDER_TIMEOUT: z.number().int().min(1).default(60_000),
  /** Query vectors kept for repeated searches (0 turns the cache off). */
  EMBEDDER_QUERY_CACHE: z.number().int().min(0).default(1_000),
});

/** The embedder system's settings, resolved. */
export type EmbedderSettings = ReturnType<typeof embedderEnv.parse>;
