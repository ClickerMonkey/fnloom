/**
 * A schedule's firings, worked out from its `when` and zone over dayspan's `Schedule` and `Pattern`s, the same in the
 * server's timer and the browser's calendar (docs/plans/schedule-system.md, "The schedule page"): which local days
 * dayspan's rules give, each of `times` on such a day as a firing (none: one at 00:00), skipped and extra firings
 * (`exclude`, `include`), `maxOccurrences` counted from `start`, and each firing's instant in the zone across daylight
 * saving (`zonedTime`). Also the words a schedule says (dayspan's `en-plain` locale) and the presets an edit form
 * offers (dayspan's patterns, worded for the day they start on).
 *
 * dayspan reads days in the host's own time zone, so it is only asked about whole days (built at noon, which every
 * zone has); the times and instants are ours, so the host's daylight saving never moves a firing.
 */
import dayspan, { type ScheduleInput } from 'dayspan';
import { ClockTime, LocalDay, OccurrenceKey, When, type Zone } from './types.ts';
import { localNow, zonedTime } from './zoned.ts';

// dayspan is a CommonJS bundle: its classes are on the default export, in Node and in the browser's build alike
const { Schedule, Day, PatternMap, Locales, enPlain } = dayspan;
type DsDay = InstanceType<typeof Day>;
type DsSchedule = InstanceType<typeof Schedule<unknown>>;
/** What dayspan's patterns read and write. */
type DsInput = ScheduleInput<unknown>;

const DAY = 86_400_000;

/** One firing of a schedule: its key within the schedule (its day, or day and time), its local day and time, and its instant. */
export interface Occurrence {
  readonly key: OccurrenceKey;
  readonly day: LocalDay;
  /** Absent for a whole-day firing (a schedule with no times). */
  readonly time?: ClockTime;
  /** The instant it is planned for (ms). */
  readonly at: number;
}

// ─── local days ───────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

/** The `YYYY-MM-DD` of a UTC-midnight millisecond count. */
function dayOfUtc(ms: number): LocalDay {
  const date = new Date(ms);
  return LocalDay.parse(`${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`);
}

