/**
 * The query module's tunables, an `@ayepi/env` slice. Boot parses it with the hub's other slices.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Query tunables. */
export const queryEnv = env({
  HARNESS_QUERY_SCAN: z.number().int().min(100).default(5_000).describe('The most rows a list query reads before filtering, sorting and paging them. Exact, number and date filters and number sorts go to the store first; a query cut by this says partial.'),
  HARNESS_QUERY_PAGE: z.number().int().min(1).max(200).default(50).describe('The rows a list query returns when it doesn\'t say how many.'),
  HARNESS_GRAPH_LIMIT: z.number().int().min(10).max(1_000).default(200).describe('The most nodes a graph answer holds when it does not say; past it, neighbours become "+N more" stubs.'),
  HARNESS_PICK_SCAN: z.number().int().min(50).default(2_000).describe('The most rows a picker reads from one table (fns, context, resources, people) before ranking them by what was typed.'),
  HARNESS_PICK_LIMIT: z.number().int().min(1).max(50).default(20).describe('The options a picker gets when it does not say how many.'),
});

/** The parsed query tunables. */
export type QueryEnv = ReturnType<typeof queryEnv.parse>;
