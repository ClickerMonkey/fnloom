import { QualifiedName, RunId, type ApprovalPreview, type ResultTable } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { ApprovalDesk } from '../../chat/state/approvals.ts';
import { VisualHost } from '../../chat/state/visuals.ts';
import { fakeChatApi } from '../../chat/test/fakes.ts';
import { failingCaller } from '../../test/fakes.ts';
import type { VisualOption } from '@harness/sdk/client';
import ApprovalCard from '../approvals/ApprovalCard.vue';
import { OWN_VISUALS } from './builtin.ts';
import ResultGrid from './ResultGrid.vue';
import ResultView from './ResultView.vue';
import { cellText, gridWindow, nextSort, sortRows, toCsv, windowLabel } from './table.ts';
import { barFit, fittingVisuals, valueFit, type Visual } from './visuals.ts';

function table(overrides: Partial<ResultTable> = {}): ResultTable {
  return {
    columns: [{ name: 'city', kind: 'text', nullable: false }, { name: 'orders', kind: 'integer', nullable: true }],
    rows: [['Oslo', 12], ['Lima', 3], ['Rome', null]],
    offset: 0, truncated: false, sort: [], ...overrides,
  };
}

describe('result table logic', () => {
  it('formats cells by kind, sorts with empty cells last, and writes CSV', () => {
    expect(cellText(1234.5, { kind: 'number' })).toBe((1234.5).toLocaleString(undefined, { maximumFractionDigits: 6 }));
    expect(cellText(true, { kind: 'boolean' })).toBe('Yes');
    expect(cellText({ a: 1 }, { kind: 'json' })).toBe('{"a":1}');
    expect(cellText(null, { kind: 'text' })).toBeUndefined();
    expect(sortRows(table(), { column: 'orders', dir: 'desc' }).map((r) => r[0])).toEqual(['Oslo', 'Lima', 'Rome']);
    expect(sortRows(table(), { column: 'orders', dir: 'asc' }).map((r) => r[0])).toEqual(['Lima', 'Oslo', 'Rome']);
    expect(nextSort(undefined, 'a')).toEqual({ column: 'a', dir: 'asc' });
    expect(nextSort({ column: 'a', dir: 'desc' }, 'a')).toBeUndefined();
    expect(toCsv(table(), [['Say "hi", ok', 1], ['x', null]])).toBe('city,orders\r\n"Say ""hi"", ok",1\r\nx,\r\n');
  });

  it('pages within the rows held, then says what to ask the fn for', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`r${i}`, i]);
    const slice = table({ rows, offset: 30, limit: 30, truncated: true });
    const first = gridWindow(slice, rows, 0, 25);
    expect([first.from, first.to, first.canNext, first.fetchPrev?.offset]).toEqual([31, 55, true, 0]);
    const last = gridWindow(slice, rows, 1, 25);
    expect(last.fetchNext).toEqual({ offset: 60, limit: 30, sort: [] });
    expect(windowLabel(last, true)).toBe('56–60 of 60+');
  });
});

describe('visual matching', () => {
  it('fits a bar chart to a label and a number, a value to one cell, the table always and last', () => {
    expect(barFit(table({ rows: [['Oslo', 12], ['Lima', 3]] }))).toEqual({ fits: true, score: 0.8 });
    expect(barFit(table()).fits).toBe(false);
    expect(valueFit(table({ columns: [{ name: 'n', kind: 'integer', nullable: false }], rows: [[4]] })).score).toBe(0.9);
    const names = fittingVisuals(OWN_VISUALS, [], table({ rows: [['Oslo', 12], ['Lima', 3]] })).map((f) => f.visual.name);
    expect(names).toEqual(['bar', 'table']);
  });

  it('lets a contribution replace the app’s own and drops one whose match throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const component = defineComponent({ setup: () => () => h('p', 'map') });
    const map: Visual = { name: 'map', label: 'Map', icon: 'globe', system: 'geo', match: () => ({ fits: true, score: 0.95 }), component };
    const broken: Visual = { ...map, name: 'broken', match: () => { throw new Error('no'); } };
    expect(fittingVisuals(OWN_VISUALS, [map, broken], table()).map((f) => f.visual.name)).toEqual(['map', 'table']);
  });
});

describe('ResultView', () => {
  it('shows the best fit, switches visuals, and hides the switch when only the table fits', async () => {
    const bars = table({ rows: [['Oslo', 12], ['Lima', 3]] });
    const view = mount(ResultView, { props: { table: bars, title: 'Orders', visuals: fittingVisuals(OWN_VISUALS, [], bars) } });
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(view.get('[data-testid=result-view]').attributes('data-visual')).toBe('bar');
    expect(view.text()).toContain('orders by city');
    await view.findAll('[data-testid=result-visuals] [role=radio]')[1]?.trigger('click');
    expect(view.emitted('update:choice')?.[0]).toEqual(['table']);
    await view.setProps({ choice: 'table' });
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(view.find('[data-testid=result-grid]').exists()).toBe(true);
    await view.setProps({ table: table(), visuals: fittingVisuals(OWN_VISUALS, [], table()) });
    expect(view.find('[data-testid=result-visuals]').exists()).toBe(false);
  });

  it('sorts held rows itself, and asks the fn when the rows are a slice', async () => {
    const grid = mount(ResultGrid, { props: { table: table(), title: 'Orders' } });
    await grid.findAll('th button')[1]?.trigger('click');
    expect(grid.findAll('tbody tr').map((r) => r.find('td').text())).toEqual(['Lima', 'Oslo', 'Rome']);
    const pager = vi.fn();
    await grid.setProps({ table: table({ truncated: true, limit: 3 }), pager });
    await grid.findAll('th button')[0]?.trigger('click');
    expect(pager).toHaveBeenLastCalledWith({ offset: 0, limit: 3, sort: [{ column: 'city', dir: 'asc' }] });
    await grid.get('[data-testid=result-next]').trigger('click');
    expect(pager).toHaveBeenLastCalledWith({ offset: 3, limit: 3, sort: [] });
  });
});

