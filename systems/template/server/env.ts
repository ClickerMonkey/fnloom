/**
 * The template system's tunables, an `@ayepi/env` slice: where the hub is, where the system keeps its state, and any
 * tunable of its own. Durations are milliseconds with no unit suffix. Code reads these through `templateEnv.parse()`
 * in `main.ts`, never `process.env`, and passes what it needs to `createImpl`.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';

/** The template system's env slice: the fields every system has (`systemFields`) and its own tunables. */
export const templateEnv = env({
  ...systemFields(),
  // TODO: add tunables, each a zod schema (`import { z } from 'zod'`) with its default and a TSDoc line saying what it
  // is, named with the system's name in capitals as a prefix (fs uses `FS_`):
  //   /** How long one request to the service may take. */
  //   <NAME>_TIMEOUT: z.number().int().min(1).default(30_000),
}).add(systemState('template'));

/** The template system's settings, resolved. */
export type TemplateSettings = ReturnType<typeof templateEnv.parse>;
