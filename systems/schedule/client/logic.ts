/**
 * The schedule pages' logic (docs/plans/schedule-system.md, "The schedule page"), as plain functions over the
 * system's shapes, so it is tested alone:
 *
 * - **The calendar's URL**: its view (month, week, agenda), the day it shows, and its filters (a schedule, a status).
 * - **The range** a view shows (whole weeks of a month, one week, two weeks of agenda), stepping it and its title.
 * - **Entries**: coming firings worked out from each schedule's payload by the shared dayspan code (`shared/when.ts`),
 *   and past ones from the `schedule/Firing` records, laid out on the viewer's own days; how each status looks, and
 *   where each entry leads (its run page, or the schedule's page at that firing).
 * - **The edit form**: a draft of a schedule's payload (a preset of dayspan's patterns or custom rules, times, zone,
 *   args, notify, overlap, missed, cost cap), the `when` it makes, and `schedule/change`'s args for what changed.
 */
import { fnLabel, Json, QualifiedName, type DataRecord, type Filter, type RecordQuery, type RunId } from '@harness/core';
import type { PartTone, SelectChoice } from '@harness/sdk';
import { z } from 'zod';
import {
  ClockTime, FiringShape, FiringStatus, LocalDay, schedule, SchedulePayload, When, Zone,
  type Missed, type Notify, type OccurrenceKey, type Overlap,
} from '../shared/index.ts';
import { addDays, daysBetween, describeWhen, firingsBetween, nextFirings, presetDay, presetOf, presetsFor, weekdayOf, type Occurrence, type PresetId } from '../shared/when.ts';
import { localNow, zonedTime } from '../shared/zoned.ts';

/** The schedule fns the pages run, by their contract refs. */
export const SCHEDULE_FNS = {
  change: schedule.fns.change.name,
  pause: schedule.fns.pause.name,
  resume: schedule.fns.resume.name,
  skip: schedule.fns.skip.name,
  remove: schedule.fns.remove.name,
  allowRuns: schedule.fns.allow_runs.name,
} as const satisfies Record<string, QualifiedName>;
/** The schedule kind and the firing records' type. */
export const SCHEDULE_KIND = schedule.kinds.schedule.name;
export const FIRING_TYPE = schedule.types.Firing.name;
/** The pages' segments, from the contract's page refs. */
export const SCHEDULE_PAGES = { calendar: schedule.page.calendar.segment, item: schedule.page.item.segment, all: schedule.page.all.segment } as const;

/** The widest a phone is: under it the calendar opens on its agenda. */
export const PHONE_WIDTH = 640;
/** How many days the agenda shows at a time. */
export const AGENDA_DAYS = 14;
/** How many firings a history page reads. */
export const HISTORY_PAGE = 25;
/** How many firings a calendar range reads at most (the most a records page gives). */
export const RANGE_FIRINGS = 200;

// ─── a schedule as the pages hold it ──────────────────────────────────────────

/** One schedule fn, its payload parsed. */
export interface ScheduleItem {
  readonly fn: QualifiedName;
  readonly title: string;
  readonly version: number;
  readonly owner?: string | undefined;
  readonly payload: SchedulePayload;
  readonly available: boolean;
}

/** A stored fn as `hub/fns_get` gives it, as far as the pages read it. */
export const StoredFnView = z.object({
  fn: QualifiedName,
  kind: z.string(),
  description: z.string().optional(),
  payload: z.unknown().optional(),
  version: z.number().int().min(1),
  owner: z.string().optional(),
  available: z.boolean(),
  blocked: z.object({ reason: z.string() }).loose().optional(),
  args: z.unknown().optional(),
}).loose();
export type StoredFnView = z.infer<typeof StoredFnView>;

/** A schedule from `hub/fns_get`'s answer; undefined when it is no schedule or its payload doesn't read. */
export function scheduleOf(stored: unknown): ScheduleItem | undefined {
  const fn = StoredFnView.safeParse(stored);
  if (!fn.success || fn.data.kind !== SCHEDULE_KIND) { return undefined; }
  const payload = SchedulePayload.safeParse(fn.data.payload);
  if (!payload.success) { return undefined; }
  const name = fn.data.fn;
  return { fn: name, title: fnLabel(name), version: fn.data.version, owner: fn.data.owner, payload: payload.data, available: fn.data.available };
}

