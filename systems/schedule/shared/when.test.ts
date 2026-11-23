/**
 * A schedule's firings over dayspan (`when.ts`): the days its rules give, times, skips and extras, `maxOccurrences`
 * from `start`, one-offs, instants across daylight saving in the schedule's zone (whatever the host's), the next
 * firings, the words it says, and the presets from dayspan's patterns (each preset's `when` reads back as itself).
 */
import { describe, expect, it } from 'vitest';
import { When } from './types.ts';
import {
  addDays, clockWords, daysBetween, describeWhen, firingOf, firingsBetween, firingsOnDays, fromOccurrenceKey, nextFirings, occurrenceKey, PRESET_IDS, presetDay, presetOf,
  presetsFor, zoneWords,
} from './when.ts';

const NY = 'America/New_York';
const when = (value: unknown): When => When.parse(value);
const iso = (at: number): string => new Date(at).toISOString();

describe('days and keys', () => {
  it('moves days across months, years and leap days without a zone', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
  });

  it('writes and reads a firing\'s key', () => {
    expect(occurrenceKey('2026-12-24', '18:00')).toBe('2026-12-24T18:00');
    expect(occurrenceKey('2026-12-25')).toBe('2026-12-25');
    expect(fromOccurrenceKey('2026-12-24T18:00')).toEqual({ day: '2026-12-24', time: '18:00' });
    expect(fromOccurrenceKey('2026-12-25')).toEqual({ day: '2026-12-25' });
  });
});

