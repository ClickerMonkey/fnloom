/**
 * The person's current time, as the chat module and every system get it: now, their zone (UTC when the platform
 * doesn't know the one given) and the local time with its offset.
 */
import type { TimeInfo } from '@harness/core';

/** Whether the platform knows an IANA time zone. */
export function knownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `now` in a known zone as `2026-11-07T09:30:00-05:00`. */
export function localTime(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const offset = part('timeZoneName').replace('GMT', '');
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset === '' ? '+00:00' : offset}`;
}

/** The time facts for a person in a zone. */
export function timeInfo(now: number, timeZone: string): TimeInfo {
  const zone = knownZone(timeZone) ? timeZone : 'UTC';
  return { now, timeZone: zone, local: localTime(now, zone) };
}

/** The weekday name of a moment in a zone ("Saturday"). */
export function weekday(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: knownZone(timeZone) ? timeZone : 'UTC', weekday: 'long' }).format(new Date(now));
}