/** The local part of a schedule's name: its page's path (`schedule/weekly_summary` → `weekly_summary`). */
export function localOf(fn: string): string {
  return fn.slice(fn.indexOf('/') + 1);
}

/** A schedule's name from its page's path. */
export function scheduleNameOf(path: readonly string[]): QualifiedName | undefined {
  const local = path[0];
  return local === undefined || local === '' ? undefined : `${schedule.name}/${local}`;
}

/** Whether a schedule is paused on a local day: paused with no "until", or until a later day. */
export function pausedOn(payload: SchedulePayload, day: string): boolean {
  const paused = payload.paused;
  return paused !== undefined && (paused.until === undefined || day < paused.until);
}

/** The viewer's zone: theirs when the hub knows it, else the browser's. */
export function viewerZone(timeZone: string | undefined): string {
  return timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ─── the calendar's URL ───────────────────────────────────────────────────────

export const CALENDAR_VIEWS = ['month', 'week', 'agenda'] as const;
export const CalendarView = z.enum(CALENDAR_VIEWS);
export type CalendarView = z.infer<typeof CalendarView>;

/** A status a calendar filter picks: a firing's, or `coming` for the planned ones. */
export const EntryStatus = z.union([FiringStatus, z.literal('coming')]);
export type EntryStatus = z.infer<typeof EntryStatus>;

/** The calendar's URL: `?view=week&day=2026-11-23&schedule=schedule/weekly_summary&status=failed&entry=…`. */
export const CalendarUrl = z.object({
  view: CalendarView,
  day: LocalDay,
  schedule: z.string().regex(/^[a-z][a-z0-9_-]*\/.+$/),
  status: EntryStatus,
  /** The entry whose panel is open. */
  entry: z.string().min(1),
}).partial();
export type CalendarUrl = z.infer<typeof CalendarUrl>;

/** The calendar's URL from the page's query: a key that doesn't fit is left out. */
export function calendarUrl(query: Readonly<Record<string, string>>): CalendarUrl {
  const url: Record<string, string> = {};
  for (const key of CalendarUrl.keyof().options) {
    const value = query[key];
    if (value !== undefined && CalendarUrl.shape[key].safeParse(value).success) { url[key] = value; }
  }
  return CalendarUrl.parse(url);
}

/** The view to show: the URL's, else agenda on a phone and month elsewhere. */
export function viewOf(url: CalendarUrl, width: number): CalendarView {
  return url.view ?? (width < PHONE_WIDTH ? 'agenda' : 'month');
}

// ─── ranges ───────────────────────────────────────────────────────────────────

/** The first day of `day`'s month. */
export function monthStart(day: string): LocalDay {
  return LocalDay.parse(`${day.slice(0, 7)}-01`);
}

/** The Sunday a week containing `day` starts on. */
export function weekStart(day: string): LocalDay {
  return addDays(day, -weekdayOf(day));
}

/** The days a view shows around `day`: a month's whole weeks (Sunday first), one week, or the agenda's days from `day`. */
export function rangeDays(view: CalendarView, day: string): LocalDay[] {
  if (view === 'agenda') { return Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(day, i)); }
  if (view === 'week') { const first = weekStart(day); return Array.from({ length: 7 }, (_, i) => addDays(first, i)); }
  const first = monthStart(day);
  const next = monthStart(addDays(first, 31));
  const from = weekStart(first);
  const cells = Math.ceil((weekdayOf(first) + daysBetween(first, next)) / 7) * 7;
  return Array.from({ length: cells }, (_, i) => addDays(from, i));
}

