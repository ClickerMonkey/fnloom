/**
 * The code system's tunables, an `@ayepi/env` slice. How far a program may go is the shared program runtime's
 * (`programEnv` in `@harness/sdk/program`).
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';

export const codeEnv = env({
  ...systemFields(),
}).add(systemState('code'));

/** The code system's settings, resolved. */
export type CodeSettings = ReturnType<typeof codeEnv.parse>;