describe('approval cards', () => {
  const preview: ApprovalPreview = {
    title: 'Delete 2 rows from orders', irreversible: true,
    parts: [
      { type: 'code', language: 'sql', code: 'DELETE FROM orders WHERE id IN (1, 2)' },
      { type: 'table', title: 'Rows it deletes', table: table() },
      { type: 'type-diff', name: 'shop.Orders', before: { name: 'text' }, after: { name: 'num' }, changes: ['city: text → number'], breaks: [{ fn: 'shop.by_city', why: 'groups by city as text' }] },
    ],
  };

  it('shows what the run will do and answers for this run only when it may not be remembered', async () => {
    const card = mount(ApprovalCard, { props: { fn: QualifiedName.parse('database/delete'), description: '', args: undefined, preview, rememberable: false } });
    expect(card.text()).toContain('Delete 2 rows from orders');
    expect(card.text()).toContain("can't be undone");
    expect(card.find('[data-testid=result-grid]').exists()).toBe(true);
    expect(card.get('[data-testid=type-diff-breaks]').text()).toContain('shop.by_city');
    expect(card.find('[role=radiogroup]').exists()).toBe(false);
    await card.get('[data-testid=approve]').trigger('click');
    expect(card.emitted('decide')?.[0]).toEqual([true, 'once', '']);
  });

  it('in the chat’s tray, cuts a body too tall for the room and asks for Review before Approve, never scrolling inside', async () => {
    const box = (el: HTMLElement): boolean => el.dataset['testid'] === 'approval-body';
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return box(this) ? 900 : 0; });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return box(this) ? 120 : 0; });
    try {
      const card = mount(ApprovalCard, { props: { fn: QualifiedName.parse('database/delete'), description: '', args: undefined, preview, rememberable: false, bounded: true }, attachTo: document.body });
      await flushPromises();
      expect(card.get('[data-testid=approval-body]').classes()).toContain('clipped');
      expect(card.find('[data-testid=approve]').exists()).toBe(false);
      await card.get('[data-testid=review]').trigger('click');
      await flushPromises();
      const dialog = document.body.querySelector('[data-testid=approval-review]');
      expect(dialog?.textContent).toContain('shop.by_city');
      document.body.querySelector<HTMLButtonElement>('[role=dialog] [data-testid=approve]')?.click();
      expect(card.emitted('decide')?.[0]).toEqual([true, 'once', '']);
      card.unmount();
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it('keeps the inbox’s approvals by run and puts one back when the hub refuses', async () => {
    const desk = new ApprovalDesk({ ...fakeChatApi(), approve: failingCaller<'approve'>(new Error('gone')) });
    const run = RunId.parse('run_1');
    await desk.load([run, run]);
    const found = desk.byRun.value.get(run);
    expect(found?.status).toBe('pending');
    expect(found && await desk.decide(found, true, '')).toBe(false);
    expect(desk.byRun.value.has(run)).toBe(true);
  });

  it('asks a registry’s contributions once, labels each visual from its contract and keeps a choice per view', async () => {
    const api = fakeChatApi();
    const prepare = vi.fn(() => Promise.resolve());
    const host = new VisualHost({ api, renderers: { contributedVisuals: () => [] }, prepare });
    const registry = QualifiedName.parse('database/query-visuals');
    await Promise.all([host.prepare(registry), host.prepare(registry)]);
    expect(api.contributions.calls).toHaveLength(1);
    const drawn = defineComponent({ props: { table: { type: Object, required: true }, system: { type: Object, required: true } }, setup: () => () => h('i') });
    const client: VisualOption['props']['system'] = { online: true, send: {}, run: {} };
    const withContributions = new VisualHost({
      api, prepare,
      renderers: { contributedVisuals: () => [
        { system: 'database', name: 'bar', label: 'Bars', icon: 'chart', fit: { fits: true, score: 0.7 }, component: drawn, props: { table: table(), system: client } },
        { system: 'charts', name: 'pie', label: 'Pie chart', icon: 'not-an-icon', fit: { fits: true, score: 0.6 }, component: drawn, props: { table: table(), system: client } },
      ] },
    });
    const shown = withContributions.visuals(registry, table());
    expect(shown.map((v) => [v.visual.name, v.visual.system, v.visual.label, v.visual.icon])).toEqual([['bar', 'database', 'Bars', 'chart'], ['pie', 'charts', 'Pie chart', 'layers'], ['table', undefined, 'Table', 'table']]);
    expect(shown[0]?.visual.props).toEqual({ table: table(), system: client });
    host.choose('m1-0', 'table');
    expect(host.choice('m1-0')).toBe('table');
    await vi.dynamicImportSettled();
    await flushPromises();
  });
});
