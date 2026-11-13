/**
 * The data system's tunables, an `@ayepi/env` slice. Boot parses it with the hub's other slices; the data service gets
 * the parsed values, never `process.env`.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Data system tunables. */
export const dataEnv = env({
  HARNESS_RECORD_PAGE: z.number().int().min(1).max(200).default(50).describe('Records per page when a request gives no limit.'),
  HARNESS_RECORD_SEARCH_DEPTH: z.number().int().min(10).max(2_000).default(200).describe('How many of the best text or meaning matches a record search ranks before it filters and pages them.'),
  HARNESS_DATA_SET_PAGE: z.number().int().min(1).max(200).default(50).describe('Stored types per page on the Data page when a request gives no limit.'),
});

/** The parsed data tunables. */
export type DataEnv = ReturnType<typeof dataEnv.parse>;
