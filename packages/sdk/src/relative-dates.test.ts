/** Relative dates resolve to plain values in the person's time zone, and only fill the arg types they yield. */
import { RELATIVE_DATE_EXPRS, type RelativeDate } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { relativeDatesFor, resolveArgValue, resolveRelative } from './relative-dates.ts';

// a Sunday, 23:30 in UTC: already Monday in Tokyo
const NOW = new Date('2026-03-29T23:30:00Z');

describe('relative dates', () => {
  it('resolves every listed expression', () => {
    const utc = Object.fromEntries(RELATIVE_DATE_EXPRS.map((expr) => [expr, resolveRelative(expr, NOW, 'UTC')]));
    expect(utc).toEqual({
      'today': '2026-03-29', 'today-1d': '2026-03-28', 'today+1d': '2026-03-30', 'today-7d': '2026-03-22', 'today-30d': '2026-02-27', 'today+7d': '2026-04-05',
      'startOf(week)': '2026-03-23', 'endOf(week)': '2026-03-29', 'startOf(month)': '2026-03-01', 'endOf(month)': '2026-03-31',
      'startOf(month,today-1mo)': '2026-02-01', 'startOf(quarter)': '2026-01-01', 'startOf(year)': '2026-01-01',
      'now': '2026-03-29T23:30:00.000Z', 'now-1h': '2026-03-29T22:30:00.000Z', 'now-24h': '2026-03-28T23:30:00.000Z',
    } satisfies Record<RelativeDate, string>);
  });

  it('counts days in the person\'s time zone', () => {
    expect(resolveRelative('today', NOW, 'Asia/Tokyo')).toBe('2026-03-30');
    expect(resolveRelative('startOf(week)', NOW, 'Asia/Tokyo')).toBe('2026-03-30');
    expect(resolveRelative('startOf(month,today-1mo)', new Date('2026-03-31T12:00:00Z'), 'UTC')).toBe('2026-02-01');
    expect(() => resolveRelative('today', NOW, 'Mars/Olympus')).toThrow(/not a time zone/);
  });

  it('offers days for date args and instants for timestamps, and passes literals through', () => {
    expect(relativeDatesFor('date')).toContain('startOf(month)');
    expect(relativeDatesFor('date')).not.toContain('now');
    expect(relativeDatesFor('timestamp')).toEqual(['now', 'now-1h', 'now-24h']);
    expect(relativeDatesFor('text')).toEqual([]);
    expect(resolveArgValue({ literal: 3 }, NOW, 'UTC')).toBe(3);
    expect(resolveArgValue({ relative: 'today' }, NOW, 'UTC')).toBe('2026-03-29');
  });
});
