/**
 * Relative dates (`RELATIVE_DATES` in `@harness/core`): the one implementation that turns a stored expression such as
 * `today-7d` or `startOf(month,today-1mo)` into a plain value. The web's date control resolves one when the person
 * applies it; the widgets system resolves a saved widget's defaults, pins and presets each time it runs, so a saved
 * "last 7 days" stays current.
 *
 * The text is product's date grammar, read by a small parser rather than matched as whole strings, so the full grammar
 * can follow without migrating saved widgets:
 *
 * ```text
 * expr   := 'now' shift? | day
 * day    := 'today' shift? | ('startOf' | 'endOf') '(' unit (',' day)? ')'
 * shift  := ('+' | '-') digits ('h' | 'd' | 'w' | 'mo' | 'y')
 * unit   := 'day' | 'week' | 'month' | 'quarter' | 'year'
 * ```
 *
 * A day is a calendar day in the person's time zone, written `YYYY-MM-DD` (a `date` argument); `now` and its shifts are
 * instants, written as ISO text in UTC (a `timestamp` argument). Weeks start on Monday (ISO 8601).
 */
import { RELATIVE_DATE_EXPRS, RELATIVE_DATES, type ArgValue, type Json, type RelativeDate } from '@harness/core';

/** A calendar day: year, month (1 to 12) and day of the month. */
interface CivilDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const;
type Unit = (typeof UNITS)[number];

/** A shift of a day or an instant: `-7d`, `+1mo`, `-24h`. */
interface Shift {
  readonly sign: 1 | -1;
  readonly count: number;
  readonly unit: 'h' | 'd' | 'w' | 'mo' | 'y';
}

/** A parsed day expression. */
type DayExpr =
  | { readonly kind: 'today'; readonly shift?: Shift }
  | { readonly kind: 'edge'; readonly edge: 'start' | 'end'; readonly unit: Unit; readonly base: DayExpr };

/** A parsed expression: an instant or a day. */
type Expr = { readonly kind: 'now'; readonly shift?: Shift } | DayExpr;

const SHIFT = /^([+-])(\d+)(mo|h|d|w|y)$/;
const EDGE = /^(startOf|endOf)\(([a-z]+)(?:,(.+))?\)$/;

/** Read a shift (`-7d`), or throw naming the text. */
function parseShift(text: string, whole: string): Shift {
  const match = SHIFT.exec(text);
  const unit = match?.[3];
  if (match === null || unit === undefined || (unit !== 'h' && unit !== 'd' && unit !== 'w' && unit !== 'mo' && unit !== 'y')) {
    throw new Error(`Relative date ${whole}: ${text} is not a shift such as -7d or +1mo.`);
  }
  return { sign: match[1] === '-' ? -1 : 1, count: Number(match[2]), unit };
}

/** Read a day expression, or throw naming what is wrong. */
function parseDay(text: string, whole: string): DayExpr {
  if (text.startsWith('today')) {
    const rest = text.slice('today'.length);
    if (rest === '') { return { kind: 'today' }; }
    const shift = parseShift(rest, whole);
    if (shift.unit === 'h') { throw new Error(`Relative date ${whole}: a day moves by days, weeks, months or years, not hours.`); }
    return { kind: 'today', shift };
  }
  const edge = EDGE.exec(text);
  const unit = UNITS.find((name) => name === edge?.[2]);
  if (edge === null || unit === undefined) { throw new Error(`Relative date ${whole}: ${text} is not today, startOf(unit) or endOf(unit).`); }
  return { kind: 'edge', edge: edge[1] === 'startOf' ? 'start' : 'end', unit, base: edge[3] === undefined ? { kind: 'today' } : parseDay(edge[3], whole) };
}

/** Read an expression. */
function parse(text: string): Expr {
  if (text.startsWith('now')) {
    const rest = text.slice('now'.length);
    return rest === '' ? { kind: 'now' } : { kind: 'now', shift: parseShift(rest, text) };
  }
  return parseDay(text, text);
}

/** The calendar day an instant falls on in a time zone (IANA name). */
function dayIn(now: Date, zone: string): CivilDay {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  } catch {
    throw new Error(`Relative dates: ${zone} is not a time zone (an IANA name such as Europe/London).`);
  }
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

