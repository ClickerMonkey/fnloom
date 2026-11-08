/**
 * The query module's tunables, an `@ayepi/env` slice. Boot parses it with the hub's other slices.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Query tunables. */
export const queryEnv = env({
  HARNESS_QUERY_SCAN: z.number().int().min(100).default(5_000).describe('The most rows a list query reads before filtering, sorting and paging them. Exact, number and date filters and number sorts go to the store first; a query cut by this says partial.'),
  HARNESS_QUERY_PAGE: z.number().int().min(1).max(200).default(50).describe('The rows a list query returns when it doesn\'t say how many.'),
});

/** The parsed query tunables. */
export type QueryEnv = ReturnType<typeof queryEnv.parse>;
