import { BUILT_IN_VISUALS, columnFacts, QualifiedName, RunId, type ApprovalPreview, type ResultTable } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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
import { rankedVisuals, type Visual } from './visuals.ts';

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

describe('visual ranking', () => {
  it('ranks product’s way: a chart that covers as much as the table wins on priority, and non-fits are hidden', () => {
    const bars = table({ rows: [['Oslo', 12], ['Lima', 3]] });
    const names = rankedVisuals(OWN_VISUALS, [], bars, columnFacts(bars)).map((v) => v.visual.name);
    expect(names.slice(0, 2)).toEqual(['part', 'category']);
    expect(names).toContain('table');
    expect(names).not.toContain('calendar');
    // value cards are for measures: rows of text, or no number at all, read as a table
    expect(names).not.toContain('value');
    const one = table({ rows: [['Oslo', 12]] });
    expect(rankedVisuals(OWN_VISUALS, [], one, columnFacts(one)).map((v) => v.visual.name)).toContain('value');
  });

  it('never lets a contribution take over a known name, and drops one whose veto refuses or throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const component = defineComponent({ setup: () => () => h('p', 'map') });
    const base = OWN_VISUALS.find((v) => v.name === 'category');
    if (base === undefined) { throw new Error('no category'); }
    const mine: Visual = { ...base, label: 'My bars', system: 'geo', component };
    const vetoed: Visual = { ...base, name: 'waffle', veto: () => 'no' };
    const broken: Visual = { ...base, name: 'broken', veto: () => { throw new Error('no'); } };
    const second: Visual = { ...base, name: 'waffle', label: 'Second waffle', system: 'other' };
    const ranked = rankedVisuals(OWN_VISUALS, [mine, vetoed, broken, second], table(), columnFacts(table()));
    expect(ranked.find((v) => v.visual.name === 'category')?.visual).toBe(base);
    expect(ranked.map((v) => v.visual.name)).not.toContain('waffle');
    expect(ranked.map((v) => v.visual.name)).not.toContain('broken');
  });
});

