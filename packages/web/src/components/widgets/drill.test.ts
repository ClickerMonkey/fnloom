/**
 * Drill-downs through the query on the web side (build-9 feedback): the step a click on a group takes (the group's key
 * values bound, its crumb, paged; none for a NULL group or a result that can't be drilled; the widget's own drill
 * first), the state's drill step, and the click → modal flow: a grouped row clicked opens the rows behind it in a modal
 * as a widget of its own, a table first, paged by `limit` / `offset`, drilling again as a level with a breadcrumb back;
 * a result that can't be drilled opens nothing.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Json, QualifiedName, type ResultTable } from '@harness/core';
import { CHART_SAMPLES } from '../visuals/test/samples.ts';
import { DRILL_FN, DRILL_PAGE, DRILL_SOURCE, drillableSample, drilledRows } from './test/drill.ts';
import { tableFrame } from './widget-source.ts';
import { WidgetState } from './widget-state.ts';
import WidgetView from './WidgetView.vue';
import { DRILL_PAGING, WIDGET_HOST, drillStepOf, groupCrumbHint, groupDrill, type WidgetHost } from './widgets.ts';

const BY_CITY = drillableSample('category', CHART_SAMPLES.category);
const BY_MONTH_AND_SHOP = drillableSample('crosstab', CHART_SAMPLES.crosstab);

/** A host that answers drills with the sample rows behind a group, and records what it read. */
function drillHost(answer: (fn: string, args: Readonly<Record<string, Json>>) => Json | undefined = (_fn, args) => Json.parse(drilledRows(Json.parse({ ...args })) ?? null)) {
  const reads: { fn: string; args: Readonly<Record<string, Json>> }[] = [];
  const host: WidgetHost = {
    actions: () => Promise.resolve([]),
    read: (fn, args) => { reads.push({ fn, args }); return Promise.resolve(Json.parse(answer(fn, args) ?? null)); },
    quiet: true,
    run: () => Promise.resolve({ ok: true, output: 'done' }),
    exportCsv: () => Promise.resolve(),
  };
  return { host, reads };
}

