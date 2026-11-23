/**
 * Local days and times in an IANA time zone, as instants, across daylight saving. This is Oryoli's rule
 * (`zonedTime` and `localNow` in its `server/src/reminders.ts`), copied here until dayspan offers it (the design's
 * library ask, slice 2, postponed): a time that doesn't happen (02:30 on the spring-forward night) is that many
 * minutes past the jump (03:30), and a time that happens twice (clocks go back) is its first.
 *
 * Plain functions over `Intl`, so the server's timer and the browser's calendar work out the same instants.
 */

const MINUTE = 60_000;

/** The parts `Intl` gives for an instant in a zone, by part type. */
function partsAt(at: number, zone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/**
 * Whether `zone` is an IANA time zone `Intl` knows (`America/New_York`, `UTC`). Offsets (`+05:00`) and abbreviations
 * with spaces are refused: a schedule keeps a named zone so its wall clock follows that zone's daylight saving.
 */
export function isIanaZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) { return false; }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The local day (`2026-11-12`) and minute of the day in `zone` at the instant `at` (ms). */
export function localNow(at: number, zone: string): { day: string; minute: number } {
  const get = partsAt(at, zone);
  const part = (name: string): string => get[name] ?? '00';
  return { day: `${part('year')}-${part('month')}-${part('day')}`, minute: Number(part('hour')) * 60 + Number(part('minute')) };
}

/** The wall clock in `zone` at `at`, read as if it were UTC (ms, to the minute). */
function wallAt(at: number, zone: string): number {
  const { day, minute } = localNow(at, zone);
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, minute);
}

/** How far `zone`'s wall clock is ahead of UTC at `at`, in minutes (New York in winter: -300). */
export function offsetAt(at: number, zone: string): number {
  return Math.round((wallAt(at, zone) - Math.floor(at / MINUTE) * MINUTE) / MINUTE);
}

/**
 * The instant a local `day` (`YYYY-MM-DD`) and `minute` of that day happen in `zone`: a time that happens twice is its
 * first; a time that doesn't happen is that many minutes past the jump.
 */
export function zonedTime(day: string, minute: number, zone: string): number {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, minute);
  const offset = (t: number): number => wallAt(t, zone) - Math.floor(t / MINUTE) * MINUTE;
  const first = naive - offset(naive);
  const second = naive - offset(first);
  if (first === second) { return first; }
  return wallAt(second, zone) === naive ? second : first;
}

/** An instant as the wall clock in `zone` reads it, with its offset: `2026-11-30T09:00:00-05:00`. */
export function localString(at: number, zone: string): string {
  const { day, minute } = localNow(at, zone);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const offset = offsetAt(at, zone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${day}T${pad(Math.floor(minute / 60))}:${pad(minute % 60)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
