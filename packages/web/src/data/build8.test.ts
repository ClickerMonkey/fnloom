/**
 * Build 8, web: widgets (which visuals they offer and with which columns, row actions with their confirm and form, the
 * controls and refresh as new runs, Save as widget on a plain table), the Data pages (stored types, a type's records
 * with search, filters, sort and paging in the URL, a record opened with its history, saved, removed), version history
 * for any item, and one New chat on the chat's empty page.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { Json, RunId, SystemName } from '@harness/core';
import { createAppRouter } from '../app/router.ts';
import App from '../app/App.vue';
import { STORES } from '../state/stores.ts';
import { fakeStores } from '../test/fakes.ts';
import ItemHistory from '../components/versions/ItemHistory.vue';
import { ITEM_VERSIONS } from '../components/versions/versions.ts';
import { filterLabel, filtersOf, filtersParam, recordIdOf, recordTableQuery, sortOf, sortParam, storageWords } from './logic/data.ts';
import { NOTE_TYPE, SAMPLE_TABLE, SAMPLE_WIDGET, sampleItemVersions } from './test/samples.ts';
import { collapsedByDefault } from '../chat/state/collapse.ts';
import { groupPieces } from '../chat/logic/groups.ts';

const NOTES = SystemName.parse('notes');

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

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

describe('the Data pages\' logic', () => {
  it('reads and writes sort and filters in the URL, and asks the hub with them', () => {
    expect(sortOf('-title')).toEqual({ field: 'title', dir: 'desc' });
    expect(sortParam({ field: 'words', dir: 'asc' })).toBe('words');
    const filters = [{ field: 'status', op: 'is' as const, value: 'open' }];
    expect(filtersOf(filtersParam(filters))).toEqual(filters);
    expect(filtersOf('not json')).toEqual([]);
    expect(filterLabel({ field: 'words', op: 'gt', value: 3 })).toBe('words > 3');
    expect(recordTableQuery(NOTE_TYPE, { q: ' plan ', sort: '-words', where: filtersParam(filters), view: 'category.bar' }, 50)).toEqual({
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
    expect(fns.searchFns.calls.at(-1)?.[0]).toMatchObject({ kinds: ['widgets/widget'], text: 'notes' });
    expect(app.findAll('[data-testid=data-widget]').length).toBeGreaterThan(0);
    app.unmount();
  });

  it('shows a type\'s records from its URL, opens one with its history, and saves it with its version', async () => {
    const { app, data, router } = await visit('/data/notes/Note?q=trip&sort=-words');
    expect(data.recordTable.calls.at(-1)?.[0]).toMatchObject({ type: NOTE_TYPE, search: 'trip', query: { sort: [{ field: 'words', dir: 'desc' }] } });
    await app.findAll('[data-testid=result-visuals] button').find((b) => b.attributes('aria-label') === 'Table')?.trigger('click');
    await vi.dynamicImportSettled();
    await flushPromises();
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

  it('draws the records in the widget view: the visual and the hub sort in the URL, cells edited in place, saved after one confirm', async () => {
    const { app, data, router } = await visit('/data/notes/Note?view=table');
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(app.find('[data-testid=records-widget] [data-testid=result-view]').attributes('data-visual')).toBe('table');
    // a header click sorts through the hub, by the URL
    await app.findAll('[data-testid=result-grid] th button')[3]?.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query['sort']).toBe('words');
    expect(data.recordTable.calls.at(-1)?.[0]).toMatchObject({ query: { sort: [{ field: 'words', dir: 'asc' }] }, offset: 0 });
    await vi.dynamicImportSettled();
    await flushPromises();
    // two fields of one note staged (a number that isn't one is left out), then one confirm naming them
    const cell = (column: string) => app.findAll(`[data-testid=result-cell-edit][data-column=${column}]`)[0];
    await cell('title')?.setValue('Plan the walk');
    await cell('words')?.setValue('7');
    await app.findAll('[data-testid=result-cell-edit][data-column=words]')[1]?.setValue('seven');
    expect(app.get('[data-testid=record-edits-review]').text()).toBe('Save 2 changes');
    await app.get('[data-testid=record-edits-review]').trigger('click');
    await flushPromises();
    const lines = [...document.body.querySelectorAll('[data-testid=record-edit-line]')].map((line) => line.textContent);
    expect(lines).toEqual(['Plan the trip: title “Plan the walk”, words 7']);
    document.body.querySelector<HTMLButtonElement>('[data-testid=record-edits-save]')?.click();
    await flushPromises();
    expect(data.updateRecord.calls.map((call) => call[0])).toEqual([{ type: NOTE_TYPE, id: 'rec_note_1', set: { title: 'Plan the walk', words: 7 } }]);
    expect(app.find('[data-testid=record-edits-review]').exists()).toBe(false);
    expect(app.get('[data-testid=widget-status]').text()).toBe('1 record saved.');
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