/** A calendar day from a UTC date's fields (which normalise an overflowing day or month). */
function civil(year: number, month: number, day: number): CivilDay {
  const date = new Date(Date.UTC(year, month - 1, day));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** The number of days in a month. */
function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A day moved by whole months, keeping the day of the month where the month has it (Jan 31 + 1mo = Feb 28). */
function addMonths(day: CivilDay, months: number): CivilDay {
  const index = day.year * 12 + (day.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return { year, month, day: Math.min(day.day, daysIn(year, month)) };
}

/** A day moved by a shift. */
function shiftDay(day: CivilDay, shift: Shift): CivilDay {
  const n = shift.sign * shift.count;
  switch (shift.unit) {
    case 'd': return civil(day.year, day.month, day.day + n);
    case 'w': return civil(day.year, day.month, day.day + 7 * n);
    case 'mo': return addMonths(day, n);
    case 'y': return addMonths(day, 12 * n);
    case 'h': return day;
  }
}

/** The first or last day of the unit a day falls in. */
function edgeOf(day: CivilDay, edge: 'start' | 'end', unit: Unit): CivilDay {
  switch (unit) {
    case 'day': return day;
    case 'week': {
      const weekday = (new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() + 6) % 7; // Monday 0
      return civil(day.year, day.month, edge === 'start' ? day.day - weekday : day.day + 6 - weekday);
    }
    case 'month': return { ...day, day: edge === 'start' ? 1 : daysIn(day.year, day.month) };
    case 'quarter': {
      const first = Math.floor((day.month - 1) / 3) * 3 + 1;
      const month = edge === 'start' ? first : first + 2;
      return { year: day.year, month, day: edge === 'start' ? 1 : daysIn(day.year, month) };
    }
    case 'year': return edge === 'start' ? { year: day.year, month: 1, day: 1 } : { year: day.year, month: 12, day: 31 };
  }
}

/** The day a day expression names. */
function resolveDay(expr: DayExpr, today: CivilDay): CivilDay {
  if (expr.kind === 'today') { return expr.shift === undefined ? today : shiftDay(today, expr.shift); }
  return edgeOf(resolveDay(expr.base, today), expr.edge, expr.unit);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** An instant moved by a shift (months and years by the calendar, in UTC). */
function shiftInstant(now: Date, shift: Shift): Date {
  const n = shift.sign * shift.count;
  switch (shift.unit) {
    case 'h': return new Date(now.getTime() + n * HOUR_MS);
    case 'd': return new Date(now.getTime() + n * DAY_MS);
    case 'w': return new Date(now.getTime() + 7 * n * DAY_MS);
    case 'mo': case 'y': {
      const moved = new Date(now.getTime());
      moved.setUTCMonth(moved.getUTCMonth() + (shift.unit === 'y' ? 12 * n : n));
      return moved;
    }
  }
}

/** `YYYY-MM-DD`. */
function dayText(day: CivilDay): string {
  return `${String(day.year).padStart(4, '0')}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
}

/**
 * A relative date as a plain value at `now` in the time zone `zone` (an IANA name): `YYYY-MM-DD` for a day
 * (`RELATIVE_DATES[expr].yields === 'day'`), ISO text in UTC for an instant. Throws on an unknown time zone.
 *
 * ```ts
 * resolveRelative('startOf(month,today-1mo)', new Date('2026-03-15T10:00:00Z'), 'Europe/London'); // '2026-02-01'
 * ```
 */
export function resolveRelative(expr: RelativeDate, now: Date, zone: string): string {
  const parsed = parse(expr);
  if (parsed.kind === 'now') { return (parsed.shift === undefined ? now : shiftInstant(now, parsed.shift)).toISOString(); }
  return dayText(resolveDay(parsed, dayIn(now, zone)));
}

/** The relative dates that fill an argument of a gin type: days for `date`, instants for `timestamp`, else none. */
export function relativeDatesFor(typeName: string): RelativeDate[] {
  const yields = typeName === 'date' ? 'day' : typeName === 'timestamp' ? 'instant' : undefined;
  return yields === undefined ? [] : RELATIVE_DATE_EXPRS.filter((expr) => RELATIVE_DATES[expr].yields === yields);
}

/** An argument value as the source takes it: a literal as is, a relative date resolved at `now` in `zone`. */
export function resolveArgValue(value: ArgValue, now: Date, zone: string): Json {
  return 'literal' in value ? value.literal : resolveRelative(value.relative, now, zone);
}
