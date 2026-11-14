/**
 * The widget pass's widget view: the logic (chip args with relative dates, the widget's own visuals, drill levels in
 * the URL, the export query), the state (buffered pager, drill levels, form then confirm, derived then, live re-runs),
 * and the components (chip row with presets and Apply, read-only rows, the proposal card with Save).
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { columnFacts, Json, QualifiedName, ResultTable, WidgetResult, type RowActionsQuery, type WidgetActionOption } from '@harness/core';
import { NOTE_TYPE, NOTE_WORDS, NOTES_WIDGET, SAMPLE_ACTIONS, SAMPLE_PAGED_WIDGET, SAMPLE_PROPOSAL, SAMPLE_TABLE, SAMPLE_WIDGET, SAMPLE_WORDS } from '../../data/test/samples.ts';
import { OWN_VISUALS } from '../results/builtin.ts';
import { rankedVisuals } from '../results/visuals.ts';
import TableResult from './TableResult.vue';
import { FnWidgetSource, resultFrame, tableFrame } from './widget-source.ts';
import { WidgetState, type WidgetClock } from './widget-state.ts';
import WidgetView from './WidgetView.vue';
import { editInput, enteredValue } from './record-edits.ts';
import { chipArgs, exportQuery, readLevels, rowTypes, SAVE_WIDGET_FN, saveLookRequest, WIDGET_HOST, widgetVisuals, type RunOutcome, type WidgetHost } from './widgets.ts';

const CLOCK: WidgetClock = { now: () => new Date('2026-11-13T10:00:00Z'), zone: () => 'UTC' };

/** A window of two notes from `offset`, as the paged widget returns it. */
function windowAt(offset: number): Json {
  const rows = SAMPLE_TABLE.rows.slice(offset, offset + 2);
  return Json.parse({ ...SAMPLE_PAGED_WIDGET, table: { ...SAMPLE_TABLE, rows, offset, truncated: rows.length === 2 }, paging: { ...SAMPLE_PAGED_WIDGET.paging, more: rows.length === 2 } });
}

/** A widget host that answers reads like the paged widget and the drill, and records what it was asked. */
function fakeHost(overrides: Partial<WidgetHost> = {}) {
  const reads: { fn: string; args: Readonly<Record<string, Json>> }[] = [];
  const runs: { fn: string; args: Json }[] = [];
  let level = '';
  const host: WidgetHost = {
    actions: (_query: RowActionsQuery) => Promise.resolve(SAMPLE_ACTIONS),
    read: (fn, args) => {
      reads.push({ fn, args });
      if (fn === NOTE_WORDS) { return Promise.resolve(Json.parse(SAMPLE_WORDS)); }
      const offset = args['offset'];
      return Promise.resolve(windowAt(typeof offset === 'number' ? offset : 0));
    },
    quiet: true,
    run: (fn, args): Promise<RunOutcome> => { runs.push({ fn, args }); return Promise.resolve({ ok: true, output: 'done' }); },
    exportCsv: () => Promise.resolve(),
    levels: { get: () => level, set: (text) => { level = text; } },
    ...overrides,
  };
  return { host, reads, runs, level: () => level };
}

/** The values of a widget's 3-dot menu items, once it is opened (the menu is drawn in a popover on the body). */
async function menuOf(wrapper: { get(selector: string): { trigger(event: string): Promise<void> } }): Promise<Map<string, HTMLButtonElement>> {
  await wrapper.get('[data-testid=widget-more]').trigger('click');
  await flushPromises();
  return new Map([...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].map((item) => [item.dataset['value'] ?? '', item]));
}

