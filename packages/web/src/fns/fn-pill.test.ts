/**
 * Plan item 10: fn names as pills. A `FnPill` shows the friendly label with the qualified name on hover, opens the one
 * app-wide fn modal bound to `?fn=` (so any page with a fn open is a shareable link), and a glob or a whole system
 * links to the fns list filtered instead. A model's tool name (`hub__fns_search`) reads back to its fn.
 */
import { fnOfStoredToolName, modelFnName, QualifiedName, RunId, type LlmInteraction } from '@harness/core';
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from '../app/App.vue';
import { createAppRouter } from '../app/router.ts';
import { links, ROUTES } from '../app/routes.ts';
import LlmCallDetails from '../chat/components/LlmCallDetails.vue';
import { toolCallFn, turnFns } from '../chat/logic/inspect.ts';
import { llmCall } from '../chat/test/fakes.ts';
import { queryParam, readListQuery } from '../state/query.ts';
import { STORES } from '../state/stores.ts';
import { fakeStores } from '../test/fakes.ts';
import FnPill from './components/FnPill.vue';
import { matchLink, matchQuery, pillTarget } from './logic/pill.ts';
import { createFnModal, FN_KEY, FN_MODAL, type FnModal } from './state/fn-modal.ts';

const fn = (name: string) => QualifiedName.parse(name);

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

describe('what a pill stands for', () => {
  it('reads a qualified name as a fn with its friendly label', () => {
    expect(pillTarget('fs/read_file')).toEqual({ kind: 'fn', fn: 'fs/read_file', label: 'Read file' });
    expect(pillTarget('not a name')).toEqual({ kind: 'text', label: 'not a name' });
  });

  it('turns a glob or a whole system into a filter over the fns list, never one fn', () => {
    expect(matchQuery('hub/*')).toEqual({ filters: [{ field: 'system', op: 'is', value: 'hub' }] });
    expect(matchQuery('database')).toEqual({ filters: [{ field: 'system', op: 'is', value: 'database' }] });
    expect(matchQuery('hub/search_*')).toEqual({ filters: [{ field: 'system', op: 'is', value: 'hub' }, { field: 'name', op: 'contains', value: 'search_' }] });
    expect(matchQuery('*/read_*')).toEqual({ filters: [{ field: 'name', op: 'contains', value: 'read_' }] });
    expect(matchQuery('fs/read_file')).toBeUndefined();
    expect(pillTarget('hub/*')).toMatchObject({ kind: 'match', label: 'All hub fns' });
    expect(pillTarget('database')).toMatchObject({ kind: 'match', label: 'All database fns' });
    expect(pillTarget('hub/search_*')).toMatchObject({ kind: 'match', label: 'Hub fns like search_*' });
  });

  it('links a glob to the fns list, with the filter the list reads back', () => {
    const query = matchQuery('hub/search_*');
    if (query === undefined) { throw new Error('no query'); }
    const written = queryParam('fns', query);
    expect(matchLink(query)).toEqual(links.fns({ q: written }));
    expect(readListQuery('fns', written).filters).toEqual(query.filters);
  });
});

