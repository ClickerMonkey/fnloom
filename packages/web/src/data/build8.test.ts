/**
 * Build 8, web: widgets (which visuals they offer and with which columns, row actions with their confirm and form, the
 * controls and refresh as new runs, Save as widget on a plain table), the Data pages (stored types, a type's records
 * with search, filters, sort and paging in the URL, a record opened with its history, saved, removed), version history
 * for any item, and one New chat on the chat's empty page.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { Json, QualifiedName, RunId, SystemName } from '@harness/core';
import { createAppRouter } from '../app/router.ts';
import App from '../app/App.vue';
import { STORES } from '../state/stores.ts';
import { fakeStores } from '../test/fakes.ts';
import WidgetView from '../components/widgets/WidgetView.vue';
import TableResult from '../components/widgets/TableResult.vue';
import ItemHistory from '../components/versions/ItemHistory.vue';
import { ITEM_VERSIONS } from '../components/versions/versions.ts';
import { WidgetState } from '../components/widgets/widget-state.ts';
import { actionArgs, boundArgs, boundTable, choiceValue, controlValueText, offeredVisuals, rowActions, rowTypes, saveWidgetRequest, shownControls, WIDGET_HOST, widgetResultOf, type WidgetHost } from '../components/widgets/widgets.ts';
import { OWN_HOST } from '../components/results/builtin.ts';
import { filterLabel, filtersOf, filtersParam, recordIdOf, recordTableQuery, sortOf, sortParam, storageWords } from './logic/data.ts';
import { NOTE_TYPE, NOTES_WIDGET, SAMPLE_ACTIONS, SAMPLE_PAGED_WIDGET, SAMPLE_TABLE, SAMPLE_WIDGET, sampleItemVersions } from './test/samples.ts';
import { collapsedByDefault } from '../chat/state/collapse.ts';
import { groupPieces } from '../chat/logic/groups.ts';

const NOTES = SystemName.parse('notes');

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

/** A widget host that records what it was asked to run. */
function fakeHost(overrides: Partial<WidgetHost> = {}): WidgetHost & { readonly runs: { fn: string; args: Json }[] } {
  const runs: { fn: string; args: Json }[] = [];
  return {
    runs,
    actions: () => Promise.resolve(SAMPLE_ACTIONS),
    run: (fn, args) => { runs.push({ fn, args }); return Promise.resolve(true); },
    argsType: () => ({ name: 'obj', props: { status: { type: { name: 'text' } } } }),
    ...overrides,
  };
}

describe('rows in the chat', () => {
  it('keeps a finished run that returned rows open and out of a group', () => {
    const id = RunId.parse('run_rows');
    expect(collapsedByDefault({ id, status: 'done', outcome: { status: 'done', result: Json.parse(SAMPLE_WIDGET) } })).toBe(false);
    expect(collapsedByDefault({ id, status: 'done', outcome: { status: 'done', result: 'ok' } })).toBe(true);
    const pieces = [{ kind: 'runs' as const, key: 'a', runs: [id] }, { kind: 'runs' as const, key: 'b', runs: [RunId.parse('run_b')] }];
    expect(groupPieces(pieces, true, () => 1).map((p) => p.kind)).toEqual(['group']);
    expect(groupPieces(pieces, true, () => 1, (piece) => piece.key === 'a').map((p) => p.kind)).toEqual(['runs', 'runs']);
  });
});

describe('widget logic', () => {
  it('tells a widget result and a result table from other results', () => {
    expect(widgetResultOf(Json.parse(SAMPLE_WIDGET))?.title).toBe('Open notes');
    expect(widgetResultOf(Json.parse(SAMPLE_TABLE))).toBeUndefined();
    expect(widgetResultOf('text')).toBeUndefined();
  });

  it('offers the widget\'s visuals in its order with its labels, the table last', () => {
    const offered = offeredVisuals((table) => OWN_HOST.visuals(QualifiedName.parse('hub/visuals'), table), SAMPLE_TABLE, SAMPLE_WIDGET.visuals);
    expect(offered.map((v) => v.visual.name)).toEqual(['bar', 'table']);
    expect(offered[0]?.visual.label).toBe('Words per note');
  });

  it('draws only the bound columns, in channel order, and maps a drawn row back to its whole row', () => {
    const bound = boundTable(SAMPLE_TABLE, SAMPLE_WIDGET.visuals[0]);
    expect(bound.table.columns.map((c) => c.name)).toEqual(['title', 'words']);
    const first = bound.table.rows[0] ?? [];
    expect(bound.original(first)).toBe(SAMPLE_TABLE.rows[0]);
    expect(boundTable(SAMPLE_TABLE, { visual: 'bar', bind: { label: ['gone'] } }).table).toBe(SAMPLE_TABLE);
  });

  it('finds row types and binds an action\'s args from the row, leaving out rows missing a bound value', () => {
    expect(rowTypes(SAMPLE_TABLE)).toEqual([NOTE_TYPE]);
    const [archive] = SAMPLE_ACTIONS;
    const row = SAMPLE_TABLE.rows[0] ?? [];
    expect(archive && boundArgs(archive, SAMPLE_TABLE, row)).toEqual({ self: 'rec_note_1' });
    expect(rowActions(SAMPLE_ACTIONS, SAMPLE_TABLE, ['a', 'b', 'open', 1, null])).toEqual([]);
    expect(actionArgs({ self: 'rec_note_1' }, { title: 'New', self: 'other' })).toEqual({ title: 'New', self: 'rec_note_1' });
    expect(saveWidgetRequest(QualifiedName.parse('hub/records_table'), { type: NOTE_TYPE })).toContain('hub/make_widget');
  });
});