describe('ResultView', () => {
  // the chart and grid load lazily; the first load (ECharts) is slow under a full run, so it happens once, up front
  beforeAll(async () => { await Promise.all([import('../visuals/ChartVisual.vue'), import('./ResultGrid.vue'), import('../visuals/ValueVisual.vue')]); }, 120_000);

  /** The 3-dot menu's items, by value, once it is opened (the menu is drawn in a popover on the body). */
  async function openMenu(view: { get(selector: string): { trigger(event: string): Promise<void> } }): Promise<Map<string, HTMLButtonElement>> {
    await view.get('[data-testid=widget-more]').trigger('click');
    await flushPromises();
    return new Map([...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].map((item) => [item.dataset['value'] ?? '', item]));
  }

  it('draws the best, switches family and style, and shows the toggle only for a chosen few', async () => {
    const bars = table({ rows: [['Oslo', 12], ['Lima', 3]] });
    const facts = columnFacts(bars);
    const view = mount(ResultView, { attachTo: document.body, props: { table: bars, title: 'Orders', visuals: rankedVisuals(OWN_VISUALS, [], bars, facts), facts, toggle: true } });
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(view.get('[data-testid=result-view]').attributes('data-visual')).toBe('part');
    expect(view.get('[data-testid=result-view]').attributes('data-style')).toBe('pie');
    await view.findAll('[data-testid=result-visuals] [role=radio]')[1]?.trigger('click');
    expect(view.emitted('update:choice')?.[0]).toEqual([{ visual: 'category' }]);
    await view.setProps({ choice: { visual: 'category', style: 'line' } });
    expect(view.get('[data-testid=result-view]').attributes('data-style')).toBe('line');
    // no chosen few (a plain result): no toggle; the visuals are in Settings
    await view.setProps({ toggle: false });
    expect(view.find('[data-testid=result-visuals]').exists()).toBe(false);
    const words = table({ columns: [{ name: 'note', kind: 'text', nullable: false }], rows: [['a'], ['b'], ['c'], ['d'], ['e']] });
    await view.setProps({ toggle: true, table: words, facts: columnFacts(words), visuals: rankedVisuals(OWN_VISUALS, [], words, columnFacts(words)) });
    expect(view.find('[data-testid=result-visuals]').exists()).toBe(false);
    view.unmount();
  });

  it('keeps its tools in a 3-dot menu: image export only for a chart, JSON and CSV for rows, the page\'s items', async () => {
    const bars = table({ rows: [['Oslo', 12], ['Lima', 3]] });
    const facts = columnFacts(bars);
    const items = [{ value: 'make-widget', label: 'Make a widget' }];
    const view = mount(ResultView, { attachTo: document.body, props: { table: bars, title: 'Orders', visuals: rankedVisuals(OWN_VISUALS, [], bars, facts), facts, items } });
    await vi.dynamicImportSettled();
    await flushPromises();
    // a chart draws: its image can be exported
    let menu = await openMenu(view);
    expect([...menu.keys()]).toEqual(['png', 'svg', 'csv', 'json', 'copy', 'make-widget', 'full', 'settings']);
    expect(menu.get('png')?.getAttribute('aria-disabled')).toBeNull();
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    menu.get('json')?.click();
    await flushPromises();
    expect(saved).toEqual(['orders.json']);
    menu = await openMenu(view);
    menu.get('make-widget')?.click();
    expect(view.emitted('item')).toEqual([['make-widget']]);
    // the table draws no image: export image is there but off
    await view.setProps({ choice: { visual: 'table' } });
    await vi.dynamicImportSettled();
    await flushPromises();
    menu = await openMenu(view);
    expect(menu.get('png')?.getAttribute('aria-disabled')).toBe('true');
    expect(menu.has('svg')).toBe(false);
    menu.get('png')?.click();
    menu.get('csv')?.click();
    await flushPromises();
    expect(saved).toEqual(['orders.json', 'orders.csv']);
    click.mockRestore();
    view.unmount();
  });

  it('goes full screen from the menu, and Escape or its close button leaves', async () => {
    const view = mount(ResultView, { attachTo: document.body, props: { table: table(), title: 'Orders', visuals: rankedVisuals(OWN_VISUALS, [], table(), columnFacts(table())), facts: columnFacts(table()) } });
    await flushPromises();
    (await openMenu(view)).get('full')?.click();
    await flushPromises();
    expect(view.get('[data-testid=result-view]').classes()).toContain('full');
    expect(view.get('[data-testid=result-view]').attributes('role')).toBe('dialog');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(view.get('[data-testid=result-view]').classes()).not.toContain('full');
    (await openMenu(view)).get('full')?.click();
    await flushPromises();
    await view.get('[data-testid=result-full-close]').trigger('click');
    expect(view.get('[data-testid=result-view]').classes()).not.toContain('full');
    view.unmount();
  });

  it('changes the look in Settings: every fitting visual, its style, and the page\'s Save', async () => {
    const bars = table({ rows: [['Oslo', 12], ['Lima', 3]] });
    const facts = columnFacts(bars);
    const ranked = rankedVisuals(OWN_VISUALS, [], bars, facts);
    const own = ranked.filter((v) => v.visual.name === 'category' || v.visual.name === 'table');
    const others = ranked.filter((v) => !own.includes(v));
    const view = mount(ResultView, {
      attachTo: document.body, props: { table: bars, title: 'Orders', visuals: own, others, facts, toggle: true },
      slots: { settings: '<button data-testid="page-save">Save</button>' },
    });
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(view.findAll('[data-testid=result-visuals] [role=radio]')).toHaveLength(2);
    (await openMenu(view)).get('settings')?.click();
    await flushPromises();
    const dialog = document.querySelector('[data-testid=result-settings]');
    expect(dialog).not.toBeNull();
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[data-testid=result-settings-visuals] [role=radio]')];
    expect(choices.length).toBe(ranked.length);
    choices.find((b) => b.textContent.includes(OWN_VISUALS.find((v) => v.name === 'part')?.label ?? '?'))?.click();
    expect(view.emitted('update:choice')?.at(-1)).toEqual([{ visual: 'part' }]);
    expect(document.querySelector('[data-testid=page-save]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid=result-settings-done]')?.click();
    await flushPromises();
    expect(document.querySelector('[data-testid=result-settings]')).toBeNull();
    view.unmount();
  });

  it('heads each column with its own label, else its name humanized, the raw name its hover text; cells stay as they are', async () => {
    const named = table({
      columns: [{ name: 'user_id', kind: 'text', nullable: false }, { name: 'dueDate', kind: 'text', nullable: false }, { name: 'city', kind: 'text', nullable: false, label: 'where_to' }],
      rows: [['user_id', '2026-11-14', 'oslo']],
    });
    const grid = mount(ResultGrid, { props: { table: named, title: 'People' } });
    expect(grid.findAll('th .name').map((th) => [th.text(), th.attributes('title')])).toEqual([['User ID', 'user_id'], ['Due date', 'dueDate'], ['where_to', 'city']]);
    expect(grid.findAll('th button').map((b) => b.attributes('title'))).toEqual(['Sort by User ID', 'Sort by Due date', 'Sort by where_to']);
    expect(grid.findAll('tbody td').map((td) => td.text())).toEqual(['user_id', '2026-11-14', 'oslo']);
    // the phone layout labels each field the same way
    const cards = mount(ResultGrid, { props: { table: named, title: 'People', style: 'cards' } });
    expect(cards.findAll('dt').map((dt) => [dt.text(), dt.attributes('title')])).toEqual([['User ID', 'user_id'], ['Due date', 'dueDate'], ['where_to', 'city']]);
    // exports keep the raw column names
    expect(toCsv(named, named.rows).split('\r\n')[0]).toBe('user_id,dueDate,city');
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
    expect(card.emitted('decide')?.[0]).toEqual([true, 'once', '', undefined]);
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
      expect(card.emitted('decide')?.[0]).toEqual([true, 'once', '', undefined]);
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
    const registry = QualifiedName.parse('hub/visuals');
    await Promise.all([host.prepare(registry), host.prepare(registry)]);
    expect(api.contributions.calls).toHaveLength(1);
    const drawn = defineComponent({ props: { table: { type: Object, required: true }, system: { type: Object, required: true } }, setup: () => () => h('i') });
    const client: VisualOption['client'] = { online: true, send: {}, run: {} };
    const shape = BUILT_IN_VISUALS.category.shape;
    const withContributions = new VisualHost({
      api, prepare,
      renderers: { contributedVisuals: () => [
        { system: 'charts', name: 'waffle', label: 'Waffle', icon: 'grid', shape, component: drawn, client },
        { system: 'charts', name: 'dots', label: 'Dots', icon: 'not-an-icon', shape, component: drawn, client },
      ] },
    });
    const shown = withContributions.visuals(registry, table(), columnFacts(table()));
    const waffle = shown.find((v) => v.visual.name === 'waffle');
    expect([waffle?.visual.system, waffle?.visual.label, waffle?.visual.icon, waffle?.visual.props]).toEqual(['charts', 'Waffle', 'grid', { system: client }]);
    expect(shown.find((v) => v.visual.name === 'dots')?.visual.icon).toBe('layers');
    host.choose('m1-0', { visual: 'table' });
    expect(host.choice('m1-0')).toEqual({ visual: 'table' });
    await vi.dynamicImportSettled();
    await flushPromises();
  });
});
