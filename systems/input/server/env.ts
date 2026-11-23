/**
 * The input system's tunables, an `@ayepi/env` slice.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

export const inputEnv = env({
  ...systemFields(),
  /** The most fields a form may have (`check_form` refuses more). */
  INPUT_MAX_FIELDS: z.number().int().min(1).default(20),
  /** How many names `save_form` tries (`project_details`, `project_details_2`, …) before giving up on a taken name. */
  INPUT_NAME_TRIES: z.number().int().min(1).max(50).default(10),
}).add(systemState('input'));

/** The input system's settings, resolved. */
export type InputSettings = ReturnType<typeof inputEnv.parse>;