describe('model tool names', () => {
  it('reads a stored tool name back to its fn: the one model name, a cut one the hub read, and the spelling of old records', () => {
    expect(fnOfStoredToolName('hub__fns_search')).toBe('hub/fns_search');
    expect(fnOfStoredToolName('fs__Entry__reveal')).toBe('fs/Entry.reveal');
    // the legacy spelling of stored model calls (a method's `.` as `--`), read for display only
    expect(fnOfStoredToolName('fs__Entry--reveal')).toBe('fs/Entry.reveal');
    expect(fnOfStoredToolName('fs/read_file')).toBe('fs/read_file');
    for (const name of ['hub/fns_search', 'fs/Entry.reveal', 'database/main.run_query']) { expect(fnOfStoredToolName(modelFnName(fn(name)))).toBe(name); }
    const long = fn(`database/${'x'.repeat(80)}`);
    expect(fnOfStoredToolName(modelFnName(long))).toBeUndefined();
    expect(fnOfStoredToolName(modelFnName(long), (name) => (name === modelFnName(long) ? long : undefined))).toBe(long);
    // a static tool, or a name that wasn't encoded from a fn, is no fn
    expect(fnOfStoredToolName('run')).toBeUndefined();
    expect(fnOfStoredToolName('fs__a b')).toBeUndefined();
  });

  const call = (): LlmInteraction => llmCall({
    request: { messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'hub__fns_search', arguments: '{"text":"x"}' }] }], tools: [{ name: 'hub__fns_search', description: 'Search fns', parameters: {} }, { name: 'run', description: 'Run a fn', parameters: {} }] },
    response: { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 't2', name: 'fs__read_file', arguments: '{}' }, { id: 't3', name: 'run', arguments: '{"fn":"database/run_query","args":{}}' }, { id: 't5', name: 'find', arguments: '{"text":"x"}' }, { id: 't4', name: 'hub__fns_search', arguments: '{}' }] },
  });

  it('shows the tools offered and called as pills of their fns, static tools as plain names', async () => {
    const view = mount(LlmCallDetails, { props: { call: call(), tab: 'tools' } });
    const tools = view.findAll('[data-testid=llm-tool]');
    expect(tools[0]?.find('[data-testid=fn-pill]').attributes('data-fn')).toBe('hub/fns_search');
    expect(tools[0]?.text()).toContain('Fns search');
    expect(tools[1]?.find('[data-testid=fn-pill]').exists()).toBe(false);
    expect(tools[1]?.text()).toContain('run');
    await view.setProps({ tab: 'answer' });
    expect(view.findAll('[data-testid=llm-tool-call] [data-testid=fn-pill]').map((pill) => pill.attributes('data-fn'))).toEqual(['fs/read_file', 'database/run_query', 'hub/fns_search']);
    // the static run tool keeps its name beside the fn it names; other static tools are names alone
    const calls = view.findAll('[data-testid=llm-tool-call]');
    expect(calls[1]?.find('.tool-name').text()).toBe('run');
    expect(calls[2]?.find('[data-testid=fn-pill]').exists()).toBe(false);
    expect(turnFns([call()])).toEqual(['fs/read_file', 'database/run_query', 'hub/fns_search']);
  });

  it('reads the fn a static run call names, and nothing from other static tools or bad args', () => {
    expect(toolCallFn({ name: 'hub__fns_search', arguments: '{}' })).toBe('hub/fns_search');
    expect(toolCallFn({ name: 'run', arguments: '{"fn":"fs/read_file","args":{"path":"a"}}' })).toBe('fs/read_file');
    // the hub's own `run` args (core's RunArgs): a machine named with `on` still reads the fn; a bad `on` reads none
    expect(toolCallFn({ name: 'run', arguments: '{"fn":"fs/read_file","on":"laptop"}' })).toBe('fs/read_file');
    expect(toolCallFn({ name: 'run', arguments: '{"fn":"fs/read_file","on":"Not A Machine"}' })).toBeUndefined();
    expect(toolCallFn({ name: 'run', arguments: '{"fn":"nope"}' })).toBeUndefined();
    expect(toolCallFn({ name: 'run', arguments: 'not json' })).toBeUndefined();
    expect(toolCallFn({ name: 'load', arguments: '{"fn":"fs/read_file"}' })).toBeUndefined();
  });
});

