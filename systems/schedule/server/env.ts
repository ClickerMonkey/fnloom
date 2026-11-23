/**
 * The schedule system's tunables, an `@ayepi/env` slice. Its limits (the shortest gap, schedules and firings per
 * person, the grace window, approvals, how long firings are kept) are the config an admin sets in the hub (`Limits`),
 * not env; these are how the timer itself behaves.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const scheduleEnv = env({
  ...systemFields(),
  /** The timer's SQLite file in the instance's data folder: its queue of next firings and what it knows of each schedule. */
  SCHEDULE_DB: z.string().min(1).default('schedule.db'),
  /** How often the timer's queue looks for firings that are due, in milliseconds. */
  SCHEDULE_POLL: z.coerce.number().int().min(5).default(1_000),
  /** How late a firing may start and still count as on time (no "late" in its summary, and never missed), in milliseconds. */
  SCHEDULE_ON_TIME: z.coerce.number().int().min(0).default(MINUTE),
  /** How long a firing waits for its person's approval before it gives up (sooner when its next firing comes due), in milliseconds. */
  SCHEDULE_APPROVAL_WAIT: z.coerce.number().int().min(MINUTE).default(24 * HOUR),
  /** How long the timer waits before trying again to start a firing while the hub can't be reached, in milliseconds. */
  SCHEDULE_RETRY: z.coerce.number().int().min(10).default(30_000),
  /** How long one start of a firing may take before the hub counts as unreachable, in milliseconds. */
  SCHEDULE_START_TIMEOUT: z.coerce.number().int().min(100).default(30_000),
  /** A firing still marked running with no run of it left in this process (the system restarted) is failed after this, in milliseconds. */
  SCHEDULE_LOST_AFTER: z.coerce.number().int().min(MINUTE).default(26 * HOUR),
}).add(systemState('schedule'));

/** The schedule system's settings, resolved. */
export type ScheduleSettings = ReturnType<typeof scheduleEnv.parse>;
