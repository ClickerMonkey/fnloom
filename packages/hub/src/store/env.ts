/** The store's tunables, as an `@ayepi/env` slice. Durations are milliseconds. */
import { env } from '@ayepi/env';
import { z } from 'zod';

export const storeEnv = env({
  /** How long a write waits for another process's write lock before failing. */
  HARNESS_DB_BUSY_TIMEOUT: z.number().int().min(0).default(5_000),
  /** Hybrid search: the reciprocal-rank constant (higher flattens the gap between ranks). */
  HARNESS_SEARCH_RRF_K: z.number().int().min(1).default(60),
  /** Hybrid search: each index is asked for `limit × depth` candidates before they are merged. */
  HARNESS_SEARCH_DEPTH: z.number().int().min(1).default(4),
  /** Expired key/value rows are swept every this many writes. */
  HARNESS_KV_SWEEP_EVERY: z.number().int().min(1).default(1_000),
});

/** The parsed store tunables. */
export type StoreTuning = ReturnType<typeof storeEnv.parse>;