describe('FnPill', () => {
  /** A modal that records what was opened. */
  function fakeModal(): FnModal & { opened: string[] } {
    const opened: string[] = [];
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] });
    return { ...createFnModal(router), open: (name) => { opened.push(name); }, opened };
  }

  it('shows the friendly label, the qualified name on hover, and opens the fn modal', async () => {
    const modal = fakeModal();
    const pill = mount(FnPill, { props: { name: 'fs/read_file' }, global: { provide: { [FN_MODAL]: modal } } });
    expect(pill.text()).toBe('Read file');
    expect(pill.attributes('title')).toBe('fs/read_file');
    expect(pill.element).toBeInstanceOf(HTMLButtonElement);
    await pill.trigger('click');
    expect(modal.opened).toEqual(['fs/read_file']);
  });

  it('looks off and says why when the hub says what blocks it', () => {
    const pill = mount(FnPill, { props: { name: 'database/create_table', blocked: { code: 'held', reason: 'It waits for review' } }, global: { provide: { [FN_MODAL]: fakeModal() } } });
    expect(pill.classes()).toContain('muted');
    expect(pill.attributes('title')).toBe('database/create_table: It waits for review');
    expect(pill.text()).toContain('held');
    const off = mount(FnPill, { props: { name: 'fs/write', available: { unavailable: 'disabled', detail: 'Switched off' } } });
    expect(off.text()).toContain('off');
    expect(off.attributes('title')).toBe('fs/write: Switched off');
  });

  it('is a plain label outside the app, and a glob is a filter link for admins only', () => {
    expect(mount(FnPill, { props: { name: 'fs/read_file' } }).element).toBeInstanceOf(HTMLSpanElement);
    const admin = fakeStores({ signedIn: true }).stores;
    const glob = mount(FnPill, { props: { name: 'hub/*' }, global: { provide: { [STORES]: admin, [FN_MODAL]: fakeModal() }, stubs: { RouterLink: RouterLinkStub } } });
    expect(glob.text()).toBe('All hub fns');
    expect(glob.getComponent(RouterLinkStub).props('to')).toEqual(matchLink({ filters: [{ field: 'system', op: 'is', value: 'hub' }] }));
    const plain = mount(FnPill, { props: { name: 'hub/*' }, global: { provide: { [FN_MODAL]: fakeModal() } } });
    expect(plain.element).toBeInstanceOf(HTMLSpanElement);
  });
});

describe('the app-wide fn modal, bound to ?fn=', () => {
  async function visit(path: string) {
    const fakes = fakeStores({ signedIn: true });
    const router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push(path);
    await router.isReady();
    const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
    await flushPromises();
    return { ...fakes, router, app };
  }
  const dialog = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="dialog"]');

  it('opens from a shared link on any page, and closing drops the key', async () => {
    const { app, router } = await visit('/admin/systems/fs/fns?fn=fs/read_file');
    expect(dialog()?.textContent).toContain('Read file');
    dialog()?.querySelector<HTMLElement>('[aria-label="Close"]')?.click();
    await flushPromises();
    expect(dialog()).toBeNull();
    expect(router.currentRoute.value.query[FN_KEY]).toBeUndefined();
    expect(router.currentRoute.value.path).toBe('/admin/systems/fs/fns');
    app.unmount();
  });

  it('writes the fn into the URL when a fn is opened, and a bad value opens nothing', async () => {
    const { app, router } = await visit('/admin/systems/fs/fns');
    document.body.querySelector<HTMLElement>('[data-testid="fn-page"]')?.click();
    await flushPromises();
    expect(router.currentRoute.value.query[FN_KEY]).toBe('fs/read_file');
    expect(router.currentRoute.value.path).toBe('/admin/systems/fs/fns');
    expect(dialog()).not.toBeNull();
    await router.replace({ query: { [FN_KEY]: 'not a name' } });
    await flushPromises();
    expect(dialog()).toBeNull();
    app.unmount();
  });

  it('opens a run where the page under it says, closing in the same move, and drops scopes with their pages', async () => {
    const blank = { render: () => null };
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/runs', name: ROUTES.runs, component: blank }, { path: '/:any(.*)*', component: blank }] });
    await router.push('/chat/s1?q=x');
    const modal = createFnModal(router);
    modal.open(fn('fs/read_file'));
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/chat/s1?q=x&fn=fs/read_file');
    expect(modal.name.value).toBe('fs/read_file');

    // with no page scope a run opens in the runs browser
    modal.openRun(RunId.parse('run_9'));
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/runs?run=run_9');

    await router.push('/chat/s1?q=x&fn=fs/read_file');
    const Page = defineComponent({ setup() { modal.within({ run: (id) => ({ query: { ...router.currentRoute.value.query, run: id } }) }); return () => h('div'); } });
    const page = mount(Page);
    modal.openRun(RunId.parse('run_1'));
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/chat/s1?q=x&run=run_1');
    expect(modal.name.value).toBeUndefined();
    page.unmount();
    expect(modal.scope.value).toEqual({});
  });
});
