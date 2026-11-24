/**
 * Local days and times in an IANA time zone, as instants, across daylight saving: dayspan's `TimeZone` (dayspan 1.3,
 * the design's library ask, slice 2), under the names this system's code and its exports use. The rule is the one
 * Oryoli's reminders use too, from the same code: a time that doesn't happen (02:30 on the spring-forward night) is
 * that many minutes past the jump (03:30), and a time that happens twice (clocks go back) is its first.
 *
 * Plain functions over `Intl`, so the server's timer and the browser's calendar work out the same instants. Each
 * throws a `RangeError` for a zone `Intl` doesn't know; a schedule's `Zone` is checked with `isIanaZone` first.
 */
import dayspan from 'dayspan';

// dayspan is a CommonJS bundle: its classes are on the default export, in Node and in the browser's build alike
const { TimeZone } = dayspan;

/**
 * Whether `zone` is an IANA time zone `Intl` knows (`America/New_York`, `UTC`). Offsets (`+05:00`) and abbreviations
 * with spaces are refused: a schedule keeps a named zone so its wall clock follows that zone's daylight saving.
 */
export function isIanaZone(zone: string): boolean {
  return TimeZone.isValid(zone);
}

/** The local day (`2026-11-12`) and minute of the day in `zone` at the instant `at` (ms). */
export function localNow(at: number, zone: string): { day: string; minute: number } {
  return TimeZone.local(at, zone);
}

/** How far `zone`'s wall clock is ahead of UTC at `at`, in minutes (New York in winter: -300). */
export function offsetAt(at: number, zone: string): number {
  return TimeZone.offset(at, zone);
}

/**
 * The instant a local `day` (`YYYY-MM-DD`) and `minute` of that day happen in `zone`: a time that happens twice is its
 * first; a time that doesn't happen is that many minutes past the jump.
 */
export function zonedTime(day: string, minute: number, zone: string): number {
  return TimeZone.instant(day, minute, zone);
}

/** An instant as the wall clock in `zone` reads it, with its offset: `2026-11-30T09:00:00-05:00`. */
export function localString(at: number, zone: string): string {
  return TimeZone.localString(at, zone);
}