describe('a widget\'s state', () => {
  it('asks for row actions once per type set, runs a confirmed action and refreshes after it', async () => {
    const host = fakeHost();
    const asked = vi.spyOn(host, 'actions');
    const state = new WidgetState(host, () => ({ fn: NOTES_WIDGET, args: { status: 'open' } }));
    await state.load(SAMPLE_TABLE);
    await state.load(SAMPLE_TABLE);
    expect(asked).toHaveBeenCalledTimes(1);
    state.openRow(SAMPLE_TABLE, SAMPLE_TABLE.rows[0] ?? []);
    expect(state.offered.value).toHaveLength(2);
    const archive = SAMPLE_ACTIONS[0];
    if (archive === undefined) { throw new Error('no sample action'); }
    state.choose(archive);
    expect(state.step.value).toBe('confirm');
    expect(state.runsAtOnce).toBe(false);
    expect(await state.run(SAMPLE_TABLE)).toBe(true);
    expect(host.runs).toEqual([{ fn: 'notes/Note.archive', args: { self: 'rec_note_1' } }, { fn: NOTES_WIDGET, args: { status: 'open' } }]);
    expect(state.open.value).toBe(false);
  });

  it('pages by running the widget with its offset arg, keeping its other args', async () => {
    const host = fakeHost();
    const state = new WidgetState(host, () => ({ fn: NOTES_WIDGET, args: { status: 'open', offset: 25 } }));
    expect(await state.page({ arg: 'offset', size: 25 }, 50)).toBe(true);
    expect(await state.page({ arg: 'offset', size: 25 }, -25)).toBe(true);
    expect(host.runs).toEqual([{ fn: NOTES_WIDGET, args: { status: 'open', offset: 50 } }, { fn: NOTES_WIDGET, args: { status: 'open', offset: 0 } }]);
  });

  it('says why an action failed and keeps it open', async () => {
    const state = new WidgetState(fakeHost({ run: () => Promise.resolve(false) }), () => ({ fn: NOTES_WIDGET, args: {} }));
    await state.load(SAMPLE_TABLE);
    state.openRow(SAMPLE_TABLE, SAMPLE_TABLE.rows[0] ?? []);
    const rename = SAMPLE_ACTIONS[1];
    if (rename === undefined) { throw new Error('no sample action'); }
    state.choose(rename);
    expect(state.step.value).toBe('form');
    expect(await state.run(SAMPLE_TABLE, { title: 'x' })).toBe(false);
    expect(state.running.problem.value).toContain('rename');
    expect(state.open.value).toBe(true);
  });
});

