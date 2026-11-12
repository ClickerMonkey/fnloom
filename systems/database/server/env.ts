/**
 * The database system's tunables, an `@ayepi/env` slice.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

export const databaseEnv = env({
  ...systemFields(),
  /** How many names save_query tries (`orders`, `orders_2`, …) before giving up on a taken name. */
  DATABASE_NAME_TRIES: z.number().int().min(1).max(50).default(10),
  /** Rows a list query reads when the caller gives no `limit`. */
  DATABASE_PAGE_ROWS: z.number().int().min(1).default(50),
  /** The most rows one call may read (and the person's result holds; more is paged with `offset`). */
  DATABASE_MAX_ROWS: z.number().int().min(1).default(500),
  /** Rows a clean draft's check shows the query authoring agent. */
  DATABASE_DRAFT_ROWS: z.number().int().min(1).max(50).default(5),
  /** Rows a write's approval preview shows. */
  DATABASE_PREVIEW_ROWS: z.number().int().min(1).default(20),
  /** A text column with at most this many distinct values has them all shown to the enricher. */
  DATABASE_DISTINCT_MAX: z.number().int().min(1).default(12),
  /** How many relation hops a table's generated fns follow for derived fields. */
  DATABASE_TABLE_FNS_DEPTH: z.number().int().min(0).max(4).default(2),
  /** The most fns table_fns_available lists for a table (the rest are counted as more). */
  DATABASE_TABLE_FNS_CAP: z.number().int().min(5).max(200).default(40),
  /** With the decision model off or failed: the least share of a request's words a database's tables must match to be picked. */
  DATABASE_PICK_MIN: z.number().min(0).max(1).default(0.2),
  /** With the decision model off or failed: how far the best database's match must lead the next one to be picked without asking. */
  DATABASE_PICK_MARGIN: z.number().min(0).max(1).default(0.15),
}).add(systemState('database'));

/** The database system's settings, resolved. */
export type DatabaseSettings = ReturnType<typeof databaseEnv.parse>;
