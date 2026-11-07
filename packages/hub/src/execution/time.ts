/** The person's current time, as every system gets it: now, their zone, and the local time with its offset. */
import type { TimeInfo } from '@harness/core';

/** The zone to use: the person's if the platform knows it, else UTC. */
function knownZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** `now` in a zone as `2026-11-07T09:30:00-05:00`. */
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
  const zone = knownZone(timeZone);
  return { now, timeZone: zone, local: localTime(now, zone) };
}
