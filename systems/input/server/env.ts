/**
 * The input system's tunables, an `@ayepi/env` slice. Durations are milliseconds.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

export const inputEnv = env({
  ...systemFields(),
  /** How close (cosine, 0 to 1) a saved form's description must be to what `get_input` asks for to be reused. */
  INPUT_REUSE_SCORE: z.number().min(0).max(1).default(0.82),
  /** How many times the form agent may try again after writing a form gin refuses. */
  INPUT_AUTHOR_RETRIES: z.number().int().min(0).max(5).default(2),
  /** The most fields a written form may have. */
  INPUT_MAX_FIELDS: z.number().int().min(1).default(20),
}).add(systemState('input'));

/** The input system's settings, resolved. */
export type InputSettings = ReturnType<typeof inputEnv.parse>;
