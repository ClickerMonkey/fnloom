/**
 * The schedule system's own shapes, zod first (docs/plans/schedule-system.md, "Types (final, for approval)"): a
 * schedule's payload and its `when` (dayspan's `ScheduleInput` as Oryoli stores it), what the args program reads
 * (`fire`, `previous`), a firing record and a schedule as the chat and the pages show it. The hub never reads these, so
 * they stay out of core; the contract (`index.ts`) makes them gin with `ginAs`, and every TypeScript type here is
 * `z.infer`, never written twice. The server and the browser parse values with these schemas, which also fills in the
 * defaults.
 */
import { z } from 'zod';
import { ActorId, GinExprDef, Json, QualifiedName, RunId, Timestamp, Usd } from '@harness/core';
import { isIanaZone } from './zoned.ts';

/** A local day, `YYYY-MM-DD`, read in the schedule's zone. */
export const LocalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).brand<'LocalDay'>();
export type LocalDay = z.infer<typeof LocalDay>;
/** A time of day, `HH:mm` (24-hour). */
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).brand<'ClockTime'>();
export type ClockTime = z.infer<typeof ClockTime>;
/** One firing: a whole day (`2026-12-25`) or one time of a timed schedule (`2026-12-24T18:00`), as dayspan's exclude/include take it. */
export const OccurrenceKey = z.string().regex(/^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/).brand<'OccurrenceKey'>();
export type OccurrenceKey = z.infer<typeof OccurrenceKey>;
/** An IANA time zone (`America/New_York`), checked with Intl. */
export const Zone = z.string().refine(isIanaZone, 'an IANA time zone, such as America/New_York').brand<'Zone'>();
export type Zone = z.infer<typeof Zone>;
/** dayspan's `{ every, offset }`: every N (days, weeks, months, years), `offset` units after the start. */
export const Every = z.object({ every: z.number().int().min(1), offset: z.number().int().min(0).optional() }).strict();
export type Every = z.infer<typeof Every>;

const days = (min: number, max: number) => z.array(z.number().int().min(min).max(max)).min(1).optional();

/** The day rules of a `When`: any of them makes it repeat, so none may sit beside `on`. */
export const DAY_RULES = [
  'dayOfWeek', 'dayOfMonth', 'lastDayOfMonth', 'weekspanOfMonth', 'lastWeekspanOfMonth', 'weekOfMonth', 'weekOfYear', 'month', 'year',
  'daysSinceEpoch', 'weeksSinceEpoch', 'monthsSinceEpoch',
] as const;

/** The parts of a `When` its rules read (its parsed fields, before the rules run). */
type WhenFields = Partial<Record<(typeof DAY_RULES)[number], unknown>> & {
  readonly on?: string | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly maxOccurrences?: number | undefined;
  readonly times?: readonly string[] | undefined;
};

/**
 * Every problem with a `When` beyond its fields' own shapes, in words: `on` or day rules, not both (a one-off has no
 * start, end or count either); `maxOccurrences` needs `start`; `start` is not after `end`; times are unique. The
 * shortest gap between times is the system's config (`minGap`), so `gapProblems` checks it where the config is read.
 */
export function whenRuleProblems(when: WhenFields): string[] {
  const problems: string[] = [];
  const rules = DAY_RULES.filter((rule) => when[rule] !== undefined);
  if (when.on !== undefined && rules.length > 0) {
    problems.push(`\`on\` is a one-off, so it can't have day rules too (${rules.join(', ')}): give \`on\`, or the rules.`);
  }
  if (when.on !== undefined && (when.start !== undefined || when.end !== undefined || when.maxOccurrences !== undefined)) {
    problems.push('`on` is a one-off, so it has no `start`, `end` or `maxOccurrences`.');
  }
  if (when.maxOccurrences !== undefined && when.start === undefined) {
    problems.push('`maxOccurrences` counts from `start`, so it needs `start`.');
  }
  if (when.start !== undefined && when.end !== undefined && when.start > when.end) {
    problems.push(`\`start\` (${when.start}) is after \`end\` (${when.end}).`);
  }
  const seen = new Set<string>();
  for (const time of when.times ?? []) {
    if (seen.has(time)) { problems.push(`${time} is in \`times\` twice.`); }
    seen.add(time);
  }
  return problems;
}

