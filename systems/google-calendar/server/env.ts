/**
 * The Google Calendar system's tunables, an `@ayepi/env` slice. The OAuth client is the admin's config, not here.
 * Durations are milliseconds.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

export const calendarEnv = env({
  ...systemFields(),
  /** How long one call to Google may take. */
  CALENDAR_TIMEOUT: z.number().int().min(1_000).default(20_000),
  /** Refresh an access token this long before it runs out. */
  CALENDAR_REFRESH_SKEW: z.number().int().min(0).default(60_000),
  /** Events one list or search gives when the caller asks for no number. */
  CALENDAR_LIMIT: z.number().int().min(1).max(250).default(25),
  /** How far ahead `list_events` looks when no end is given. */
  CALENDAR_LIST_AHEAD: z.number().int().min(60_000).default(7 * 86_400_000),
  /** How far back and ahead `search_events` looks when no range is given. */
  CALENDAR_SEARCH_BACK: z.number().int().min(0).default(30 * 86_400_000),
  CALENDAR_SEARCH_AHEAD: z.number().int().min(60_000).default(365 * 86_400_000),
}).add(systemState('google-calendar'));

/** The system's settings, resolved. */
export type CalendarSettings = ReturnType<typeof calendarEnv.parse>;
