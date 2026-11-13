import { describe, expect, it } from 'vitest';
import { BUILT_IN_ENTRIES, RecordUpdate, WidgetSpecV1, columnFacts, rankVisuals, toCsv, upgradeWidgetSpec, type ResultTable } from './index.ts';

const table = (columns: ResultTable['columns'], rows: ResultTable['rows'], truncated = false): ResultTable => ({ columns, rows, offset: 0, truncated, sort: [] });

describe('visual ranking (widget pass)', () => {
  it('ranks by coverage, then priority, and hides what cannot draw', () => {
    const byStage = table([{ name: 'stage', kind: 'text', nullable: false }, { name: 'count', kind: 'integer', nullable: false }], [['todo', 3], ['doing', 2], ['done', 5]]);
    const ranked = rankVisuals(BUILT_IN_ENTRIES, columnFacts(byStage), byStage).map((rank) => rank.visual);
    expect(ranked.slice(0, 2)).toEqual(['part', 'category']);
    expect(ranked).toContain('table');
    expect(ranked).not.toContain('gauge');
  });

  it('never binds opaque columns, and prefers a date key as a time series', () => {
    const daily = table([{ name: 'id', kind: 'uuid', nullable: false }, { name: 'day', kind: 'date', nullable: false }, { name: 'total', kind: 'number', nullable: false }], [
      ['0b6f3c1e-9a52-4c1e-8f2a-1d2e3f4a5b6c', '2026-11-01', 4], ['1b6f3c1e-9a52-4c1e-8f2a-1d2e3f4a5b6c', '2026-11-02', 6],
    ]);
    const [best] = rankVisuals(BUILT_IN_ENTRIES, columnFacts(daily), daily);
    expect(best?.visual).toBe('time');
    expect(Object.values(best?.bind ?? {}).flat()).not.toContain('id');
  });

  it('never binds a column with a value per row (free text) as a series', () => {
    const notes = table([{ name: 'title', kind: 'text', nullable: false }, { name: 'body', kind: 'text', nullable: true }, { name: 'words', kind: 'integer', nullable: false }], [
      ['Plan the trip', 'Book the cabin.', 6], ['Groceries', 'Milk, eggs.', 3], ['Old idea', 'A garden.', 5],
    ]);
    const bars = rankVisuals(BUILT_IN_ENTRIES, columnFacts(notes), notes).find((rank) => rank.visual === 'category');
    expect(bars?.bind).toEqual({ x: ['title'], y: ['words'] });
  });

  it('withholds whole-only styles from a page', () => {
    const page = table([{ name: 'k', kind: 'text', nullable: false }, { name: 'v', kind: 'integer', nullable: false }], [['a', 1], ['b', 2]], true);
    const ranks = rankVisuals(BUILT_IN_ENTRIES, columnFacts(page), page);
    expect(ranks.map((rank) => rank.visual)).not.toContain('part');
    expect(ranks.find((rank) => rank.visual === 'category')?.styles).not.toContain('percent');
  });

  it('upgrades a build 8 spec', () => {
    const old = WidgetSpecV1.parse({ title: 'T', source: 'database/q', visuals: [{ visual: 'bar', bind: { label: ['s'], value: ['n'] } }], controls: [{ arg: 'p', pinned: 'x' }], actions: [{ fn: 'todo/Task.done', bind: {}, then: 'show' }] });
    expect(upgradeWidgetSpec(old)).toEqual({
      title: 'T', source: 'database/q', visuals: [{ visual: 'category', style: 'bar', bind: { x: ['s'], y: ['n'] } }], args: { p: { show: 'pinned', value: { literal: 'x' } } }, presets: [],
      actions: [{ fn: 'todo/Task.done', bind: {}, then: 'open' }],
    });
    const chosen = WidgetSpecV1.parse({ title: 'T', source: 'database/q', visuals: [{ visual: 'bar', bind: { label: ['s'], value: ['n'] } }], controls: [{ arg: 'status', choices: ['open', 3] }, { arg: 'h', hidden: true }] });
    expect(upgradeWidgetSpec(chosen).args).toEqual({
      status: { show: 'control', choices: [{ label: 'open', value: { literal: 'open' } }, { label: '3', value: { literal: 3 } }] }, h: { show: 'hidden' },
    });
  });

  it('writes a table as CSV, the header first, and refuses a record update that sets nothing', () => {
    expect(toCsv([{ name: 'a' }, { name: 'b' }], [[1, 'x,y']]).split('\r\n')).toEqual(['a,b', '1,"x,y"', '']);
    expect(RecordUpdate.safeParse({ type: 'notes/Note', id: 'rec_1', set: {} }).success).toBe(false);
  });
});
