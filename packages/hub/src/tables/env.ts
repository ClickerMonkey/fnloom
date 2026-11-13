/**
 * The tables module's tunables (widget pass), an `@ayepi/env` slice: the streamed export's page size and row ceiling, and how long a quiet read may run. Boot parses it with the hub's other slices.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Table result tunables. */
export const tablesEnv = env({
  HARNESS_EXPORT_PAGE: z.number().int().min(1).max(500).default(500).describe('Rows per page a streamed export asks its read fn for (at most 500, the most hub/records_table gives at once); each page is written and let go before the next.'),
  HARNESS_QUIET_READ_TIMEOUT: z.number().int().min(1_000).default(120_000).describe('How long a quiet read (a widget page, range, drill or refresh outside a chat) or one export page may run before it is stopped; a run waiting for approval there is refused at once, since nobody can approve it.'),
  HARNESS_EXPORT_MAX_ROWS: z.number().int().min(1).default(100_000).describe('The most rows one export writes; a file cut there ends with a line saying so.'),
});

/** The parsed table tunables. */
export type TablesEnv = ReturnType<typeof tablesEnv.parse>;
