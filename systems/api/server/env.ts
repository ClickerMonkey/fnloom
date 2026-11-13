/**
 * The api system's tunables, an `@ayepi/env` slice. How far a program may go is the shared program runtime's
 * (`programEnv` in `@harness/sdk/program`).
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

export const apiEnv = env({
  ...systemFields(),
  /** The redirects one request follows, each kept under the service's base URL. */
  HARNESS_API_MAX_REDIRECTS: z.coerce.number().int().min(0).max(20).default(5),
}).add(systemState('api'));

/** The api system's settings, resolved. */
export type ApiSettings = ReturnType<typeof apiEnv.parse>;