describe('the widget view', () => {
  it('draws the widget\'s first visual, switches to the table, and opens a row\'s actions with a confirm', async () => {
    const host = fakeHost();
    const wrapper = mount(WidgetView, { attachTo: document.body, props: { result: SAMPLE_WIDGET, fn: NOTES_WIDGET, args: {} }, global: { provide: { [WIDGET_HOST]: host } } });
    await flushPromises();
    expect(wrapper.get('[data-testid=result-view]').attributes('data-visual')).toBe('bar');
    expect(wrapper.text()).toContain('Open notes');
    const table = wrapper.findAll('[data-testid=result-visuals] button').find((b) => b.attributes('aria-label') === 'Table' || b.text() === 'Table');
    await table?.trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid=result-view]').attributes('data-visual')).toBe('table');
    await vi.dynamicImportSettled();
    await flushPromises();
    await wrapper.findAll('[data-testid=result-row-open]')[0]?.trigger('click');

    await flushPromises();
    const choices = [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid=widget-action-choice]')];
    expect(choices.map((c) => c.dataset['fn'])).toEqual(['notes/Note.archive', 'notes/Note.rename']);
    choices[0]?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid=widget-action-confirm]')?.textContent).toContain('Archive this row?');
    document.body.querySelector<HTMLButtonElement>('[data-testid=widget-action-run]')?.click();
    await flushPromises();
    expect(host.runs[0]).toEqual({ fn: 'notes/Note.archive', args: { self: 'rec_note_1' } });
    wrapper.unmount();
  });

  it('applies its controls and refreshes as new runs, and lists problems', async () => {
    const host = fakeHost();
    const wrapper = mount(WidgetView, { attachTo: document.body, props: { result: { ...SAMPLE_WIDGET, problems: ['The bar chart\'s value column is gone.'] }, fn: NOTES_WIDGET, args: { status: 'open' } }, global: { provide: { [WIDGET_HOST]: host } } });
    await flushPromises();
    expect(wrapper.get('[data-testid=widget-problems]').text()).toContain('value column is gone');
    await wrapper.get('[data-testid=widget-refresh]').trigger('click');
    await wrapper.get('[data-testid=widget-controls-toggle]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid=widget-controls] form').trigger('submit');
    await flushPromises();
    expect(host.runs).toEqual([{ fn: NOTES_WIDGET, args: { status: 'open' } }, { fn: NOTES_WIDGET, args: { status: 'open' } }]);
    wrapper.unmount();
  });

  it('shows each control with what it is set to, runs again on a choice from the first page, and pages', async () => {
    const controls = shownControls(SAMPLE_PAGED_WIDGET.controls ?? [], { status: 'done', offset: 3 });
    expect(controls.map((c) => `${c.label}=${c.value}`)).toEqual(['Status=done', 'Owner=Any']);
    expect(controls[0]?.picked).toBe('1');
    expect(controls[1]?.choices).toBeUndefined();
    expect(choiceValue({ choices: ['open', 'done'] }, '0')).toBe('open');
    expect(choiceValue({ choices: ['open', 'done'] }, '')).toBeUndefined();
    expect(controlValueText([true, 2])).toBe('Yes, 2');

    const host = fakeHost();
    const args = { status: 'open', owner: 'Sam', offset: 3 };
    const wrapper = mount(WidgetView, { attachTo: document.body, props: { result: SAMPLE_PAGED_WIDGET, fn: NOTES_WIDGET, args }, global: { provide: { [WIDGET_HOST]: host } } });
    await flushPromises();
    const row = wrapper.get('[data-testid=widget-control-row]');
    expect(row.text()).toContain('Owner:Sam');
    expect(wrapper.find('[data-testid=widget-controls-toggle]').exists()).toBe(false);
    expect(wrapper.get('[data-testid=widget-page]').text()).toBe('4–6');
    await row.get('select').setValue('1');
    await flushPromises();
    await wrapper.get('[data-testid=widget-page-next]').trigger('click');
    await flushPromises();
    await wrapper.get('button[data-arg=owner]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid=widget-controls] form').exists()).toBe(true);
    expect(host.runs).toEqual([{ fn: NOTES_WIDGET, args: { owner: 'Sam', status: 'done' } }, { fn: NOTES_WIDGET, args: { ...args, offset: 6 } }]);
    wrapper.unmount();
  });

  it('draws read-only without a host', async () => {
    const wrapper = mount(WidgetView, { props: { result: SAMPLE_WIDGET } });
    await flushPromises();
    expect(wrapper.find('[data-testid=widget-refresh]').exists()).toBe(false);
    expect(wrapper.find('[data-testid=result-row-open]').exists()).toBe(false);
  });

  it('offers Save as widget on a plain result table and asks the host', async () => {
    const asked: unknown[] = [];
    const host = fakeHost({ saveAsWidget: (fn, args) => { asked.push({ fn, args }); return Promise.resolve(true); } });
    const wrapper = mount(TableResult, { props: { value: Json.parse(SAMPLE_TABLE), fn: QualifiedName.parse('hub/records_table'), args: { type: NOTE_TYPE }, title: 'Records' }, global: { provide: { [WIDGET_HOST]: host } } });
    await flushPromises();
    await wrapper.get('[data-testid=save-as-widget]').trigger('click');
    expect(asked).toEqual([{ fn: 'hub/records_table', args: { type: NOTE_TYPE } }]);
  });
});

