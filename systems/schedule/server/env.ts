/**
 * The schedule system's tunables, an `@ayepi/env` slice. Its limits are the config an admin sets in the hub
 * (`Limits`), not env.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';

export const scheduleEnv = env({
  ...systemFields(),
}).add(systemState('schedule'));

/** The schedule system's settings, resolved. */
export type ScheduleSettings = ReturnType<typeof scheduleEnv.parse>;
