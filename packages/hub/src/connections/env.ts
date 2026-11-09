/**
 * The connections module's tunables, an `@ayepi/env` slice. Durations are milliseconds.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Connection tunables. */
export const connectionsEnv = env({
  HARNESS_CONNECT_TIMEOUT: z.number().int().min(500).default(20_000).describe('How long a per-person system has to start, finish or end a connection.'),
  HARNESS_CONNECT_WINDOW: z.number().int().min(10_000).default(600_000).describe('How long a person has to come back from the provider\'s sign-in before the connect link stops working.'),
});

/** The parsed connection tunables. */
export type ConnectionsEnv = ReturnType<typeof connectionsEnv.parse>;