function pagedState(host: WidgetHost): WidgetState {
  return new WidgetState(host, { frame: resultFrame(SAMPLE_PAGED_WIDGET), args: { status: 'open' }, source: new FnWidgetSource(host, NOTES_WIDGET, 'Notes'), key: 'run_1' }, CLOCK);
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

describe('widget logic', () => {
  it('runs chips with staged values, resolving relative dates, leaving out "Any" and a default kept relative', () => {
    const controls = SAMPLE_PAGED_WIDGET.controls;
    expect(chipArgs(controls, {}, CLOCK.now(), 'UTC')).toEqual({ status: 'open' });
    expect(chipArgs(controls, { status: null, since: { relative: 'startOf(month)' }, owner: { literal: 'Sam' } }, CLOCK.now(), 'UTC')).toEqual({ since: '2026-11-01', owner: 'Sam' });
    // a chip the widget fills from its default sends "Any" as null, so the default doesn't come back
    const defaulted = controls.map((control) => (control.arg === 'status' ? { ...control, defaulted: true } : control));
    expect(chipArgs(defaulted, { status: null }, CLOCK.now(), 'UTC')).toEqual({ status: null });
  });

  it("offers a widget's own visuals in its order with its labels and bindings, else every fitting one", () => {
    const ranked = rankedVisuals(OWN_VISUALS, [], SAMPLE_TABLE, columnFacts(SAMPLE_TABLE));
    const own = widgetVisuals(ranked, SAMPLE_WIDGET.visuals);
    expect(own.map((v) => [v.visual.name, v.visual.label, v.rank.styles[0]])).toEqual([['category', 'Words per note', 'bar'], ['table', 'Table', 'table']]);
    expect(own[0]?.rank.bind['x']).toEqual(['title']);
    expect(widgetVisuals(ranked, [{ visual: 'gone', style: 'x', bind: {} }])).toHaveLength(ranked.length);
  });

  it('reads drill levels back, builds the export query and finds row types', () => {
    expect(readLevels('{"of":"run_1","steps":[{"fn":"notes/note_words","label":"Words","args":{"note":"rec_note_1"}}]}')?.steps[0]?.fn).toBe(NOTE_WORDS);
    expect(readLevels('not json')).toBeUndefined();
    expect(exportQuery(SAMPLE_PAGED_WIDGET)).toEqual({ fn: 'hub/records_table', args: JSON.stringify({ type: NOTE_TYPE, status: 'open' }), offset: 'offset', limit: 'limit', format: 'csv' });
    expect(exportQuery(SAMPLE_WIDGET)).toBeUndefined();
    expect(rowTypes({ ...SAMPLE_TABLE, records: { type: QualifiedName.parse('tasks/Task'), id: 'id' } })).toEqual(['tasks/Task', NOTE_TYPE]);
  });
});

describe("a widget's state", () => {
  it('holds a buffer: reads the next window after the rows held, and says when there are no more', async () => {
    const { host, reads } = fakeHost({ read: (_fn, args) => Promise.resolve(windowAt(args['offset'] === 2 ? 2 : 3)) });
    const state = pagedState(host);
    expect(state.table.value.rows).toHaveLength(2);
    await state.more();
    expect(state.table.value.rows).toHaveLength(3);
    expect(state.level.value.more).toBe(false);
    expect(await state.more()).toBe(false);
    expect(reads).toEqual([]);
    const ended = pagedState(fakeHost({ read: () => Promise.resolve(windowAt(3)) }).host);
    await ended.more();
    expect(ended.status.value).toBe('No more rows');
  });

  it('drills into a row as a new level kept in the URL, goes back, and restores the levels', async () => {
    const fake = fakeHost();
    const state = pagedState(fake.host);
    await state.drill(0);
    expect(fake.reads.at(-1)).toEqual({ fn: NOTE_WORDS, args: { note: 'rec_note_1' } });
    expect(state.levels.value.map((l) => l.label)).toEqual(['Notes by status', 'Words: Plan the trip']);
    expect(readLevels(fake.level())?.of).toBe('run_1');
    state.back(0);
    expect(state.levels.value).toHaveLength(1);
    expect(fake.level()).toBe('');
    fake.host.levels?.set(JSON.stringify({ of: 'run_1', steps: [{ fn: NOTE_WORDS, label: 'Words: Groceries', args: { note: 'rec_note_2' } }] }));
    await state.restore();
    expect(state.level.value.label).toBe('Words: Groceries');
    expect(state.table.value.rows).toEqual(SAMPLE_WORDS.rows);
  });

  it('drops a late answer: a refresh or a page that lands after a drill or a newer run never overwrites it', async () => {
    const waiting: ((value: Json) => void)[] = [];
    const fake = fakeHost();
    const slow: WidgetHost = { ...fake.host, read: (fn, args) => (fn === NOTE_WORDS ? fake.host.read(fn, args) : new Promise((resolve) => { waiting.push(resolve); })) };
    const state = pagedState(slow);
    const refreshing = state.refresh();
    await state.drill(0);
    waiting.shift()?.(windowAt(0));
    expect(await refreshing).toBe(false);
    expect(state.level.value.label).toBe('Words: Plan the trip');
    state.back(0);
    const paging = state.more();
    const older = state.refresh();
    const newer = state.refresh();
    waiting.pop()?.(windowAt(1));
    waiting.pop()?.(windowAt(0));
    waiting.pop()?.(windowAt(2));
    expect([await paging, await older, await newer]).toEqual([false, false, true]);
    expect(state.table.value.rows).toEqual(SAMPLE_TABLE.rows.slice(1, 3));
  });

  it('shows the form, then the confirm, runs the action and refreshes after a write', async () => {
    const fake = fakeHost();
    const state = pagedState(fake.host);
    const rename = SAMPLE_ACTIONS.find((a) => a.label === 'Rename');
    if (rename === undefined) { throw new Error('no sample'); }
    state.openRow(1);
    expect(state.offered.value.map((o) => o.label)).toEqual(['Archive', 'Rename']);
    await state.choose(rename);
    expect(state.step.value).toBe('form');
    await state.submitForm({ title: 'Shopping' });
    expect(state.step.value).toBe('confirm');
    await state.runAction();
    expect(fake.runs).toEqual([{ fn: 'notes/Note.rename', args: { title: 'Shopping', self: 'rec_note_2' } }]);
    expect(fake.reads).toEqual([{ fn: NOTES_WIDGET, args: { status: 'open' } }]);
    expect(state.row.value).toBeUndefined();
  });

  it('steps the dialog aside while an action waits for approval, and finishes once it is approved', async () => {
    let approve: (outcome: RunOutcome) => void = () => undefined;
    let waited = false;
    const fake = fakeHost({ run: (_fn, _args, waiting) => new Promise((resolve) => { waiting?.(); waited = true; approve = resolve; }) });
    const state = pagedState(fake.host);
    const archive = SAMPLE_ACTIONS.find((a) => a.label === 'Archive');
    if (archive === undefined) { throw new Error('no sample'); }
    state.openRow(0);
    await state.choose(archive);
    expect(state.step.value).toBe('confirm');
    const ran = state.runAction();
    await flushPromises();
    expect(waited).toBe(true);
    expect(state.row.value).toBeUndefined();
    expect(state.status.value).toBe('Archive: waiting for your approval.');
    approve({ ok: true, output: null });
    expect(await ran).toBe(true);
  });

  it('opens the rows an action returns as a level, and says when one returned nothing to show', async () => {
    const opens: WidgetActionOption = { fn: QualifiedName.parse('notes/Note.words'), label: 'Words', mode: 'read', confirm: false, bind: { note: 'id' }, then: 'open' };
    const fake = fakeHost({ run: () => Promise.resolve({ ok: true, output: Json.parse(SAMPLE_WORDS) }) });
    const state = pagedState(fake.host);
    state.openRow(0);
    await state.choose(opens);
    expect(state.level.value.label).toBe('Words: Plan the trip');
    state.back(0);
    const status = pagedState(fakeHost().host);
    status.openRow(0);
    await status.choose({ ...opens, then: 'status' });
    expect(status.status.value).toBe('Words: done.');
  });

  it('re-runs a live widget in place while shown, only when the host reads quietly', async () => {
    vi.useFakeTimers();
    const live = Json.parse({ ...SAMPLE_PAGED_WIDGET, live: { every: 5000 } });
    let reads = 0;
    const fake = fakeHost({ read: () => { reads++; return Promise.resolve(live); } });
    const parsed = WidgetResult.parse(live);
    const state = new WidgetState(fake.host, { frame: resultFrame(parsed), args: {}, source: new FnWidgetSource(fake.host, NOTES_WIDGET, 'Notes'), key: 'k' }, CLOCK);
    let shown = false;
    state.startLive(() => shown);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(0);
    shown = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(1);
    state.stopLive();
    const loud = new WidgetState({ ...fake.host, quiet: false }, { frame: resultFrame(parsed), args: {}, source: undefined, key: 'k' }, CLOCK);
    expect(loud.every.value).toBeUndefined();
  });
});

describe('the widget view', () => {
  it('stages chip values and applies them together; a preset runs at once', async () => {
    const fake = fakeHost();
    const wrapper = mount(WidgetView, { attachTo: document.body, props: { frame: resultFrame(SAMPLE_PAGED_WIDGET), fn: NOTES_WIDGET, args: { status: 'open' }, viewKey: 'run_1' }, global: { provide: { [WIDGET_HOST]: fake.host } } });
    await flushPromises();
    const chips = wrapper.findAll('[data-testid=widget-chip]');
    expect(chips.map((c) => c.text())).toEqual(['StatusOpen', 'OwnerAny', 'Since7 days ago']);
    await chips[0]?.trigger('click');
    const done = [...document.querySelectorAll<HTMLButtonElement>('[data-testid=widget-chip-choice]')].find((b) => b.textContent.includes('Done'));
    done?.click();
    await flushPromises();
    expect(wrapper.get('[data-testid=widget-chip][data-arg=status]').text()).toContain('Done');
    expect(fake.reads).toHaveLength(0);
    await wrapper.get('[data-testid=widget-apply]').trigger('click');
    await flushPromises();
    expect(fake.reads).toEqual([{ fn: NOTES_WIDGET, args: { status: 'done' } }]);
    await wrapper.findAll('[data-testid=widget-preset]')[1]?.trigger('click');
    await flushPromises();
    expect(fake.reads).toHaveLength(2);
    wrapper.unmount();
  });

  it('draws rows from a write read-only: no chips, and Run again asks first', async () => {
    const fake = fakeHost();
    const written = ResultTable.parse({ ...SAMPLE_TABLE, write: { affected: 3 } });
    const wrapper = mount(WidgetView, { attachTo: document.body, props: { frame: tableFrame(written, 'Updated'), fn: QualifiedName.parse('db/update_notes'), args: {} }, global: { provide: { [WIDGET_HOST]: fake.host } } });
    await flushPromises();
    expect(wrapper.find('[data-testid=widget-chips]').exists()).toBe(false);
    const menu = await menuOf(wrapper);
    expect(menu.has('refresh')).toBe(false);
    menu.get('run-again')?.click();
    await flushPromises();
    expect(fake.runs).toEqual([]);
    document.querySelector<HTMLButtonElement>('[data-testid=confirm]')?.click();
    await flushPromises();
    expect(fake.runs).toEqual([{ fn: 'db/update_notes', args: {} }]);
    wrapper.unmount();
  });

  it('draws a proposal with its preview and saves it as the person, then links to it', async () => {
    const fake = fakeHost();
    const wrapper = mount(TableResult, { attachTo: document.body, props: { value: Json.parse(SAMPLE_PROPOSAL), fn: QualifiedName.parse('widgets/make_widget'), title: 'Make widget' }, global: { provide: { [WIDGET_HOST]: fake.host }, stubs: { RouterLink: { template: '<a><slot /></a>' } } } });
    await flushPromises();
    expect(wrapper.find('[data-testid=widget-view]').exists()).toBe(true);
    expect((await menuOf(wrapper)).has('refresh')).toBe(false);
    await wrapper.get('[data-testid=widget-proposal-save]').trigger('click');
    await flushPromises();
    expect(fake.runs).toEqual([{ fn: SAVE_WIDGET_FN, args: Json.parse({ name: 'open_notes', description: SAMPLE_PROPOSAL.description, spec: SAMPLE_PROPOSAL.spec }) }]);
    expect(wrapper.get('[data-testid=widget-proposal-saved]').text()).toBe('Saved as widgets/open_notes');
    wrapper.unmount();
  });
});

describe('the widget chrome', () => {
  it('shows a widget\'s own visuals as a toggle, and Refresh, exports, full screen and Settings in its menu', async () => {
    const fake = fakeHost();
    const wrapper = mount(WidgetView, { attachTo: document.body, props: { frame: resultFrame(SAMPLE_PAGED_WIDGET), fn: NOTES_WIDGET, args: { status: 'open' }, viewKey: 'run_1' }, global: { provide: { [WIDGET_HOST]: fake.host } } });
    await flushPromises();
    // the chips say what data this is, and stay out of the menu
    expect(wrapper.findAll('[data-testid=widget-chip]')).toHaveLength(3);
    const menu = await menuOf(wrapper);
    expect([...menu.keys()]).toEqual(['png', 'csv', 'all', 'json', 'copy', 'refresh', 'full', 'settings']);
    menu.get('refresh')?.click();
    await flushPromises();
    expect(fake.reads).toHaveLength(1);
    wrapper.unmount();
    const own = mount(TableResult, { attachTo: document.body, props: { value: Json.parse(SAMPLE_WIDGET), fn: NOTES_WIDGET, title: 'Open notes' }, global: { provide: { [WIDGET_HOST]: fake.host } } });
    await flushPromises();
    expect(own.findAll('[data-testid=result-visuals] [role=radio]').map((b) => b.attributes('aria-label'))).toEqual(['Words per note', 'Table']);
    own.unmount();
  });

  it('a plain table has no toggle and offers Make a widget in its menu; a saved widget\'s Settings saves its look', async () => {
    const asked: string[] = [];
    const fake = fakeHost({ ask: (text) => { asked.push(text); return Promise.resolve(true); } });
    const plain = mount(TableResult, { attachTo: document.body, props: { value: Json.parse(SAMPLE_TABLE), fn: QualifiedName.parse('db/notes'), title: 'Notes' }, global: { provide: { [WIDGET_HOST]: fake.host } } });
    await flushPromises();
    expect(plain.find('[data-testid=result-visuals]').exists()).toBe(false);
    (await menuOf(plain)).get('make-widget')?.click();
    await flushPromises();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Make a widget from db/notes');
    (await menuOf(plain)).get('settings')?.click();
    await flushPromises();
    expect(document.querySelector('[data-testid=result-settings]')).not.toBeNull();
    expect(document.querySelector('[data-testid=widget-save-look]')).toBeNull();
    plain.unmount();
    document.body.innerHTML = '';

    const saved = mount(TableResult, { attachTo: document.body, props: { value: Json.parse(SAMPLE_WIDGET), fn: NOTES_WIDGET, title: 'Open notes' }, global: { provide: { [WIDGET_HOST]: fake.host } } });
    await flushPromises();
    const menu = await menuOf(saved);
    expect(menu.has('make-widget')).toBe(false);
    menu.get('settings')?.click();
    await flushPromises();
    document.querySelector<HTMLButtonElement>('[data-testid=widget-save-look]')?.click();
    await flushPromises();
    expect(asked[1]).toBe(saveLookRequest(NOTES_WIDGET, 'Words per note', 'Bars'));
    expect(document.querySelector('[data-testid=result-settings]')).toBeNull();
    saved.unmount();
  });
});

describe('inline edits', () => {
  it('reads what is typed as the column stores it, and leaves out what does not fit', () => {
    expect(enteredValue({ kind: 'integer', nullable: false }, '7')).toBe(7);
    expect(enteredValue({ kind: 'integer', nullable: false }, '7.5')).toBeUndefined();
    expect(enteredValue({ kind: 'number', nullable: true }, '')).toBeNull();
    expect(enteredValue({ kind: 'text', nullable: false }, '')).toBe('');
    expect(enteredValue({ kind: 'boolean', nullable: false }, true)).toBe(true);
    expect(editInput({ kind: 'json', editable: true })).toBeUndefined();
    expect(editInput({ kind: 'date', editable: true })).toBe('date');
    expect(editInput({ kind: 'text' })).toBeUndefined();
  });
});
