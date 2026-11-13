/**
 * The tables module's tunables (widget pass), an `@ayepi/env` slice: the streamed export's page size and row ceiling. Boot parses it with the hub's other slices.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Table result tunables. */
export const tablesEnv = env({
  HARNESS_EXPORT_PAGE: z.number().int().min(1).max(5_000).default(500).describe('Rows per page a streamed export asks its read fn for; each page is written and let go before the next.'),
  HARNESS_EXPORT_MAX_ROWS: z.number().int().min(1).default(100_000).describe('The most rows one export writes; a file cut there ends with a line saying so.'),
});

/** The parsed table tunables. */
export type TablesEnv = ReturnType<typeof tablesEnv.parse>;
