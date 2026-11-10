/**
 * The random system's tunables, an `@ayepi/env` slice: where the hub is, where the system keeps its state.
 * Code reads these through `randomEnv.parse()` in `main.ts`, never `process.env`.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

/** The random system's env slice: the fields every system has (`systemFields`) and its own tunables. */
export const randomEnv = env({
  ...systemFields(),
  /** How long one random-number request may take. */
  RANDOM_TIMEOUT: z.number().int().min(1).default(30_000),
}).add(systemState('random'));

/** The random system's settings, resolved. */
export type RandomSettings = ReturnType<typeof randomEnv.parse>;
