/**
 * The resources module's tunables, an `@ayepi/env` slice. Sizes are bytes, durations milliseconds. Boot parses it with
 * the hub's other slices.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Resource tunables. */
export const resourcesEnv = env({
  HARNESS_CONTENT_AT: z.enum(['files', 'database']).default('files').describe('Where raw content and forms are kept: files under the data folder, or the hub\'s database.'),
  HARNESS_IMPORT_MAX: z.number().int().min(1).default(200 * 1024 * 1024).describe('The largest raw content the hub accepts, in bytes.'),
  HARNESS_SNAPSHOT_MAX: z.number().int().min(0).default(2 * 1024 * 1024 * 1024).describe('Bytes of system resources\' raw snapshots kept before the oldest are dropped (their forms are kept).'),
  HARNESS_TABLE_ROWS: z.number().int().min(10).default(5_000).describe('Rows kept per table in a `table` form; the real count is kept beside it.'),
  HARNESS_DESCRIBE_ON_INDEX: z.boolean().default(false).describe('Describe and read text in images while indexing (else only when someone reads them).'),
  HARNESS_FORM_CONCURRENCY: z.number().int().min(1).default(2).describe('Forms made at once.'),
  HARNESS_CONTEXT_PIECE_TOKENS: z.number().int().min(50).default(600).describe('A section longer than this becomes a chain of context pieces (small-model friendly).'),
  HARNESS_FETCH_TIMEOUT: z.number().int().min(1_000).default(30_000).describe('How long a URL import waits when the web system isn\'t connected and the hub fetches itself.'),
  HARNESS_FETCH_REDIRECTS: z.number().int().min(0).default(8).describe('The most redirects a URL import the hub fetches itself follows.'),
  HARNESS_FETCH_PRIVATE: z.boolean().default(false).describe('Allow importing private and loopback addresses (off: the hub\'s own data can\'t be fetched by asking).'),
});

/** The parsed resource tunables. */
export type ResourcesEnv = ReturnType<typeof resourcesEnv.parse>;