/** A local day as UTC midnight (ms), for day arithmetic that no zone moves. */
function utcOf(day: string): number {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** `day` moved by `n` days. */
export function addDays(day: string, n: number): LocalDay {
  return dayOfUtc(utcOf(day) + n * DAY);
}

/** The days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((utcOf(b) - utcOf(a)) / DAY);
}

/** The day of the week of a local day (0 = Sunday … 6 = Saturday). */
export function weekdayOf(day: string): number {
  return new Date(utcOf(day)).getUTCDay();
}

/** A local day as a dayspan day, at noon (every zone has noon, so the host's daylight saving can't move it to another day). */
export function dsDay(day: string): DsDay {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return Day.build(y, m - 1, d, 12);
}

/** Minutes since midnight of an `HH:mm` time. */
export function minuteOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** The key of a firing: its day, and its time when it has one (`2026-12-24T18:00`). */
export function occurrenceKey(day: string, time?: string): OccurrenceKey {
  return OccurrenceKey.parse(time === undefined ? day : `${day}T${time}`);
}

/** The day and time a firing's key names. */
export function fromOccurrenceKey(key: string): { day: LocalDay; time?: ClockTime } {
  const day = LocalDay.parse(key.slice(0, 10));
  return key.length > 10 ? { day, time: ClockTime.parse(key.slice(11, 16)) } : { day };
}

// ─── dayspan ──────────────────────────────────────────────────────────────────

/** The day rules dayspan reads as they are stored. */
const RULE_KEYS = [
  'dayOfWeek', 'dayOfMonth', 'lastDayOfMonth', 'weekspanOfMonth', 'lastWeekspanOfMonth', 'weekOfMonth', 'weekOfYear', 'month', 'year',
  'daysSinceEpoch', 'weeksSinceEpoch', 'monthsSinceEpoch',
] as const;

/** dayspan's input for a `when`'s days: its rules and range, without times, skips or extras (those are worked out here). */
function dsInput(when: When): DsInput {
  const out = rulesOf(when);
  if (when.on !== undefined) { out.on = dsDay(when.on).startOf('day'); }
  if (when.start !== undefined) { out.start = dsDay(when.start).startOf('day'); }
  // its whole last day (dayspan compares instants)
  if (when.end !== undefined) { out.end = dsDay(when.end).endOf('day'); }
  return out;
}

/** A `when`'s day rules, as dayspan reads them. */
function rulesOf(when: When): DsInput {
  const out: DsInput = {};
  for (const key of RULE_KEYS) {
    const rule = when[key];
    if (rule !== undefined) { out[key] = Array.isArray(rule) ? [...rule] : { every: rule.every, ...(rule.offset === undefined ? {} : { offset: rule.offset }) }; }
  }
  return out;
}

const built = new WeakMap<When, DsSchedule>();
/** dayspan's schedule of a `when`'s days (kept per `when` object). */
export function dayspanOf(when: When): DsSchedule {
  let schedule = built.get(when);
  if (schedule === undefined) {
    schedule = new Schedule<unknown>(dsInput(when));
    built.set(when, schedule);
  }
  return schedule;
}

/** Whether dayspan's rules give this local day (before skips and extras). */
export function ruleDay(when: When, day: string): boolean {
  return dayspanOf(when).matchesDay(dsDay(day));
}

// ─── firings ──────────────────────────────────────────────────────────────────

/** How far ahead (days) the next firings are looked for: a 29 February firing comes at least once in this. */
const LOOK_AHEAD = 8 * 366;

/** The firings on one local day, in time order: the rules' (less the skipped) and the extra ones. */
function firingsOn(when: When, zone: string, day: LocalDay, skip: ReadonlySet<string>, extra: ReadonlySet<string>): Occurrence[] {
  const times = [...new Set(when.times ?? [])].sort();
  const keys = new Set<string>();
  const add = (time: string | undefined): void => {
    const key = time === undefined ? day : `${day}T${time}`;
    if (!skip.has(day) && !skip.has(key)) { keys.add(key); }
  };
  const fires = ruleDay(when, day) || extra.has(day);
  if (fires) {
    if (times.length === 0) { add(undefined); } else { for (const time of times) { add(time); } }
  }
  for (const key of extra) {
    if (key.length > 10 && key.startsWith(day)) { add(key.slice(11, 16)); }
  }
  return [...keys].sort().map((key) => {
    const { time } = fromOccurrenceKey(key);
    return { key: OccurrenceKey.parse(key), day, ...(time === undefined ? {} : { time }), at: zonedTime(day, time === undefined ? 0 : minuteOf(time), zone) };
  });
}

/** The extra days of a `when` (its `include`), the earliest first. */
function firstExtra(when: When): string | undefined {
  return [...(when.include ?? [])].sort()[0]?.slice(0, 10);
}

/**
 * Every firing of a schedule from local day `from` to `to` (inclusive), in order, at most `limit`. `maxOccurrences`
 * counts from `start` (and any extra firing before it), so the walk starts there when it is set.
 */
export function firingsOnDays(when: When, zone: Zone | string, from: string, to: string, limit = 2000): Occurrence[] {
  const skip = new Set<string>(when.exclude ?? []);
  const extra = new Set<string>(when.include ?? []);
  const max = when.maxOccurrences;
  let first = from;
  let last = to;
  if (when.on !== undefined && extra.size === 0) {
    if (when.on < from || when.on > to) { return []; }
    first = when.on;
    last = when.on;
  }
  // only the days the schedule can have anything on, unless extra days fall outside its range
  if (extra.size === 0) {
    if (when.start !== undefined && when.start > first) { first = when.start; }
    if (when.end !== undefined && when.end < last) { last = when.end; }
  }
  let counted = 0;
  if (max !== undefined) {
    const extraFirst = firstExtra(when);
    const start = when.start ?? from;
    const walkFrom = extraFirst !== undefined && extraFirst < start ? extraFirst : start;
    if (walkFrom < first) {
      // count the firings before the range; once the count is reached nothing in the range fires
      for (let day = LocalDay.parse(walkFrom); day < first && counted < max; day = addDays(day, 1)) {
        counted += firingsOn(when, zone, day, skip, extra).length;
      }
      if (counted >= max) { return []; }
    }
  }
  const out: Occurrence[] = [];
  for (let day = LocalDay.parse(first); day <= last && out.length < limit; day = addDays(day, 1)) {
    for (const firing of firingsOn(when, zone, day, skip, extra)) {
      if (max !== undefined && counted >= max) { return out; }
      counted += 1;
      out.push(firing);
      if (out.length >= limit) { return out; }
    }
  }
  return out;
}

/** Every firing planned at or after `from` and before `to` (instants, ms), in order, at most `limit`. */
export function firingsBetween(when: When, zone: Zone | string, from: number, to: number, limit = 2000): Occurrence[] {
  if (to <= from) { return []; }
  const first = localNow(from, zone).day;
  const last = localNow(to, zone).day;
  return firingsOnDays(when, zone, first, last, Number.MAX_SAFE_INTEGER).filter((firing) => firing.at >= from && firing.at < to).slice(0, limit);
}

/** The next `count` firings planned at or after `after` (ms), in order; fewer when the schedule ends. */
export function nextFirings(when: When, zone: Zone | string, after: number, count: number): Occurrence[] {
  const out: Occurrence[] = [];
  const today = localNow(after, zone).day;
  // a month at a time, so a daily schedule reads one month and a yearly one walks on until it finds enough
  for (let from = today; out.length < count && daysBetween(today, from) < LOOK_AHEAD; from = addDays(from, 31)) {
    const to = addDays(from, 30);
    for (const firing of firingsOnDays(when, zone, from, to)) {
      if (firing.at >= after) { out.push(firing); }
      if (out.length >= count) { break; }
    }
    if (ended(when, to)) { break; }
  }
  return out;
}

/** Whether a schedule has nothing after local day `day`: a one-off before it, or an `end` before it, with no extra later. */
function ended(when: When, day: string): boolean {
  const lastExtra = [...(when.include ?? [])].sort().at(-1)?.slice(0, 10);
  if (lastExtra !== undefined && lastExtra > day) { return false; }
  if (when.on !== undefined) { return when.on <= day; }
  return when.end !== undefined && when.end <= day;
}

/** The firing a key names, if the schedule has it (its rules or an extra one, not skipped). */
export function firingOf(when: When, zone: Zone | string, key: string): Occurrence | undefined {
  const { day } = fromOccurrenceKey(key);
  return firingsOnDays(when, zone, day, day).find((firing) => firing.key === key);
}

// ─── words ────────────────────────────────────────────────────────────────────

/** A time of day as people read it: `9:00 am`, `5:30 pm`. */
export function clockWords(time: string): string {
  const minute = minuteOf(time);
  const hour = Math.floor(minute / 60);
  return `${String(hour % 12 === 0 ? 12 : hour % 12)}:${pad(minute % 60)} ${hour < 12 ? 'am' : 'pm'}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A day as people read it: `Tue, Dec 1` (with the year when `year` is set, or it isn't `thisYear`). */
export function dayWords(day: string, thisYear?: string): string {
  const y = day.slice(0, 4);
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const text = `${WEEKDAYS[weekdayOf(day)]?.slice(0, 3) ?? ''}, ${MONTHS[m - 1]?.slice(0, 3) ?? ''} ${String(d)}`;
  return thisYear !== undefined && thisYear !== y ? `${text}, ${y}` : text;
}

/** A list in words: `a`, `a and b`, `a, b and c`. */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) { return items.join(''); }
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** A zone as people say it: `New York time`, `UTC`. */
export function zoneWords(zone: string): string {
  if (zone === 'UTC' || zone === 'Etc/UTC') { return 'UTC'; }
  const place = zone.split('/').at(-1)?.replace(/_/g, ' ') ?? zone;
  return `${place} time`;
}

/** Run `describe` with dayspan's `en-plain` locale current, putting back the one that was. */
function inPlainWords<T>(describe: () => T): T {
  const was = Object.entries(Locales.map).find(([, locale]) => locale === Locales.current)?.[0];
  Locales.set('en-plain');
  try {
    return describe();
  } finally {
    if (was !== undefined) { Locales.set(was); }
  }
}

/** What a schedule says, for its zone as a viewer in `viewerZone` reads it: "Every week on Monday at 9:00 am, New York time". */
export function describeWhen(when: When, zone: string, options: { readonly viewerZone?: string; readonly today?: string } = {}): string {
  const times = [...new Set(when.times ?? [])].sort();
  const at = times.length === 0 ? '' : ` at ${listWords(times.map(clockWords))}`;
  const thisYear = options.today?.slice(0, 4);
  let text: string;
  if (when.on !== undefined) {
    text = `Once, on ${dayWords(when.on, thisYear)}${at}`;
  } else {
    const preset = presetOf(when);
    const first = firingsOnDays(when, zone, when.start ?? options.today ?? localNow(Date.now(), zone).day, addDays(when.start ?? options.today ?? localNow(Date.now(), zone).day, LOOK_AHEAD), 1)[0];
    const words = preset === 'custom' || preset === 'once' || first === undefined ? undefined : PRESET_WORDS[preset](dsDay(first.day));
    text = (words ?? inPlainWords(() => dayspanOf(when).describe('', false, false, false)).replace(/^Happens /, '').replace(/\s+/g, ' ').trim()) + at;
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (when.start !== undefined && options.today !== undefined && when.start > options.today) { text += `, from ${dayWords(when.start, thisYear)}`; }
    if (when.maxOccurrences !== undefined) { text += `, ${String(when.maxOccurrences)} ${when.maxOccurrences === 1 ? 'time' : 'times'}`; } else if (when.end !== undefined) { text += `, until ${dayWords(when.end, thisYear)}`; }
  }
  if (options.viewerZone !== undefined && options.viewerZone !== zone) { text += `, ${zoneWords(zone)}`; }
  return text;
}

// ─── presets ──────────────────────────────────────────────────────────────────

/** The presets an edit form offers, from dayspan's patterns, and `custom` for any other rules. */
export const PRESET_IDS = ['once', 'daily', 'weekday', 'weekly', 'everyOtherWeek', 'monthly', 'monthlyWeek', 'lastWeekdayOfMonth', 'lastDay', 'annually', 'custom'] as const;
export type PresetId = (typeof PRESET_IDS)[number];
/** The presets that repeat (all but `once` and `custom`), each one of dayspan's patterns by the same name. */
type PatternPreset = Exclude<PresetId, 'once' | 'custom'>;
const PATTERN_PRESETS = PRESET_IDS.filter((id): id is PatternPreset => id !== 'once' && id !== 'custom');

/** Each preset's words for the day it is based on: dayspan's `en-plain` pattern words. */
const PRESET_WORDS: Record<PatternPreset, (day: DsDay) => string> = {
  daily: (day) => enPlain.patternDaily(day),
  weekday: (day) => enPlain.patternWeekday(day),
  weekly: (day) => enPlain.patternWeekly(day),
  everyOtherWeek: (day) => (enPlain.patternEveryOtherWeek ?? enPlain.patternWeekly)(day),
  monthly: (day) => enPlain.patternMonthly(day),
  monthlyWeek: (day) => enPlain.patternMonthlyWeek(day),
  lastWeekdayOfMonth: (day) => (enPlain.patternLastWeekdayOfMonth ?? enPlain.patternMonthly)(day),
  lastDay: (day) => enPlain.patternLastDay(day),
  annually: (day) => enPlain.patternAnnually(day),
};

/** Whether a preset fits a day: "the last Friday" only from a day in the month's last seven, "the last day" only from the last day. */
function presetFits(id: PatternPreset, day: DsDay): boolean {
  if (id === 'lastWeekdayOfMonth') { return day.lastWeekspanOfMonth === 0; }
  if (id === 'lastDay') { return day.lastDayOfMonth === 1; }
  return true;
}

/** One preset for a day: its id, words, and the `when` it makes (keeping the times, end and count it was given). */
export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  readonly when: When;
}

/** The parts of a `when` a preset keeps: its times, skips and extras, and how it ends. */
function kept(from: When | undefined, repeats: boolean): Partial<When> {
  const out: Partial<When> = {};
  if (from?.times !== undefined) { out.times = from.times; }
  if (from?.exclude !== undefined) { out.exclude = from.exclude; }
  if (from?.include !== undefined) { out.include = from.include; }
  if (repeats && from?.end !== undefined) { out.end = from.end; }
  if (repeats && from?.maxOccurrences !== undefined) { out.maxOccurrences = from.maxOccurrences; }
  return out;
}

/**
 * The presets for a schedule starting on `day` ("Every week on Tuesday", "Every month on the 4th Tuesday", …), from
 * dayspan's patterns applied to that day; a repeating one starts on `day`. `from` gives the times and ending to keep.
 */
export function presetsFor(day: string, from?: When): Preset[] {
  const ds0 = dsDay(day);
  const out: Preset[] = [{ id: 'once', label: 'Once', when: When.parse({ on: day, ...kept(from, false) }) }];
  for (const id of PATTERN_PRESETS) {
    if (!presetFits(id, ds0)) { continue; }
    const rules: DsInput = {};
    PatternMap[id]?.apply(rules, ds0);
    out.push({ id, label: PRESET_WORDS[id](ds0), when: When.parse({ start: day, ...rules, ...kept(from, true) }) });
  }
  return out;
}

/** Which preset a `when` is (`once`, `weekly`, …), or `custom` for any other rules. */
export function presetOf(when: When): PresetId {
  if (when.on !== undefined) { return 'once'; }
  const rules = rulesOf(when);
  for (const id of PATTERN_PRESETS) {
    if (PatternMap[id]?.isMatch(rules) === true && !hasOffset(when)) { return id; }
  }
  return 'custom';
}

/** An "every N" rule with an offset is never one of the presets. */
function hasOffset(when: When): boolean {
  return [when.daysSinceEpoch, when.weeksSinceEpoch, when.monthsSinceEpoch].some((every) => every?.offset !== undefined && every.offset !== 0);
}

/** The day a preset is based on: a one-off's day, a repeating one's start, else its first firing from `today`. */
export function presetDay(when: When, zone: string, today: string): LocalDay {
  if (when.on !== undefined) { return when.on; }
  if (when.start !== undefined) { return when.start; }
  return firingsOnDays(when, zone, today, addDays(today, LOOK_AHEAD), 1)[0]?.day ?? LocalDay.parse(today);
}