describe('firings', () => {
  it('gives each time on each day the rules give, less skips, plus extras', () => {
    const mondays = when({ dayOfWeek: [1], times: ['17:30', '09:00'], exclude: ['2026-11-30T09:00', '2026-12-07'], include: ['2026-11-25T08:00'] });
    expect(firingsOnDays(mondays, NY, '2026-11-20', '2026-12-15').map((firing) => firing.key)).toEqual([
      '2026-11-23T09:00', '2026-11-23T17:30', '2026-11-25T08:00', '2026-11-30T17:30', '2026-12-14T09:00', '2026-12-14T17:30',
    ]);
  });

  it('gives a schedule with no times one whole-day firing at 00:00 in its zone', () => {
    const [first] = firingsOnDays(when({ dayOfMonth: [1] }), NY, '2026-12-01', '2026-12-01');
    expect(first).toEqual({ key: '2026-12-01', day: '2026-12-01', at: Date.parse('2026-12-01T05:00:00Z') });
  });

  it('counts maxOccurrences from start, also for a range that starts later', () => {
    const three = when({ start: '2026-11-01', maxOccurrences: 3, dayOfWeek: [1] });
    expect(firingsOnDays(three, NY, '2026-11-01', '2026-12-31').map((firing) => firing.day)).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
    expect(firingsOnDays(three, NY, '2026-11-10', '2026-12-31').map((firing) => firing.day)).toEqual(['2026-11-16']);
    expect(firingsOnDays(three, NY, '2026-11-17', '2026-12-31')).toEqual([]);
  });

  it('keeps start and end, the end day whole', () => {
    const daily = when({ start: '2026-11-03', end: '2026-11-05', times: ['23:30'] });
    expect(firingsOnDays(daily, NY, '2026-11-01', '2026-11-30').map((firing) => firing.key)).toEqual(['2026-11-03T23:30', '2026-11-04T23:30', '2026-11-05T23:30']);
  });

  it('gives a one-off only on its day', () => {
    const once = when({ on: '2026-12-01', times: ['08:30'] });
    expect(firingsOnDays(once, NY, '2026-11-01', '2026-11-30')).toEqual([]);
    expect(firingsOnDays(once, NY, '2026-11-01', '2026-12-31').map((firing) => iso(firing.at))).toEqual(['2026-12-01T13:30:00.000Z']);
  });

  it('keeps 9:00 at 9:00 across daylight saving, and fires a time that doesn\'t happen after the jump', () => {
    // the spring-forward week in New York (Sunday 8 March 2026, 02:00 → 03:00)
    const daily = when({ times: ['02:30', '09:00'] });
    const week = firingsOnDays(daily, NY, '2026-03-07', '2026-03-09');
    expect(week.map((firing) => [firing.key, iso(firing.at)])).toEqual([
      ['2026-03-07T02:30', '2026-03-07T07:30:00.000Z'], ['2026-03-07T09:00', '2026-03-07T14:00:00.000Z'],
      // 02:30 doesn't happen: it fires at 03:30 EDT, under its own key
      ['2026-03-08T02:30', '2026-03-08T07:30:00.000Z'], ['2026-03-08T09:00', '2026-03-08T13:00:00.000Z'],
      ['2026-03-09T02:30', '2026-03-09T06:30:00.000Z'], ['2026-03-09T09:00', '2026-03-09T13:00:00.000Z'],
    ]);
    // the fall-back week (Sunday 1 November 2026, 02:00 → 01:00): 01:30 happens twice and fires once, at the first
    const back = firingsOnDays(when({ times: ['01:30'] }), NY, '2026-10-31', '2026-11-02');
    expect(back.map((firing) => iso(firing.at))).toEqual(['2026-10-31T05:30:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  });

  it('reads the same in any zone the schedule names', () => {
    const tokyo = firingsOnDays(when({ dayOfWeek: [1], times: ['09:00'] }), 'Asia/Tokyo', '2026-11-23', '2026-11-23');
    expect(tokyo.map((firing) => iso(firing.at))).toEqual(['2026-11-23T00:00:00.000Z']);
  });

  it('gives the firings between two instants, and the next ones from an instant', () => {
    const mondays = when({ dayOfWeek: [1], times: ['09:00'] });
    const from = Date.parse('2026-11-23T14:00:00Z');
    expect(firingsBetween(mondays, NY, from, from + 14 * 86_400_000).map((firing) => firing.key)).toEqual(['2026-11-23T09:00', '2026-11-30T09:00']);
    expect(nextFirings(mondays, NY, from + 1, 3).map((firing) => firing.key)).toEqual(['2026-11-30T09:00', '2026-12-07T09:00', '2026-12-14T09:00']);
    // a 29 February firing is years away; a one-off in the past has none
    expect(nextFirings(when({ month: [1], dayOfMonth: [29] }), NY, from, 2).map((firing) => firing.day)).toEqual(['2028-02-29', '2032-02-29']);
    expect(nextFirings(when({ on: '2026-01-01' }), NY, from, 3)).toEqual([]);
  });

  it('finds the firing a key names, unless it is skipped', () => {
    const mondays = when({ dayOfWeek: [1], times: ['09:00'], exclude: ['2026-11-30T09:00'] });
    expect(firingOf(mondays, NY, '2026-11-23T09:00')?.at).toBe(Date.parse('2026-11-23T14:00:00Z'));
    expect(firingOf(mondays, NY, '2026-11-30T09:00')).toBeUndefined();
    expect(firingOf(mondays, NY, '2026-11-24T09:00')).toBeUndefined();
  });
});

describe('words', () => {
  it('says a schedule plainly, with its zone when it isn\'t the viewer\'s', () => {
    const today = '2026-11-23';
    expect(describeWhen(when({ dayOfWeek: [1], times: ['09:00'] }), NY, { viewerZone: NY, today })).toBe('Every week on Monday at 9:00 am');
    expect(describeWhen(when({ dayOfWeek: [1], times: ['09:00'] }), NY, { viewerZone: 'Europe/London', today })).toBe('Every week on Monday at 9:00 am, New York time');
    expect(describeWhen(when({ dayOfWeek: [1, 2, 3, 4, 5], times: ['07:00', '19:00'] }), NY, { viewerZone: NY, today })).toBe('Every weekday (Monday to Friday) at 7:00 am and 7:00 pm');
    expect(describeWhen(when({ on: '2027-01-04', times: ['08:30'] }), NY, { viewerZone: NY, today })).toBe('Once, on Mon, Jan 4, 2027 at 8:30 am');
    expect(describeWhen(when({ dayOfMonth: [1, 15], times: ['07:00'] }), NY, { viewerZone: NY, today })).toBe('On the 1st and 15th at 7:00 am');
    expect(describeWhen(when({ dayOfWeek: [1, 3], end: '2027-02-01' }), NY, { viewerZone: NY, today })).toBe('On Monday and Wednesday, until Mon, Feb 1, 2027');
    expect(describeWhen(when({ start: '2026-12-01', maxOccurrences: 4, dayOfWeek: [2] }), NY, { viewerZone: NY, today })).toBe('Every week on Tuesday, from Tue, Dec 1, 4 times');
  });

  it('writes times and zones as people say them', () => {
    expect(clockWords('00:05')).toBe('12:05 am');
    expect(clockWords('12:00')).toBe('12:00 pm');
    expect(zoneWords('America/Los_Angeles')).toBe('Los Angeles time');
    expect(zoneWords('UTC')).toBe('UTC');
  });
});

describe('presets', () => {
  it('offers dayspan\'s patterns for a day, each reading back as itself', () => {
    const presets = presetsFor('2026-11-24', when({ times: ['09:00'] }));
    expect(presets.map((preset) => preset.label)).toEqual([
      'Once', 'Every day', 'Every weekday (Monday to Friday)', 'Every week on Tuesday', 'Every other week on Tuesday', 'Every month on the 24th',
      'Every month on the 4th Tuesday', 'Every month on the last Tuesday', 'Every year on November 24',
    ]);
    for (const preset of presets) {
      expect(presetOf(preset.when)).toBe(preset.id);
      expect(preset.when.times).toEqual(['09:00']);
      expect(presetDay(preset.when, NY, '2026-11-01')).toBe('2026-11-24');
    }
    // the last day of the month only from the last day
    expect(presetsFor('2026-11-30').map((preset) => preset.id)).toContain('lastDay');
    expect(PRESET_IDS).toContain('custom');
  });

  it('calls any other rules custom', () => {
    expect(presetOf(when({ dayOfMonth: [1, 15] }))).toBe('custom');
    expect(presetOf(when({ dayOfWeek: [1], weeksSinceEpoch: { every: 3 } }))).toBe('custom');
    expect(presetOf(when({ dayOfWeek: [1], weeksSinceEpoch: { every: 2, offset: 1 } }))).toBe('custom');
  });
});