/** Wait for what the view loads on its own (the table visual and the modal are loaded when first drawn). */
async function shown(selector: string, root: ParentNode = document): Promise<void> {
  await vi.waitFor(async () => { await flushPromises(); expect(root.querySelector(selector)).not.toBeNull(); });
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

describe('a drill through the query', () => {
  it("binds the clicked group's key values to the drill fn, with the source's args, a crumb and its paging", () => {
    expect(groupDrill(BY_CITY, 0)).toEqual({
      fn: DRILL_FN, label: 'City: Oslo', args: { fn: DRILL_SOURCE, args: { family: 'category' }, group: { city: 'Oslo' } }, paging: DRILL_PAGING,
    });
    // its hover text keeps the raw key
    expect(groupCrumbHint(groupDrill(BY_CITY, 0))).toBe('city: Oslo');
    // every key of a two-key group, each by its column's label when it has one (as it is), else its name humanized
    const labelled = { ...BY_MONTH_AND_SHOP, columns: BY_MONTH_AND_SHOP.columns.map((column) => (column.name === 'month' ? { ...column, label: 'month of year' } : column)) };
    expect(groupDrill(labelled, 3)).toMatchObject({ label: 'month of year: Feb · Shop: b', args: { group: { month: 'Feb', shop: 'b' } } });
  });

  it('opens nothing for a NULL group, a row that is not there, or a result that says nothing of drilling', () => {
    const nullGroup: ResultTable = { ...BY_CITY, rows: [[null, 4, 0]] };
    expect(groupDrill(nullGroup, 0)).toBeUndefined();
    expect(groupDrill(BY_CITY, 9)).toBeUndefined();
    expect(groupDrill(CHART_SAMPLES.category, 0)).toBeUndefined();
    // a bare aggregate drills into every row
    expect(groupDrill({ ...CHART_SAMPLES.gauge, drill: { fn: DRILL_FN, args: {}, keys: [] } }, 0)).toMatchObject({ label: 'Every row', args: { group: {} } });
  });

  it("prefers the widget's own drill, bound from the row, over the one through the query", () => {
    const own = { fn: QualifiedName.parse('shop/city_orders'), label: 'Orders', bind: { name: 'city' } };
    expect(drillStepOf(own, BY_CITY, 1)).toEqual({ fn: 'shop/city_orders', label: 'Orders: Lima', args: { name: 'Lima' } });
    expect(drillStepOf(undefined, BY_CITY, 1)?.fn).toBe(DRILL_FN);
  });

  it("is the state's drill step while the level can be asked, and none for rows a write returned", () => {
    const { host } = drillHost();
    const state = new WidgetState(host, { frame: tableFrame(BY_CITY, 'Orders by city'), args: {}, source: undefined, key: 'run_1' });
    expect(state.drills.value).toBe(true);
    expect(state.drillStep(2)?.args).toMatchObject({ group: { city: 'Rome' } });
    const written = new WidgetState(host, { frame: tableFrame({ ...BY_CITY, write: { affected: 1 } }, 'Updated'), args: {}, source: undefined, key: 'run_2' });
    expect(written.drills.value).toBe(false);
    expect(written.drillStep(0)).toBeUndefined();
    expect(new WidgetState(undefined, { frame: tableFrame(BY_CITY, 'Orders by city'), args: {}, source: undefined, key: 'run_3' }).drillStep(0)).toBeUndefined();
  });
});

describe('the drill modal', () => {
  it('opens the rows behind a clicked group as a table, pages them, drills again as a level, and closes', async () => {
    // the rows behind a group carry a drill of their own here, so the modal can drill again
    const { host, reads } = drillHost((fn, args) => {
      if (fn === QualifiedName.parse('shop/by_customer')) { return Json.parse({ ...CHART_SAMPLES.part, rows: [['Ada', 2]] }); }
      const rows = drilledRows(Json.parse({ ...args }));
      return rows === undefined ? null : Json.parse({ ...rows, drill: { fn: 'shop/by_customer', args: {}, keys: ['customer'] } });
    });
    const wrapper = mount(WidgetView, {
      attachTo: document.body, props: { frame: tableFrame(BY_CITY, 'Orders by city'), viewKey: 'run_1', firstVisual: 'table' }, global: { provide: { [WIDGET_HOST]: host } },
    });
    await shown('[data-testid=result-row]');
    expect(wrapper.find('[data-testid=result-grid]').classes()).toContain('drills');
    await wrapper.findAll('[data-testid=result-row]')[0]?.trigger('click');
    await shown('[data-testid=drill-dialog] [data-testid=result-row]');
    expect(reads[0]).toEqual({ fn: DRILL_FN, args: { fn: DRILL_SOURCE, args: { family: 'category' }, group: { city: 'Oslo' } } });
    const dialog = document.querySelector<HTMLElement>('[data-testid=drill-dialog]');
    expect(dialog?.textContent).toContain('City: Oslo');
    expect(dialog?.querySelector('h2')?.getAttribute('title')).toBe('city: Oslo');
    expect(dialog?.textContent).toContain('from Orders by city');
    // a table first, of the first page of the twelve Oslo orders
    const inner = dialog?.querySelector<HTMLElement>('[data-testid=result-view]');
    expect(inner?.dataset['visual']).toBe('table');
    expect(dialog?.querySelectorAll('[data-testid=result-row]').length).toBeGreaterThan(0);
    expect(DRILL_PAGE).toBeGreaterThan(12);
    expect(dialog?.querySelector('[data-testid=result-count]')?.textContent).toContain('12');

    // a row inside drills again as a level, with a breadcrumb back
    dialog?.querySelector<HTMLElement>('[data-testid=result-row]')?.click();
    await flushPromises();
    expect(reads.at(-1)).toEqual({ fn: 'shop/by_customer', args: { group: { customer: 'Ada' } } });
    expect([...(dialog?.querySelectorAll('[data-testid=widget-crumbs] .crumb') ?? [])].map((crumb) => crumb.textContent)).toEqual(['City: Oslo', 'Customer: Ada']);
    expect([...(dialog?.querySelectorAll('[data-testid=widget-crumbs] .crumb') ?? [])].map((crumb) => crumb.getAttribute('title'))).toEqual([null, 'customer: Ada']);
    dialog?.querySelector<HTMLElement>('[data-testid=widget-crumb]')?.click();
    await flushPromises();
    expect(dialog?.querySelector('[data-testid=widget-crumbs]')).toBeNull();

    // closing leaves the widget as it was
    dialog?.querySelector<HTMLButtonElement>('button[aria-label=Close]')?.click();
    await flushPromises();
    expect(document.querySelector('[data-testid=drill-dialog]')).toBeNull();
    expect(wrapper.findAll('[data-testid=result-row]')).toHaveLength(3);
    wrapper.unmount();
  });

  it('reads the next page of the rows behind a group by offset', async () => {
    const { host, reads } = drillHost();
    // Oslo stands for twelve orders: a page of five, then the rest
    const small = (args: Readonly<Record<string, Json>>): Json => Json.parse(drilledRows(Json.parse({ ...args, limit: 5 })) ?? null);
    const paged: WidgetHost = { ...host, read: (fn, args) => { reads.push({ fn, args }); return Promise.resolve(small(args)); } };
    const wrapper = mount(WidgetView, { attachTo: document.body, props: { frame: tableFrame(BY_CITY, 'Orders by city'), viewKey: 'run_1', firstVisual: 'table' }, global: { provide: { [WIDGET_HOST]: paged } } });
    await shown('[data-testid=result-row]');
    await wrapper.findAll('[data-testid=result-row]')[0]?.trigger('click');
    await shown('[data-testid=drill-dialog] [data-testid=result-row]');
    const dialog = document.querySelector<HTMLElement>('[data-testid=drill-dialog]');
    expect(dialog?.querySelector('[data-testid=result-count]')?.textContent).toContain('12');
    expect(dialog?.querySelectorAll('[data-testid=result-row]')).toHaveLength(5);
    dialog?.querySelector<HTMLButtonElement>('[data-testid=result-next]')?.click();
    await vi.waitFor(async () => { await flushPromises(); expect(dialog?.querySelectorAll('[data-testid=result-row]').length).toBeGreaterThan(5); });
    expect(reads.at(-1)).toEqual({ fn: DRILL_FN, args: { fn: DRILL_SOURCE, args: { family: 'category' }, group: { city: 'Oslo' }, offset: 5 } });
    wrapper.unmount();
  });

  it('opens nothing for a result its query could not drill into', async () => {
    const { host, reads } = drillHost();
    const wrapper = mount(WidgetView, { attachTo: document.body, props: { frame: tableFrame(CHART_SAMPLES.category, 'Orders by city'), viewKey: 'run_1', firstVisual: 'table' }, global: { provide: { [WIDGET_HOST]: host } } });
    await shown('[data-testid=result-row]');
    expect(wrapper.find('[data-testid=result-grid]').classes()).not.toContain('drills');
    await wrapper.findAll('[data-testid=result-row]')[0]?.trigger('click');
    await flushPromises();
    expect(reads).toEqual([]);
    expect(document.querySelector('[data-testid=drill-dialog]')).toBeNull();
    wrapper.unmount();
  });
});