describe('the Data pages\' logic', () => {
  it('reads and writes sort and filters in the URL, and asks the hub with them', () => {
    expect(sortOf('-title')).toEqual({ field: 'title', dir: 'desc' });
    expect(sortParam({ field: 'words', dir: 'asc' })).toBe('words');
    const filters = [{ field: 'status', op: 'is' as const, value: 'open' }];
    expect(filtersOf(filtersParam(filters))).toEqual(filters);
    expect(filtersOf('not json')).toEqual([]);
    expect(filterLabel({ field: 'words', op: 'gt', value: 3 })).toBe('words > 3');
    expect(recordTableQuery(NOTE_TYPE, { q: ' plan ', sort: '-words', where: filtersParam(filters), at: '50' })).toEqual({
      type: NOTE_TYPE, search: 'plan', query: { filters, sort: [{ field: 'words', dir: 'desc' }] }, offset: 50, limit: 50,
    });
    expect(recordIdOf(SAMPLE_TABLE, SAMPLE_TABLE.rows[1] ?? [])).toBe('rec_note_2');
    expect(storageWords({ shape: 'table', owner: 'person', search: { text: ['title', 'body'], embed: true } })).toBe("Many records · each person's own · searched by title, body and meaning");
  });
});

/** Mount the app, signed in, at a path. */
async function visit(path: string) {
  const fakes = fakeStores({ signedIn: true });
  const router = createAppRouter(fakes.stores.session, createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
  await flushPromises();
  return { ...fakes, router, app };
}

describe('the Data pages', () => {
  it('lists stored types by system and opens one', async () => {
    const { app } = await visit('/data');
    const sets = app.findAll('[data-testid=data-set]');
    expect(sets.map((s) => s.attributes('data-type'))).toEqual(['notes/Note', 'notes/Settings', 'tasks/Task']);
    expect(app.text()).toContain('3 records');
    expect(sets[0]?.attributes('href')).toBe('/data/notes/Note');
    app.unmount();
  });

  it('lists saved widgets at /data/widgets', async () => {
    const { app, fns } = await visit('/data/widgets?q=notes');
    expect(fns.searchFns.calls.at(-1)?.[0]).toMatchObject({ kinds: ['hub/widget'], text: 'notes' });
    expect(app.findAll('[data-testid=data-widget]').length).toBeGreaterThan(0);
    app.unmount();
  });

  it('shows a type\'s records from its URL, opens one with its history, and saves it with its version', async () => {
    const { app, data, router } = await visit('/data/notes/Note?q=trip&sort=-words');
    expect(data.recordTable.calls.at(-1)?.[0]).toMatchObject({ type: NOTE_TYPE, search: 'trip', query: { sort: [{ field: 'words', dir: 'desc' }] } });
    expect(app.findAll('[data-testid=result-grid] tbody tr')).toHaveLength(3);
    await app.findAll('[data-testid=result-row-open]')[0]?.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.params['id']).toBe('rec_note_1');
    expect(router.currentRoute.value.query['q']).toBe('trip');
    const panel = document.body.querySelector('[data-testid=record-panel]');
    expect(panel?.getAttribute('data-record')).toBe('rec_note_1');
    expect(document.body.querySelectorAll('[data-testid=record-version]')).toHaveLength(1);
    document.body.querySelector<HTMLButtonElement>('[data-testid=record-edit]')?.click();
    await flushPromises();
    document.body.querySelector<HTMLFormElement>('[data-testid=record-panel] form')?.dispatchEvent(new Event('submit'));
    await flushPromises();
    expect(data.saveRecord.calls.at(-1)?.[0]).toMatchObject({ type: NOTE_TYPE, id: 'rec_note_1', expect: 1 });
    app.unmount();
  });

});

describe('item history', () => {
  it('loads an item\'s versions when opened and shows one version\'s declaration', async () => {
    const asked: unknown[] = [];
    const source = (query: { system: string; section: string; name: string }) => { asked.push(query); return Promise.resolve({ items: sampleItemVersions(query.system, query.section, query.name) }); };
    const wrapper = mount(ItemHistory, { props: { item: { system: NOTES, section: 'kinds', name: 'notes/memo' } }, global: { provide: { [ITEM_VERSIONS]: source } } });
    expect(asked).toHaveLength(0);
    await wrapper.get('[data-testid=item-history-toggle]').trigger('click');
    await flushPromises();
    expect(asked).toEqual([{ system: 'notes', section: 'kinds', name: 'notes/memo', limit: 20 }]);
    const versions = wrapper.findAll('[data-testid=item-version]');
    expect(versions.map((v) => v.text())).toEqual([expect.stringContaining('#3'), expect.stringContaining('#2'), expect.stringContaining('#1')]);
    expect(versions[0]?.text()).toContain('Added while running');
    await versions[0]?.trigger('click');
    expect(wrapper.text()).toContain('"version": 3');
  });

  it('draws nothing where no history is provided', () => {
    expect(mount(ItemHistory, { props: { item: { system: NOTES, section: 'fns', name: 'notes/find' } } }).html()).toBe('<!--v-if-->');
  });
});
