/**
 * The schedule's zod shapes: `When`'s rules, the branded strings, the zone check, the payload's defaults, and the
 * zoned-instant rule (Oryoli's: a missing time moves past the jump, a doubled one is its first).
 */
import { wireType } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { ChangeArgs, LIMIT_DEFAULTS, limitsOf, schedule, View } from './index.ts';
import {
  ClockTime, FiringShape, LocalDay, OccurrenceKey, SchedulePayload, ScheduleView, When, Zone, gapProblems, whenRuleProblems,
} from './types.ts';
import { isIanaZone, localNow, localString, offsetAt, zonedTime } from './zoned.ts';

const messages = (value: unknown): string[] => {
  const parsed = When.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('When', () => {
  it('takes a one-off, a weekly rule and an every-other-week rule', () => {
    expect(When.parse({ on: '2026-12-01', times: ['08:30'] })).toEqual({ on: '2026-12-01', times: ['08:30'] });
    expect(When.safeParse({ dayOfWeek: [1], times: ['09:00'] }).success).toBe(true);
    expect(When.safeParse({ dayOfWeek: [1], weeksSinceEpoch: { every: 2 }, start: '2026-11-30' }).success).toBe(true);
    expect(When.safeParse({}).success).toBe(true);
  });

  it('refuses `on` beside day rules, or with start, end or a count', () => {
    expect(messages({ on: '2026-12-01', dayOfWeek: [1] }).join(' ')).toMatch(/one-off.*dayOfWeek/);
    expect(messages({ on: '2026-12-01', end: '2026-12-31' }).join(' ')).toMatch(/no `start`, `end`/);
  });

  it('refuses maxOccurrences without start, start after end, and a time twice', () => {
    expect(messages({ dayOfWeek: [1], maxOccurrences: 3 }).join(' ')).toMatch(/needs `start`/);
    expect(messages({ start: '2026-12-02', end: '2026-12-01' }).join(' ')).toMatch(/after `end`/);
    expect(messages({ times: ['09:00', '09:00'] }).join(' ')).toMatch(/twice/);
  });

  it('refuses unknown keys and values out of range', () => {
    expect(When.safeParse({ dayOfWeek: [7] }).success).toBe(false);
    expect(When.safeParse({ month: [12] }).success).toBe(false);
    expect(When.safeParse({ dayOfWeek: [] }).success).toBe(false);
    expect(When.safeParse({ everyWeeks: 2 }).success).toBe(false);
    expect(When.safeParse({ times: ['9:00'] }).success).toBe(false);
    expect(When.safeParse({ times: ['24:00'] }).success).toBe(false);
  });

  it('gives its rule problems as plain words too, for checks that are not a parse', () => {
    expect(whenRuleProblems({ dayOfWeek: [1] })).toEqual([]);
    expect(whenRuleProblems({ on: '2026-12-01', month: [0] })).toHaveLength(1);
  });

  it('finds times closer than the shortest gap', () => {
    expect(gapProblems({ times: ['09:00', '09:10', '12:00'] }, LIMIT_DEFAULTS.minGap)).toEqual([
      '09:00 and 09:10 are less than 15 minutes apart, the shortest gap between two runs.',
    ]);
    expect(gapProblems({ times: ['09:00', '09:15'] }, LIMIT_DEFAULTS.minGap)).toEqual([]);
    expect(gapProblems({}, LIMIT_DEFAULTS.minGap)).toEqual([]);
  });
});

describe('the branded strings', () => {
  it('takes a day, a time and a firing key in the forms dayspan reads', () => {
    expect(LocalDay.safeParse('2026-12-25').success).toBe(true);
    expect(LocalDay.safeParse('2026-12-25T09:00').success).toBe(false);
    expect(ClockTime.safeParse('23:59').success).toBe(true);
    expect(ClockTime.safeParse('7:00').success).toBe(false);
    expect(OccurrenceKey.safeParse('2026-12-25').success).toBe(true);
    expect(OccurrenceKey.safeParse('2026-12-24T18:00').success).toBe(true);
    expect(OccurrenceKey.safeParse('2026-12-24 18:00').success).toBe(false);
    expect(OccurrenceKey.safeParse('2026-12-24T25:00').success).toBe(false);
  });

  it('takes skipped and extra firings as keys', () => {
    expect(When.safeParse({ dayOfWeek: [1], times: ['09:00'], exclude: ['2026-12-28T09:00'], include: ['2026-12-31'] }).success).toBe(true);
    expect(When.safeParse({ exclude: ['next monday'] }).success).toBe(false);
  });
});

describe('Zone', () => {
  it('takes IANA zones and refuses offsets and made-up names', () => {
    for (const zone of ['America/New_York', 'Europe/London', 'UTC', 'America/Argentina/Buenos_Aires']) { expect(Zone.safeParse(zone).success, zone).toBe(true); }
    for (const zone of ['+05:00', 'Mars/Olympus', 'New York', '']) { expect(isIanaZone(zone), zone).toBe(false); }
  });
});

const PROGRAM = { kind: 'new', type: { name: 'obj', props: {} }, value: {} };

describe('SchedulePayload', () => {
  it('fills in notify, overlap and missed', () => {
    const payload = SchedulePayload.parse({ fn: 'database/main.orders_by_week', when: { dayOfWeek: [1], times: ['09:00'] }, zone: 'America/New_York', args: PROGRAM });
    expect(payload).toMatchObject({ notify: 'always', overlap: 'skip', missed: 'latest' });
    expect(payload.maxSpend).toBeUndefined();
  });

  it('refuses a fn that is not a qualified name, a bad zone, a spend of 0 and fields it does not have', () => {
    const base = { fn: 'schedule/remind', when: {}, zone: 'UTC', args: PROGRAM };
    expect(SchedulePayload.safeParse(base).success).toBe(true);
    expect(SchedulePayload.safeParse({ ...base, fn: 'remind' }).success).toBe(false);
    expect(SchedulePayload.safeParse({ ...base, zone: 'Nowhere/Here' }).success).toBe(false);
    expect(SchedulePayload.safeParse({ ...base, maxSpend: 0 }).success).toBe(false);
    expect(SchedulePayload.safeParse({ ...base, deliver: 'chat' }).success).toBe(false);
    expect(SchedulePayload.safeParse({ ...base, args: 'not a program' }).success).toBe(false);
  });
});

describe('FiringShape and ScheduleView', () => {
  const firing = { schedule: 'schedule/weekly_orders_summary', version: 3, at: 1_796_400_000_000, key: '2026-11-30T09:00', manual: false, status: 'ran', notified: true };

  it('keeps a firing by its key, with no separate day or time', () => {
    expect(FiringShape.safeParse(firing).success).toBe(true);
    expect(FiringShape.safeParse({ ...firing, day: '2026-11-30' }).success).toBe(false);
    expect(FiringShape.safeParse({ ...firing, summary: 'x'.repeat(161) }).success).toBe(false);
  });

  it('shows a schedule with its last firing', () => {
    expect(ScheduleView.safeParse({
      schedule: 'schedule/weekly_orders_summary', fn: 'database/main.orders_by_week', says: 'Every Monday at 9:00 am', zone: 'America/New_York', notify: 'always',
      next: [{ at: 1_796_400_000_000, local: '2026-11-30T09:00:00-05:00' }], last: { at: 1_795_795_200_000, status: 'ran', summary: '12 rows' },
    }).success).toBe(true);
  });
});

describe('the contract', () => {
  it('makes gin of the zod shapes, change taking every field of add as optional', () => {
    const props = wireType(ChangeArgs).props ?? {};
    expect(props['when']?.type.name).toBe('optional');
    expect(props['schedule']?.type.name).toBe('text');
    expect(wireType(View).name).toBe('obj');
  });

  it('declares the kind, every fn, the Firing type and the injected item', () => {
    expect(schedule.kinds.schedule.name).toBe('schedule/schedule');
    expect(Object.keys(schedule.fns).sort()).toEqual(['add', 'allow_runs', 'change', 'history', 'list', 'pause', 'remind', 'remove', 'resume', 'skip']);
    expect(schedule.types.Firing.name).toBe('schedule/Firing');
    expect(schedule.defs.context.basics.inject?.into).toEqual(['hub/chat*']);
    expect(schedule.pages.map((page) => page.segment)).toEqual(['calendar', 'item', 'all']);
  });

  it('fills in the limits an admin leaves unset', () => {
    expect(limitsOf({})).toEqual(LIMIT_DEFAULTS);
    expect(limitsOf({ perPerson: 5 }).perPerson).toBe(5);
  });
});

describe('zoned instants', () => {
  const NY = 'America/New_York';

  it('reads a wall clock in a zone, with its offset', () => {
    const at = zonedTime('2026-11-30', 9 * 60, NY);
    expect(new Date(at).toISOString()).toBe('2026-11-30T14:00:00.000Z');
    expect(localNow(at, NY)).toEqual({ day: '2026-11-30', minute: 540 });
    expect(offsetAt(at, NY)).toBe(-300);
    expect(localString(at, NY)).toBe('2026-11-30T09:00:00-05:00');
    expect(localString(zonedTime('2026-07-01', 9 * 60, NY), NY)).toBe('2026-07-01T09:00:00-04:00');
  });

  it('moves a time that does not happen past the jump, and takes the first of one that happens twice', () => {
    // 2026-03-08: 02:00 becomes 03:00 in New York
    expect(localString(zonedTime('2026-03-08', 2 * 60 + 30, NY), NY)).toBe('2026-03-08T03:30:00-04:00');
    // 2026-11-01: 01:30 happens twice; the first is daylight time
    expect(localString(zonedTime('2026-11-01', 90, NY), NY)).toBe('2026-11-01T01:30:00-04:00');
  });
});