/** `whenRuleProblems` as zod issues, for `When`'s `superRefine`. */
function whenProblems(when: WhenFields, ctx: z.RefinementCtx): void {
  for (const message of whenRuleProblems(when)) { ctx.addIssue({ code: 'custom', message }); }
}

/** Minutes since midnight of an `HH:mm` time. */
const minuteOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * The times of one day closer together than `minGap` (ms, the system's config), in words; empty when they fit. Gaps
 * across midnight depend on which days the rules give and are checked when firings are planned.
 */
export function gapProblems(when: Pick<WhenFields, 'times'>, minGap: number): string[] {
  const times = [...new Set(when.times ?? [])].sort();
  const problems: string[] = [];
  for (let i = 1; i < times.length; i++) {
    const before = times[i - 1];
    const after = times[i];
    if (before === undefined || after === undefined) { continue; }
    if ((minuteOf(after) - minuteOf(before)) * 60_000 < minGap) {
      problems.push(`${before} and ${after} are less than ${Math.round(minGap / 60_000)} minutes apart, the shortest gap between two runs.`);
    }
  }
  return problems;
}

/**
 * When: dayspan's ScheduleInput as stored (Oryoli's strict subset), read in the schedule's zone. Checked: `on` or day
 * rules, not both; `maxOccurrences` needs `start`; `start` ≤ `end`; times unique (and at least `minGap` apart, the
 * config, with `gapProblems`).
 */
export const When = z.object({
  /** A one-off: this day only. */
  on: LocalDay.optional(),
  start: LocalDay.optional(),
  end: LocalDay.optional(),
  /** Ends after this many firings; needs `start`. */
  maxOccurrences: z.number().int().min(1).optional(),
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: days(0, 6),
  dayOfMonth: days(1, 31),
  /** 1 = the last day of the month, 2 = the day before it. */
  lastDayOfMonth: days(1, 31),
  /** 0 = days 1–7 ("the 1st Tuesday") … 4 = days 29–31. */
  weekspanOfMonth: days(0, 4),
  /** 0 = the last 7 days ("the last Friday"). */
  lastWeekspanOfMonth: days(0, 4),
  weekOfMonth: days(0, 5),
  weekOfYear: days(1, 53),
  /** 0 = January … 11 = December. */
  month: days(0, 11),
  /** Years, or every N years from the start. */
  year: z.union([z.array(z.number().int()).min(1), Every]).optional(),
  /** Every N days from `start`. */
  daysSinceEpoch: Every.optional(),
  weeksSinceEpoch: Every.optional(),
  monthsSinceEpoch: Every.optional(),
  /** Each is a firing; none = one at 00:00. */
  times: z.array(ClockTime).optional(),
  /** Skipped firings. */
  exclude: z.array(OccurrenceKey).optional(),
  /** Extra firings. */
  include: z.array(OccurrenceKey).optional(),
}).strict().superRefine(whenProblems);
export type When = z.infer<typeof When>;

/** Which settled firings the owner is told about. */
export const Notify = z.enum(['always', 'failed', 'never']);
export type Notify = z.infer<typeof Notify>;
/** A firing due while the last one still runs. */
export const Overlap = z.enum(['skip', 'queue', 'replace']);
export type Overlap = z.infer<typeof Overlap>;
/** Firings that couldn't start on time. */
export const Missed = z.enum(['latest', 'none']);
export type Missed = z.infer<typeof Missed>;

/** A schedule: the payload of a `schedule/schedule` fn. */
export const SchedulePayload = z.object({
  /** The fn it runs (stored data, so a name; the kind's `describe` turns it into the schedule's one dep). */
  fn: QualifiedName,
  when: When,
  zone: Zone,
  /** A gin program over `fire` and `previous` whose result is `fn`'s args (a literal for fixed args). Checked against `fn`'s args type. */
  args: GinExprDef,
  /** The words `args` was written from, when it computes anything. */
  argsAsked: z.string().min(1).optional(),
  notify: Notify.default('always'),
  overlap: Overlap.default('skip'),
  missed: Missed.default('latest'),
  /** The most one firing may spend, in USD; it lowers the firing turn's per-turn budget. */
  maxSpend: Usd.positive().optional(),
  /** Who paused it, when, and optionally until which day. */
  paused: z.object({ at: Timestamp, by: ActorId, until: LocalDay.optional() }).strict().optional(),
}).strict();
export type SchedulePayload = z.infer<typeof SchedulePayload>;

/** What the args program reads as `fire`. */
export const Fire = z.object({
  /** The instant it was planned for. */
  at: Timestamp,
  /** That instant in the zone, with its offset: `2026-11-30T09:00:00-05:00`. */
  local: z.string(),
  day: LocalDay,
  /** Absent for a whole-day firing. */
  time: ClockTime.optional(),
  zone: Zone,
  /** Firings before this one. */
  count: z.number().int().min(0),
  /** Ms after `at` that it started. */
  late: z.number().int().min(0),
  /** Run now. */
  manual: z.boolean(),
});
export type Fire = z.infer<typeof Fire>;

/** What it reads as `previous`. `result` is Json here; the authoring step's scope types it as the target fn's result. */
export const PreviousFiring = z.object({ at: Timestamp, status: z.enum(['ran', 'failed']), result: Json.optional() });
export type PreviousFiring = z.infer<typeof PreviousFiring>;

/** Where a firing is. */
export const FiringStatus = z.enum([
  // started; waiting = for approval or a budget window
  'running', 'waiting',
  // its run settled
  'ran', 'failed', 'cancelled',
  // overlap: the last one was still running
  'skipped',
  // couldn't start in time
  'missed',
  // the hub refused, or approval was needed and the admin says refuse
  'refused',
  // waited for approval past the next firing
  'expired',
]);
export type FiringStatus = z.infer<typeof FiringStatus>;

/** A `schedule/Firing` record (owned by the schedule's owner): one firing that was due. */
export const FiringShape = z.object({
  schedule: QualifiedName,
  /** The schedule's version the firing ran (the hub's fn version). */
  version: z.number().int().min(1),
  /** Planned. */
  at: Timestamp,
  /** The firing within the schedule: its day, or day and time. */
  key: OccurrenceKey,
  manual: z.boolean(),
  status: FiringStatus,
  /** Absent for skipped, missed, refused before a run. */
  run: RunId.optional(),
  args: Json.optional(),
  startedAt: Timestamp.optional(),
  endedAt: Timestamp.optional(),
  cost: Usd.optional(),
  /** The one line the owner was (or would have been) told: the result's summary, or the reason in words. */
  summary: z.string().max(160).optional(),
  /** Whether the owner was notified of this firing. */
  notified: z.boolean(),
}).strict();
export type FiringShape = z.infer<typeof FiringShape>;

/** A schedule as the chat's results and the page show it. */
export const ScheduleView = z.object({
  schedule: QualifiedName,
  fn: QualifiedName,
  /** "Every Monday at 9:00 am, New York time". */
  says: z.string(),
  zone: Zone,
  notify: Notify,
  next: z.array(z.object({ at: Timestamp, local: z.string() })),
  /** The next firing's args. */
  firstArgs: Json.optional(),
  paused: z.object({ until: LocalDay.optional() }).optional(),
  last: FiringShape.pick({ at: true, status: true, run: true, summary: true }).optional(),
});
export type ScheduleView = z.infer<typeof ScheduleView>;
