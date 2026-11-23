/**
 * The schedule pages' logic: the calendar's view state from its URL, the days each view shows (a daylight-saving week
 * included), stepping and titles, entries from coming firings and firing records, how each status looks, where an
 * entry leads, the args a literal program is, and the edit form's draft ↔ `when` round trips and change args.
 */
import { DataRecord, Json, QualifiedName, RunId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { OccurrenceKey, SchedulePayload, When } from '../shared/index.ts';
import { presetsFor } from '../shared/when.ts';
import {
  calendarUrl, changeArgsOf, dayHeading, draftOf, entriesByDay, entriesFor, entryLook, entryTarget, filterEntries, firingsOf, fixedArgsOf, itemUrl, rangeDays, rangeInstants,
  rangeQuery, rangeTitle, scheduleNameOf, scheduleOf, STATUS_LOOK, stepDay, viewOf, whenOfDraft, type ScheduleItem,
} from './logic.ts';

const NY = 'America/New_York';
const T0 = Date.parse('2026-11-23T12:00:00Z');

function payload(overrides: Record<string, unknown> = {}): SchedulePayload {
  return SchedulePayload.parse({
    fn: 'database/main.orders_by_week', when: { dayOfWeek: [1], times: ['09:00'] }, zone: NY,
    args: { kind: 'new', type: { name: 'obj' }, value: { limit: { kind: 'new', type: { name: 'num' }, value: 10 } } }, ...overrides,
  });
}
function item(overrides: Record<string, unknown> = {}, fn = 'schedule/weekly_orders'): ScheduleItem {
  return { fn: QualifiedName.parse(fn), title: 'Weekly orders', version: 2, payload: payload(overrides), available: true };
}
function firing(value: Record<string, unknown>, id = 'rec_01JABCDEFGHJKMNPQRSTVWXYZ0'): DataRecord {
  return DataRecord.parse({
    id, type: 'schedule/Firing', title: 'x', version: 1, createdAt: T0, updatedAt: T0,
    value: Json.parse({ schedule: 'schedule/weekly_orders', version: 2, at: Date.parse('2026-11-16T14:00:00Z'), key: '2026-11-16T09:00', manual: false, status: 'ran', notified: true, ...value }),
  });
}

describe('the calendar\'s URL', () => {
  it('reads its view, day and filters, leaving out what doesn\'t fit', () => {
    expect(calendarUrl({ view: 'week', day: '2026-11-23', schedule: 'schedule/weekly_orders', status: 'failed', entry: 'x' }))
      .toEqual({ view: 'week', day: '2026-11-23', schedule: 'schedule/weekly_orders', status: 'failed', entry: 'x' });
    expect(calendarUrl({ view: 'year', day: 'monday', status: 'lost', schedule: 'nope' })).toEqual({});
    expect(calendarUrl({ status: 'coming' })).toEqual({ status: 'coming' });
  });

  it('opens on the agenda on a phone and the month elsewhere, unless the URL says', () => {
    expect(viewOf({}, 390)).toBe('agenda');
    expect(viewOf({}, 1280)).toBe('month');
    expect(viewOf({ view: 'week' }, 390)).toBe('week');
  });

  it('reads a schedule page\'s URL and path', () => {
    expect(itemUrl({ tab: 'history', firing: '2026-11-30T09:00', edit: '1', status: 'ran' })).toEqual({ tab: 'history', firing: '2026-11-30T09:00', edit: '1', status: 'ran' });
    expect(itemUrl({ tab: 'other', firing: 'soon' })).toEqual({});
    expect(scheduleNameOf(['weekly_orders'])).toBe('schedule/weekly_orders');
    expect(scheduleNameOf([])).toBeUndefined();
  });
});

describe('ranges', () => {
  it('shows a month as whole weeks from Sunday, a week, or two weeks of agenda', () => {
    const month = rangeDays('month', '2026-11-23');
    expect(month[0]).toBe('2026-11-01');
    expect(month).toHaveLength(35);
    expect(month.at(-1)).toBe('2026-12-05');
    // February 2026 starts on a Sunday and fills exactly four weeks
    expect(rangeDays('month', '2026-02-10')).toHaveLength(28);
    expect(rangeDays('week', '2026-11-25')).toEqual(['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28']);
    expect(rangeDays('agenda', '2026-11-23')).toHaveLength(14);
  });

  it('covers a daylight-saving week by the viewer\'s days: 167 hours in spring, 169 in the fall', () => {
    const spring = rangeInstants(rangeDays('week', '2026-03-10'), NY);
    expect((spring.to - spring.from) / 3_600_000).toBe(167);
    const fall = rangeInstants(rangeDays('week', '2026-11-03'), NY);
    expect((fall.to - fall.from) / 3_600_000).toBe(169);
  });

  it('steps by a month, a week or the agenda\'s days, and titles each', () => {
    expect(stepDay('month', '2026-01-31', 1)).toBe('2026-02-01');
    expect(stepDay('month', '2026-01-15', -1)).toBe('2025-12-01');
    expect(stepDay('week', '2026-11-23', -1)).toBe('2026-11-16');
    expect(stepDay('agenda', '2026-11-23', 1)).toBe('2026-12-07');
    expect(rangeTitle('month', '2026-11-23')).toBe('November 2026');
    expect(rangeTitle('week', '2026-11-23')).toBe('Nov 22 – 28, 2026');
    expect(rangeTitle('week', '2026-12-01')).toBe('Nov 29 – Dec 5, 2026');
    expect(dayHeading('2026-11-24', '2026-11-23')).toBe('Tomorrow');
    expect(dayHeading('2026-11-30', '2026-11-23')).toBe('Mon, Nov 30');
    expect(dayHeading('2027-01-04', '2026-11-23')).toBe('Mon, Jan 4, 2027');
  });
});

describe('entries', () => {
  const week = rangeInstants(rangeDays('month', '2026-11-23'), NY);

  it('draws coming firings from now and the records in range, a record taking its firing\'s place', () => {
    const records = firingsOf([
      firing({}),
      firing({ at: Date.parse('2026-11-23T14:00:00Z'), key: '2026-11-23T09:00', status: 'running', run: RunId.parse('run_1') }, 'rec_01JABCDEFGHJKMNPQRSTVWXYZ1'),
    ]);
    const entries = entriesFor({ schedules: [item()], firings: records, ...week, now: Date.parse('2026-11-23T13:00:00Z'), zone: NY });
    expect(entries.map((entry) => [entry.key, entry.status])).toEqual([
      ['2026-11-16T09:00', 'ran'], ['2026-11-23T09:00', 'running'], ['2026-11-30T09:00', 'coming'],
    ]);
    expect(entries[2]?.fn).toBe('database/main.orders_by_week');
    const byDay = entriesByDay(entries);
    expect([...byDay.keys()]).toEqual(['2026-11-16', '2026-11-23', '2026-11-30']);
    expect(filterEntries(entries, { status: 'coming' }).map((entry) => entry.key)).toEqual(['2026-11-30T09:00']);
    expect(filterEntries(entries, { schedule: 'schedule/other' })).toEqual([]);
  });

  it('places a firing on the viewer\'s own day, and fades a paused schedule\'s coming ones', () => {
    const tokyo = item({ zone: 'Asia/Tokyo', when: { dayOfWeek: [1], times: ['08:00'] }, paused: { at: T0, by: 'act_ada', until: '2026-12-01' } });
    const entries = entriesFor({ schedules: [tokyo], firings: [], ...rangeInstants(rangeDays('month', '2026-12-10'), NY), now: T0, zone: NY }).slice(0, 2);
    // Monday 08:00 in Tokyo is Sunday evening in New York
    expect(entries.map((entry) => [entry.day, entry.paused])).toEqual([['2026-11-29', true], ['2026-12-06', false]]);
    const [first] = entries;
    expect(first === undefined ? '' : entryLook(first).word).toBe('Paused');
  });

  it('colours each status, and leads to the run or to the schedule at that firing', () => {
    expect(STATUS_LOOK.ran).toMatchObject({ tone: 'ok', colour: 'var(--ok)' });
    expect(STATUS_LOOK.failed.tone).toBe('danger');
    expect(STATUS_LOOK.refused.tone).toBe('danger');
    expect(STATUS_LOOK.missed.tone).toBe('warn');
    expect(STATUS_LOOK.expired.tone).toBe('warn');
    expect(STATUS_LOOK.skipped.tone).toBe('neutral');
    expect(STATUS_LOOK.waiting).toMatchObject({ tone: 'warn', live: true });
    expect(entryTarget({ run: RunId.parse('run_9'), schedule: 'schedule/weekly_orders', key: OccurrenceKey.parse('2026-11-16T09:00') })).toEqual({ run: 'run_9' });
    expect(entryTarget({ schedule: 'schedule/weekly_orders', key: OccurrenceKey.parse('2026-11-16T09:00') })).toEqual({ page: 'item', path: ['weekly_orders'], query: { firing: '2026-11-16T09:00' } });
  });

  it('asks the hub for a range\'s records under its filters', () => {
    expect(rangeQuery(1, 2, { schedule: 'schedule/weekly_orders', status: 'failed' }).query?.filters).toEqual([
      { field: 'at', op: 'gte', value: 1 }, { field: 'at', op: 'lt', value: 2 },
      { field: 'schedule', op: 'is', value: 'schedule/weekly_orders' }, { field: 'status', op: 'is', value: 'failed' },
    ]);
    // coming firings are no records
    expect(rangeQuery(1, 2, { status: 'coming' }).query?.filters).toHaveLength(2);
  });
});

describe('a schedule', () => {
  it('reads one from hub/fns_get, and only a schedule', () => {
    const stored = { fn: 'schedule/weekly_orders', kind: 'schedule/schedule', payload: payload(), version: 3, available: true };
    expect(scheduleOf(stored)).toMatchObject({ fn: 'schedule/weekly_orders', title: 'Weekly orders', version: 3 });
    expect(scheduleOf({ ...stored, kind: 'code/code' })).toBeUndefined();
    expect(scheduleOf({ ...stored, payload: { fn: 'x' } })).toBeUndefined();
  });

  it('reads the fixed args of a literal program, and none from one that works anything out', () => {
    expect(fixedArgsOf(payload().args)).toEqual({ limit: 10 });
    expect(fixedArgsOf({ kind: 'new', type: { name: 'list' }, value: [{ kind: 'new', type: { name: 'text' }, value: 'a' }, 'b'] })).toEqual(['a', 'b']);
    expect(fixedArgsOf({ kind: 'new', type: { name: 'obj' }, value: { day: { kind: 'get', path: [{ prop: 'fire' }, { prop: 'day' }] } } })).toBeUndefined();
  });
});

describe('the edit form', () => {
  it('round-trips every preset: when → draft → when', () => {
    for (const preset of presetsFor('2026-11-24', When.parse({ times: ['09:00'] }))) {
      const draft = draftOf(payload({ when: preset.when }), '2026-11-23');
      expect(draft.preset).toBe(preset.id);
      const back = whenOfDraft(draft);
      expect(back.ok && back.when).toEqual(preset.when);
    }
  });

  it('round-trips custom rules, ends and skips', () => {
    const custom = When.parse({ start: '2026-11-02', dayOfWeek: [1, 4], dayOfMonth: [1, 15], weeksSinceEpoch: { every: 3 }, maxOccurrences: 6, times: ['07:00', '18:30'], exclude: ['2026-11-05T07:00'] });
    const draft = draftOf(payload({ when: custom }), '2026-11-23');
    expect(draft).toMatchObject({ preset: 'custom', weekdays: [1, 4], monthDays: '1, 15', everyWeeks: '3', ends: 'after', count: '6' });
    const back = whenOfDraft(draft, custom);
    expect(back.ok && back.when).toEqual(custom);
    // rules the form can't edit are kept as they are
    const other = When.parse({ start: '2026-11-02', lastWeekspanOfMonth: [0], dayOfWeek: [5], month: [0, 6] });
    const kept = draftOf(payload({ when: other }), '2026-11-23');
    expect(kept.kept).toEqual(other);
    expect(whenOfDraft(kept, other)).toEqual({ ok: true, when: other });
  });

  it('says what is wrong, by field', () => {
    const draft = draftOf(payload(), '2026-11-23');
    const bad = whenOfDraft({ ...draft, preset: 'custom', weekdays: [], monthDays: '40', times: ['25:00'] });
    expect(bad.ok).toBe(false);
    const fixed = whenOfDraft({ ...draft, preset: 'custom', weekdays: [], monthDays: '40' });
    expect(!fixed.ok && Object.keys(fixed.problems).sort()).toEqual(['monthDays']);
    const ends = whenOfDraft({ ...draft, ends: 'on', endDay: '2026-01-01', day: '2026-11-23' });
    expect(!ends.ok && ends.problems['endDay']).toBe('The last day is before the first.');
  });

  it('asks schedule/change only for what changed', () => {
    const current = item();
    const draft = draftOf(current.payload, '2026-11-23');
    expect(changeArgsOf(current, draft)).toEqual({ ok: true, args: undefined });
    expect(changeArgsOf(current, { ...draft, notify: 'failed', maxSpend: '$0.50' })).toEqual({ ok: true, args: { schedule: 'schedule/weekly_orders', notify: 'failed', maxSpend: 0.5 } });
    expect(changeArgsOf(current, { ...draft, args: { limit: 20 } })).toEqual({ ok: true, args: { schedule: 'schedule/weekly_orders', args: { limit: 20 } } });
    expect(changeArgsOf(current, { ...draft, argsMode: 'compute', compute: 'week_start: the run\'s day minus 7 days' })).toEqual({
      ok: true, args: { schedule: 'schedule/weekly_orders', compute: 'week_start: the run\'s day minus 7 days' },
    });
    const moved = changeArgsOf(current, { ...draft, preset: 'weekly', day: '2026-11-25', times: ['10:00'] });
    expect(moved.ok && moved.args?.['when']).toEqual({ start: '2026-11-25', dayOfWeek: [3], times: ['10:00'] });
    expect(changeArgsOf(current, { ...draft, maxSpend: 'lots' }).ok).toBe(false);
  });
});
