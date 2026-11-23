/**
 * The fixed rules a firing is summed up and told by (no model): the summary line for each kind of result and outcome,
 * the "late" suffix and the 160-character cap; which firings are told; titles and tones.
 */
import { NOTIFICATION_BODY, QualifiedName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { plainParagraph, spanWords, summaryLine, tells, titleOf, toneOf } from './summary.ts';

const TARGET = QualifiedName.parse('database/main.orders_by_week');
const HOUR = 3_600_000;

describe('the summary line', () => {
  it('says why a firing did not run cleanly, clamped', () => {
    expect(summaryLine({ status: 'failed', target: TARGET, reason: 'The orders table is locked.' })).toBe('The orders table is locked.');
    expect(summaryLine({ status: 'refused', target: TARGET, reason: 'x '.repeat(200) }).length).toBeLessThanOrEqual(NOTIFICATION_BODY);
    expect(summaryLine({ status: 'cancelled', target: TARGET })).toBe('It was cancelled.');
  });

  it('gives a text result\'s first paragraph without markdown', () => {
    const text = '## Weekly **orders**\n\nSecond paragraph.';
    expect(summaryLine({ status: 'ran', target: TARGET, result: text })).toBe('Weekly orders');
    expect(plainParagraph('- See [the report](https://example.com) and `code`')).toBe('See the report and code');
  });

  it('counts a table\'s rows and a list\'s items, with the first row\'s telling values', () => {
    const table = { columns: [{ name: 'item' }, { name: 'total' }], rows: [['Widgets', 1240], ['Gadgets', 90]] };
    expect(summaryLine({ status: 'ran', target: TARGET, result: table })).toBe('2 rows: Widgets 1240, …');
    expect(summaryLine({ status: 'ran', target: TARGET, result: [{ title: 'Ship the release' }, { title: 'Write notes' }, { title: 'Tag it' }] })).toBe('3 items: Ship the release, …');
    expect(summaryLine({ status: 'ran', target: TARGET, result: [] })).toBe('0 items');
  });

  it('reads an object\'s most telling text field', () => {
    expect(summaryLine({ status: 'ran', target: TARGET, result: { total: 3, message: 'Three tickets closed.' } })).toBe('Three tickets closed.');
    expect(summaryLine({ status: 'ran', target: TARGET, result: { summary: 'All quiet.', message: 'ignored' } })).toBe('All quiet.');
  });

  it('falls back to the target\'s done status line, then "Ran <fn>"', () => {
    expect(summaryLine({ status: 'ran', target: TARGET, result: { total: 3 }, doneText: 'Found 12 orders' })).toBe('Found 12 orders');
    expect(summaryLine({ status: 'ran', target: TARGET, result: null })).toBe('Ran main orders by week');
  });

  it('adds how late it started, past the on-time margin, within the cap', () => {
    expect(summaryLine({ status: 'ran', target: TARGET, result: 'Done.', late: 2 * HOUR })).toBe('Done. (2 h late)');
    expect(summaryLine({ status: 'ran', target: TARGET, result: 'Done.', late: 30_000 })).toBe('Done.');
    const long = summaryLine({ status: 'ran', target: TARGET, result: 'word '.repeat(80), late: 2 * HOUR });
    expect(long.length).toBeLessThanOrEqual(NOTIFICATION_BODY);
    expect(long.endsWith('… (2 h late)')).toBe(true);
    expect(spanWords(5 * 60_000)).toBe('5 min');
    expect(spanWords(3 * 24 * HOUR)).toBe('3 d');
  });
});

describe('which firings are told', () => {
  const base = { notify: 'always', manual: false } as const;

  it('tells every settled firing with always, all but those that ran with failed, none with never', () => {
    expect(tells({ ...base, status: 'ran' })).toBe(true);
    expect(tells({ ...base, notify: 'failed', status: 'ran' })).toBe(false);
    for (const status of ['failed', 'missed', 'expired', 'refused', 'cancelled'] as const) {
      expect(tells({ ...base, notify: 'failed', status })).toBe(true);
      expect(tells({ ...base, notify: 'never', status })).toBe(false);
    }
  });

  it('never tells a skipped or a manual firing, nor one still going', () => {
    expect(tells({ ...base, status: 'skipped' })).toBe(false);
    expect(tells({ ...base, status: 'failed', manual: true })).toBe(false);
    expect(tells({ ...base, status: 'running' })).toBe(false);
  });

  it('sends no second "ran" when the run told its person, but still tells a failure', () => {
    expect(tells({ ...base, status: 'ran', notifiedByRun: true })).toBe(false);
    expect(tells({ ...base, status: 'failed', notifiedByRun: true })).toBe(true);
  });

  it('tells a refusal once per reason, and a cancel only when the person didn\'t cancel it', () => {
    expect(tells({ ...base, status: 'refused', reason: 'No access.', refusedBefore: 'No access.' })).toBe(false);
    expect(tells({ ...base, status: 'refused', reason: 'Too many.', refusedBefore: 'No access.' })).toBe(true);
    expect(tells({ ...base, status: 'cancelled', byPerson: true })).toBe(false);
  });

  it('titles and tones the outcome', () => {
    expect(titleOf('Weekly summary', 'ran')).toBe('Weekly summary ran');
    expect(titleOf('Weekly summary', 'missed', 3)).toBe('Weekly summary missed 3 runs');
    expect(titleOf('Weekly summary', 'expired')).toBe('Weekly summary gave up waiting for approval');
    expect([toneOf('ran'), toneOf('missed'), toneOf('failed')]).toEqual(['ok', 'info', 'failed']);
  });
});