/** The day a view moves to, a step back (-1) or on (1): a month, a week, or the agenda's days. */
export function stepDay(view: CalendarView, day: string, step: -1 | 1): LocalDay {
  if (view === 'agenda') { return addDays(day, step * AGENDA_DAYS); }
  if (view === 'week') { return addDays(day, step * 7); }
  const first = monthStart(day);
  return step === 1 ? monthStart(addDays(first, 31)) : monthStart(addDays(first, -1));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = MONTHS.map((month) => month.slice(0, 3));
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const SHORT_WEEKDAYS = WEEKDAYS.map((day) => day.slice(0, 3));

const monthOf = (day: string): number => Number(day.slice(5, 7)) - 1;
const dateOf = (day: string): number => Number(day.slice(8, 10));

/** A range's title: "November 2026", "Nov 22 – 28, 2026", "Nov 29 – Dec 5, 2026". */
export function rangeTitle(view: CalendarView, day: string): string {
  if (view === 'month') { return `${MONTHS[monthOf(day)] ?? ''} ${day.slice(0, 4)}`; }
  const days = rangeDays(view, day);
  const first = days[0] ?? day;
  const last = days.at(-1) ?? day;
  const end = monthOf(first) === monthOf(last) ? String(dateOf(last)) : `${SHORT_MONTHS[monthOf(last)] ?? ''} ${String(dateOf(last))}`;
  return `${SHORT_MONTHS[monthOf(first)] ?? ''} ${String(dateOf(first))} – ${end}, ${last.slice(0, 4)}`;
}

/** A day's heading in the agenda: "Today", "Tomorrow", "Yesterday", else "Mon, Nov 30". */
export function dayHeading(day: string, today: string): string {
  const gap = daysBetween(today, day);
  if (gap === 0) { return 'Today'; }
  if (gap === 1) { return 'Tomorrow'; }
  if (gap === -1) { return 'Yesterday'; }
  const text = `${SHORT_WEEKDAYS[weekdayOf(day)] ?? ''}, ${SHORT_MONTHS[monthOf(day)] ?? ''} ${String(dateOf(day))}`;
  return day.slice(0, 4) === today.slice(0, 4) ? text : `${text}, ${day.slice(0, 4)}`;
}

/** A day as the month grid numbers it, with the month's short name on its first. */
export function cellNumber(day: string): string {
  return dateOf(day) === 1 ? `${SHORT_MONTHS[monthOf(day)] ?? ''} 1` : String(dateOf(day));
}

/** An instant's time on the viewer's clock: "9:00 am". */
export function timeWords(at: number, zone: string): string {
  const minute = localNow(at, zone).minute;
  const hour = Math.floor(minute / 60);
  return `${String(hour % 12 === 0 ? 12 : hour % 12)}:${String(minute % 60).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}

/** An instant as the viewer reads it: "Mon, Nov 30, 9:00 am" (or "Today, 9:00 am"). */
export function instantWords(at: number, zone: string, today: string): string {
  return `${dayHeading(localNow(at, zone).day, today)}, ${timeWords(at, zone)}`;
}

// ─── entries ──────────────────────────────────────────────────────────────────

/** A firing record, with its record id. */
export interface FiringItem {
  readonly id: string;
  readonly value: FiringShape;
}

/** The firings among some records (one that doesn't read is left out). */
export function firingsOf(records: readonly DataRecord[]): FiringItem[] {
  return records.flatMap((record) => {
    const value = FiringShape.safeParse(record.value);
    return value.success ? [{ id: record.id, value: value.data }] : [];
  });
}

/** One entry on the calendar: a coming firing, or one that was due (its record). */
export interface CalendarEntry {
  /** `<schedule>@<key>`: the same for a coming firing and the record it becomes. */
  readonly id: string;
  readonly schedule: QualifiedName;
  readonly title: string;
  /** The fn it runs. */
  readonly fn: QualifiedName;
  readonly key: OccurrenceKey;
  readonly at: number;
  /** The viewer's local day it falls on. */
  readonly day: LocalDay;
  readonly status: EntryStatus;
  /** A coming firing of a paused schedule (drawn faded; it won't run unless resumed). */
  readonly paused: boolean;
  readonly run?: RunId | undefined;
  readonly summary?: string | undefined;
  readonly manual: boolean;
  readonly args?: Json | undefined;
  /** Whole-day firing (a schedule with no times). */
  readonly allDay: boolean;
}

/** An entry's id. */
export function entryId(schedule: string, key: string): string {
  return `${schedule}@${key}`;
}

/** The instants a range of the viewer's days covers: from its first day's start to the day after its last. */
export function rangeInstants(days: readonly string[], zone: string): { from: number; to: number } {
  const first = days[0] ?? localNow(Date.now(), zone).day;
  const last = days.at(-1) ?? first;
  return { from: zonedTime(first, 0, zone), to: zonedTime(addDays(last, 1), 0, zone) };
}

/** What the calendar draws for a range: every schedule's coming firings from now, and the firing records in it. */
export function entriesFor(input: {
  readonly schedules: readonly ScheduleItem[];
  readonly firings: readonly FiringItem[];
  readonly from: number;
  readonly to: number;
  readonly now: number;
  readonly zone: string;
}): CalendarEntry[] {
  const byName = new Map(input.schedules.map((item) => [item.fn, item]));
  const out = new Map<string, CalendarEntry>();
  for (const firing of input.firings) {
    const value = firing.value;
    if (value.at < input.from || value.at >= input.to) { continue; }
    const item = byName.get(value.schedule);
    const id = entryId(value.schedule, value.key);
    out.set(id, {
      id, schedule: value.schedule, title: item?.title ?? fnLabel(value.schedule), fn: item?.payload.fn ?? value.schedule, key: value.key, at: value.at,
      day: LocalDay.parse(localNow(value.at, input.zone).day), status: value.status, paused: false, run: value.run, summary: value.summary, manual: value.manual,
      args: value.args, allDay: value.key.length === 10,
    });
  }
  const from = Math.max(input.from, input.now);
  for (const item of input.schedules) {
    for (const firing of firingsBetween(item.payload.when, item.payload.zone, from, input.to)) {
      const id = entryId(item.fn, firing.key);
      if (out.has(id)) { continue; }
      out.set(id, comingEntry(item, firing, input.zone));
    }
  }
  return [...out.values()].sort((a, b) => a.at - b.at || a.title.localeCompare(b.title));
}

/** A coming firing as an entry. */
function comingEntry(item: ScheduleItem, firing: Occurrence, zone: string): CalendarEntry {
  return {
    id: entryId(item.fn, firing.key), schedule: item.fn, title: item.title, fn: item.payload.fn, key: firing.key, at: firing.at,
    day: LocalDay.parse(localNow(firing.at, zone).day), status: 'coming', paused: pausedOn(item.payload, firing.day), manual: false, allDay: firing.time === undefined,
  };
}

/** The entries the URL's filters let through. */
export function filterEntries(entries: readonly CalendarEntry[], url: Pick<CalendarUrl, 'schedule' | 'status'>): CalendarEntry[] {
  return entries.filter((entry) => (url.schedule === undefined || entry.schedule === url.schedule) && (url.status === undefined || entry.status === url.status));
}

/** Entries by the viewer's day, each day's in time order. */
export function entriesByDay(entries: readonly CalendarEntry[]): Map<string, CalendarEntry[]> {
  const out = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const list = out.get(entry.day);
    if (list === undefined) { out.set(entry.day, [entry]); } else { list.push(entry); }
  }
  return out;
}

/** The hub query of the person's firing records in a range (newest last), narrowed by schedule and status. */
export function rangeQuery(from: number, to: number, url: Pick<CalendarUrl, 'schedule' | 'status'>): RecordQuery {
  const filters: Filter[] = [{ field: 'at', op: 'gte', value: from }, { field: 'at', op: 'lt', value: to }];
  if (url.schedule !== undefined) { filters.push({ field: 'schedule', op: 'is', value: url.schedule }); }
  if (url.status !== undefined && url.status !== 'coming') { filters.push({ field: 'status', op: 'is', value: url.status }); }
  return { type: FIRING_TYPE, query: { limit: RANGE_FIRINGS, sort: [{ field: 'at', dir: 'asc' }], filters } };
}

/** The hub query of one schedule's firings, newest first, a page at a time; with `key`, only that firing. */
export function historyQuery(scheduleName: QualifiedName, options: { readonly cursor?: string | undefined; readonly status?: FiringStatus | undefined; readonly key?: string | undefined } = {}): RecordQuery {
  const filters: Filter[] = [{ field: 'schedule', op: 'is', value: scheduleName }];
  if (options.status !== undefined) { filters.push({ field: 'status', op: 'is', value: options.status }); }
  if (options.key !== undefined) { filters.push({ field: 'key', op: 'is', value: options.key }); }
  return { type: FIRING_TYPE, query: { limit: HISTORY_PAGE, sort: [{ field: 'at', dir: 'desc' }], filters, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) } };
}

// ─── how a status looks ───────────────────────────────────────────────────────

/** How an entry's status looks: its colour (tone and the CSS colour its chip and dot are drawn in), its word, whether it pulses. */
export interface StatusLook {
  readonly tone: PartTone;
  readonly colour: string;
  readonly word: string;
  readonly live: boolean;
}

/** How each status looks. */
export const STATUS_LOOK = {
  coming: { tone: 'accent', colour: 'var(--accent)', word: 'Coming', live: false },
  running: { tone: 'accent', colour: 'var(--accent)', word: 'Running', live: true },
  waiting: { tone: 'warn', colour: 'var(--warn)', word: 'Waiting', live: true },
  ran: { tone: 'ok', colour: 'var(--ok)', word: 'Ran', live: false },
  failed: { tone: 'danger', colour: 'var(--danger)', word: 'Failed', live: false },
  cancelled: { tone: 'neutral', colour: 'var(--text-faint)', word: 'Cancelled', live: false },
  skipped: { tone: 'neutral', colour: 'var(--text-faint)', word: 'Skipped', live: false },
  missed: { tone: 'warn', colour: 'var(--warn)', word: 'Missed', live: false },
  refused: { tone: 'danger', colour: 'var(--danger)', word: 'Refused', live: false },
  expired: { tone: 'warn', colour: 'var(--warn)', word: 'Gave up waiting', live: false },
} as const satisfies Record<EntryStatus, StatusLook>;

/** How an entry looks: a paused schedule's coming firing says so. */
export function entryLook(entry: Pick<CalendarEntry, 'status' | 'paused'>): StatusLook {
  return entry.status === 'coming' && entry.paused ? { tone: 'neutral', colour: 'var(--text-faint)', word: 'Paused', live: false } : STATUS_LOOK[entry.status];
}

/** The status filter's choices ('' is any). */
export const STATUS_CHOICES: readonly SelectChoice[] = [
  { value: '', label: 'Any status' },
  ...(['coming', ...FiringStatus.options] as const).map((status) => ({ value: status, label: STATUS_LOOK[status].word })),
];

/** Where an entry leads: its run's page when it became a run, else the schedule's page at that firing. */
export type EntryTarget = { readonly run: RunId } | { readonly page: string; readonly path: readonly string[]; readonly query: Readonly<Record<string, string>> };

/** Where an entry leads. */
export function entryTarget(entry: Pick<CalendarEntry, 'run' | 'schedule' | 'key'>): EntryTarget {
  return entry.run !== undefined ? { run: entry.run } : { page: SCHEDULE_PAGES.item, path: [localOf(entry.schedule)], query: { firing: entry.key } };
}

// ─── one schedule ─────────────────────────────────────────────────────────────

/** The tabs of a schedule's page. */
export const ITEM_TABS = ['overview', 'history'] as const;
export const ItemTab = z.enum(ITEM_TABS);
export type ItemTab = z.infer<typeof ItemTab>;

/** A schedule page's URL: its tab, a history status filter, the firing opened (`firing=<key>`), and the edit form. */
export const ItemUrl = z.object({ tab: ItemTab, status: FiringStatus, firing: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/), edit: z.literal('1') }).partial();
export type ItemUrl = z.infer<typeof ItemUrl>;

/** A schedule page's URL from its query; a key that doesn't fit is left out. */
export function itemUrl(query: Readonly<Record<string, string>>): ItemUrl {
  const url: Record<string, string> = {};
  for (const key of ItemUrl.keyof().options) {
    const value = query[key];
    if (value !== undefined && ItemUrl.shape[key].safeParse(value).success) { url[key] = value; }
  }
  return ItemUrl.parse(url);
}

/** What a schedule says, for its zone as the viewer reads it. */
export function saysOf(payload: SchedulePayload, zone: string, today: string): string {
  return describeWhen(payload.when, payload.zone, { viewerZone: zone, today });
}

/** When the owner is told, in words. */
export const NOTIFY_WORDS = { always: 'Notifies you after every run', failed: 'Notifies you only when a run fails', never: 'Never notifies you' } as const satisfies Record<Notify, string>;

/** A schedule's next firings from `now`. */
export function comingFirings(item: ScheduleItem, now: number, count = 3): Occurrence[] {
  return nextFirings(item.payload.when, item.payload.zone, now, count);
}

/**
 * The fixed args a schedule's program is, when it is a literal (`{ kind: 'new', value }` all the way down); undefined
 * when it works anything out (the words it was written from, `argsAsked`, say what).
 */
export function fixedArgsOf(program: unknown): Json | undefined {
  const read = (expr: unknown): { ok: true; value: Json } | { ok: false } => {
    const def = NewExprShape.safeParse(expr);
    return def.success ? readValue(def.data.value) : { ok: false };
  };
  const readValue = (value: unknown): { ok: true; value: Json } | { ok: false } => {
    if (value === undefined || value === null) { return { ok: true, value: null }; }
    if (Array.isArray(value)) {
      const items: Json[] = [];
      for (const item of value) { const got = isExpr(item) ? read(item) : readValue(item); if (!got.ok) { return got; } items.push(got.value); }
      return { ok: true, value: items };
    }
    if (typeof value === 'object') {
      if (isExpr(value)) { return read(value); }
      const out: Record<string, Json> = {};
      for (const [key, item] of Object.entries(value)) { const got = isExpr(item) ? read(item) : readValue(item); if (!got.ok) { return got; } out[key] = got.value; }
      return { ok: true, value: out };
    }
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? { ok: true, value } : { ok: false };
  };
  const got = read(program);
  return got.ok ? got.value : undefined;
}

/** A gin literal: `{ kind: 'new', type, value }`. */
const NewExprShape = z.object({ kind: z.literal('new'), value: z.unknown().optional() }).loose();
/** Any gin expression's own fields. */
const ExprShape = z.object({ kind: z.string() }).loose();

/** Whether a value is a gin expression (`{ kind, … }` with a type, path or body). */
function isExpr(value: unknown): boolean {
  const expr = ExprShape.safeParse(value);
  return expr.success && ('type' in expr.data || 'path' in expr.data || 'body' in expr.data);
}

// ─── the edit form ────────────────────────────────────────────────────────────

/** How the form edits a schedule's args: fixed values, or words that work them out for each run. */
export type ArgsMode = 'fixed' | 'compute';

/** A schedule's edit form, as text and choices the controls bind. */
export interface ScheduleDraft {
  preset: PresetId;
  /** The day a preset is based on (a one-off's day, a repeating one's start). */
  day: string;
  /** Times of day, `HH:mm`, in order. */
  times: string[];
  zone: string;
  /** Custom rules: days of the week (0 = Sunday). */
  weekdays: number[];
  /** Custom rules: days of the month, as typed ("1, 15"). */
  monthDays: string;
  /** Custom rules: every this many weeks ('' or '1' is every week). */
  everyWeeks: string;
  /** How a repeating one ends: never, on a day, or after a count. */
  ends: 'never' | 'on' | 'after';
  endDay: string;
  count: string;
  argsMode: ArgsMode;
  args: Json | undefined;
  compute: string;
  notify: Notify;
  overlap: Overlap;
  missed: Missed;
  /** The cost cap in dollars, as typed ('' for none). */
  maxSpend: string;
  /** Rules the form can't edit, kept as they are while the preset stays custom. */
  kept?: When | undefined;
  /** The when-fields as the draft was made (`whenKey`): unchanged, the schedule's `when` is kept exactly as it is. */
  origin?: string | undefined;
}

/** The parts of a draft its `when` is made from, as one string, to tell whether any changed. */
export function whenKey(draft: ScheduleDraft): string {
  const { preset, day, times, weekdays, monthDays, everyWeeks, ends, endDay, count, kept } = draft;
  return JSON.stringify({ preset, day, times: [...times].sort(), weekdays: [...weekdays].sort(), monthDays, everyWeeks, ends, endDay, count, kept });
}

const RULE_KEYS = ['dayOfWeek', 'dayOfMonth', 'lastDayOfMonth', 'weekspanOfMonth', 'lastWeekspanOfMonth', 'weekOfMonth', 'weekOfYear', 'month', 'year', 'daysSinceEpoch', 'weeksSinceEpoch', 'monthsSinceEpoch'] as const;

/** Whether custom rules are all ones the form edits: days of the week, of the month, and every N weeks. */
function editableCustom(when: When): boolean {
  return RULE_KEYS.every((key) => when[key] === undefined || key === 'dayOfWeek' || key === 'dayOfMonth' || (key === 'weeksSinceEpoch' && when.weeksSinceEpoch?.offset === undefined));
}

/** The form's draft of a schedule's payload. */
export function draftOf(payload: SchedulePayload, today: string): ScheduleDraft {
  const when = payload.when;
  const preset = presetOf(when);
  const fixed = fixedArgsOf(payload.args);
  const draft: ScheduleDraft = {
    preset,
    day: presetDay(when, payload.zone, today),
    times: [...(when.times ?? [])].sort(),
    zone: payload.zone,
    weekdays: [...(when.dayOfWeek ?? [])],
    monthDays: (when.dayOfMonth ?? []).join(', '),
    everyWeeks: when.weeksSinceEpoch === undefined ? '' : String(when.weeksSinceEpoch.every),
    ends: when.maxOccurrences !== undefined ? 'after' : when.end !== undefined ? 'on' : 'never',
    endDay: when.end ?? '',
    count: when.maxOccurrences === undefined ? '' : String(when.maxOccurrences),
    argsMode: payload.argsAsked !== undefined || fixed === undefined ? 'compute' : 'fixed',
    args: fixed,
    compute: payload.argsAsked ?? '',
    notify: payload.notify,
    overlap: payload.overlap,
    missed: payload.missed,
    maxSpend: payload.maxSpend === undefined ? '' : String(payload.maxSpend),
    kept: preset === 'custom' && !editableCustom(when) ? when : undefined,
  };
  return { ...draft, origin: whenKey(draft) };
}

/** A checked draft: the `when` it makes, or the problems by field. */
export type DraftCheck = { readonly ok: true; readonly when: When } | { readonly ok: false; readonly problems: Readonly<Record<string, string>> };

/** The `when` a draft makes, checked. */
export function whenOfDraft(draft: ScheduleDraft, base?: When): DraftCheck {
  const problems: Record<string, string> = {};
  const day = LocalDay.safeParse(draft.day);
  if (!day.success) { problems['day'] = 'Pick a day.'; }
  const times = [...new Set(draft.times.map((time) => time.trim()).filter((time) => time !== ''))].sort();
  const badTime = times.find((time) => !ClockTime.safeParse(time).success);
  if (badTime !== undefined) { problems['times'] = `${badTime} isn't a time of day (HH:mm).`; }
  if (!Zone.safeParse(draft.zone).success) { problems['zone'] = 'Pick a time zone, such as America/New_York.'; }
  if (!day.success || Object.keys(problems).length > 0) { return { ok: false, problems }; }
  // skips and extras stay as they were
  const carry: Partial<When> = {};
  if (base?.exclude !== undefined) { carry.exclude = base.exclude; }
  if (base?.include !== undefined) { carry.include = base.include; }
  const timed: Partial<When> = times.length === 0 ? {} : { times: times.map((time) => ClockTime.parse(time)) };
  let rules: Partial<When>;
  if (draft.preset === 'custom') {
    if (draft.kept !== undefined) {
      rules = Object.fromEntries(RULE_KEYS.flatMap((key) => (draft.kept?.[key] === undefined ? [] : [[key, draft.kept[key]]])));
    } else {
      const monthDays = draft.monthDays.split(/[\s,]+/).filter((part) => part !== '').map(Number);
      if (monthDays.some((n) => !Number.isInteger(n) || n < 1 || n > 31)) { problems['monthDays'] = 'Days of the month are numbers from 1 to 31, such as 1, 15.'; }
      const every = draft.everyWeeks.trim() === '' ? 1 : Number(draft.everyWeeks);
      if (!Number.isInteger(every) || every < 1) { problems['everyWeeks'] = 'Every how many weeks: a whole number, 1 or more.'; }
      if (draft.weekdays.length === 0 && monthDays.length === 0) { problems['weekdays'] = 'Pick days of the week or of the month.'; }
      rules = {
        ...(draft.weekdays.length === 0 ? {} : { dayOfWeek: [...new Set(draft.weekdays)].sort() }),
        ...(monthDays.length === 0 ? {} : { dayOfMonth: [...new Set(monthDays)].sort((a, b) => a - b) }),
        ...(every > 1 ? { weeksSinceEpoch: { every } } : {}),
      };
    }
    rules = { start: day.data, ...rules };
  } else {
    const preset = presetsFor(day.data).find((entry) => entry.id === draft.preset);
    if (preset === undefined) { return { ok: false, problems: { preset: `That repeat doesn't fit ${day.data}: pick another day or repeat.` } }; }
    const { times: _times, exclude: _exclude, include: _include, ...presetRules } = preset.when;
    rules = presetRules;
  }
  if (draft.preset !== 'once') {
    if (draft.ends === 'on') {
      const end = LocalDay.safeParse(draft.endDay);
      if (!end.success) { problems['endDay'] = 'Pick the last day.'; } else if (end.data < day.data) { problems['endDay'] = 'The last day is before the first.'; } else { rules = { ...rules, end: end.data }; }
    } else if (draft.ends === 'after') {
      const count = Number(draft.count);
      if (!Number.isInteger(count) || count < 1) { problems['count'] = 'How many runs: a whole number, 1 or more.'; } else { rules = { ...rules, maxOccurrences: count }; }
    }
  }
  if (Object.keys(problems).length > 0) { return { ok: false, problems }; }
  const parsed = When.safeParse({ ...rules, ...timed, ...carry });
  if (!parsed.success) { return { ok: false, problems: { when: parsed.error.issues.map((issue) => issue.message).join(' ') } }; }
  return { ok: true, when: parsed.data };
}

/** `schedule/change`'s args for what a draft changed, or the problems by field. Nothing changed: `args` is undefined. */
export function changeArgsOf(item: ScheduleItem, draft: ScheduleDraft): { readonly ok: true; readonly args: Record<string, Json> | undefined } | { readonly ok: false; readonly problems: Readonly<Record<string, string>> } {
  const payload = item.payload;
  const args: Record<string, Json> = {};
  if (draft.origin === undefined || whenKey(draft) !== draft.origin) {
    const when = whenOfDraft(draft, payload.when);
    if (!when.ok) { return when; }
    if (JSON.stringify(when.when) !== JSON.stringify(payload.when)) { args['when'] = Json.parse(when.when); }
  }
  if (draft.zone !== payload.zone) { args['zone'] = draft.zone; }
  if (draft.notify !== payload.notify) { args['notify'] = draft.notify; }
  if (draft.overlap !== payload.overlap) { args['overlap'] = draft.overlap; }
  if (draft.missed !== payload.missed) { args['missed'] = draft.missed; }
  const spend = draft.maxSpend.trim();
  if (spend !== '') {
    const usd = Number(spend.replace(/^\$/, ''));
    if (!Number.isFinite(usd) || usd <= 0) { return { ok: false, problems: { maxSpend: 'The most a run may spend: an amount in dollars, more than 0.' } }; }
    if (usd !== payload.maxSpend) { args['maxSpend'] = usd; }
  }
  if (draft.argsMode === 'compute') {
    const words = draft.compute.trim();
    if (words === '') { return { ok: false, problems: { compute: 'Say how the args are worked out for each run.' } }; }
    if (words !== (payload.argsAsked ?? '')) { args['compute'] = words; }
  } else {
    const before = payload.argsAsked === undefined ? fixedArgsOf(payload.args) : undefined;
    if (JSON.stringify(draft.args ?? {}) !== JSON.stringify(before ?? {}) || payload.argsAsked !== undefined) { args['args'] = draft.args ?? {}; }
  }
  return { ok: true, args: Object.keys(args).length === 0 ? undefined : { schedule: item.fn, ...args } };
}

/** The preset choices for a draft's day (the day's own words), with Custom last. */
export function presetChoices(day: string): SelectChoice[] {
  const parsed = LocalDay.safeParse(day);
  const presets = parsed.success ? presetsFor(parsed.data) : [];
  return [...presets.map((preset) => ({ value: preset.id, label: preset.id === 'once' ? `Once, on ${dayHeading(preset.when.on ?? day, '')}` : preset.label })), { value: 'custom', label: 'Custom…' }];
}

/** The notify choices. */
export const NOTIFY_CHOICES: readonly SelectChoice[] = [
  { value: 'always', label: 'After every run' },
  { value: 'failed', label: 'Only when a run fails' },
  { value: 'never', label: 'Never' },
];
/** The overlap choices. */
export const OVERLAP_CHOICES: readonly SelectChoice[] = [
  { value: 'skip', label: 'Skip it (the default)' },
  { value: 'queue', label: 'Run it when the last one ends' },
  { value: 'replace', label: 'Stop the last one and run it' },
];
/** The missed-firing choices. */
export const MISSED_CHOICES: readonly SelectChoice[] = [
  { value: 'latest', label: 'Run the latest one late, if not too late' },
  { value: 'none', label: 'Don’t run them' },
];

/** The time zones the browser knows, the draft's own first when it isn't among them. */
export function zoneChoices(current: string): SelectChoice[] {
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const zones = supported.includes(current) || current === '' ? supported : [current, ...supported];
  return (zones.length === 0 ? [current] : zones).map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }));
}

/** The person's local day now. */
export function todayIn(zone: string, now = Date.now()): LocalDay {
  return LocalDay.parse(localNow(now, zone).day);
}
