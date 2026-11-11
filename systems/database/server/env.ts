/**
 * The database system's tunables, an `@ayepi/env` slice.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

export const databaseEnv = env({
  ...systemFields(),
  /** How many times the enricher may try again after an answer is refused. */
  DATABASE_AUTHOR_RETRIES: z.number().int().min(0).max(5).default(2),
  /** How many names save_query tries (`orders`, `orders_2`, …) before giving up on a taken name. */
  DATABASE_NAME_TRIES: z.number().int().min(1).max(50).default(10),
  /** Rows a list query reads when the caller gives no `limit`. */
  DATABASE_PAGE_ROWS: z.number().int().min(1).default(50),
  /** The most rows one call may read (and the person's result holds; more is paged with `offset`). */
  DATABASE_MAX_ROWS: z.number().int().min(1).default(500),
  /** Rows a write's approval preview shows. */
  DATABASE_PREVIEW_ROWS: z.number().int().min(1).default(20),
  /** A text column with at most this many distinct values has them all shown to the enricher. */
  DATABASE_DISTINCT_MAX: z.number().int().min(1).default(12),
}).add(systemState('database'));

/** The database system's settings, resolved. */
export type DatabaseSettings = ReturnType<typeof databaseEnv.parse>;
