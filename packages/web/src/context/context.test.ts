/**
 * The context pages: the URL and the drafts (pure), the store on fakes (list, item, links, memory, making from a
 * resource, live changes), the components alone, and both pages mounted in the app at a desktop and a phone width.
 */
import { QualifiedName, ResourceUri, type LinkTarget } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from '../app/App.vue';
import { createAppRouter } from '../app/router.ts';
import { links, routes } from '../app/routes.ts';
import { STORES } from '../state/stores.ts';
import { fakeStores } from '../test/fakes.ts';
import ContextRow from './components/ContextRow.vue';
import FromResourceDialog from './components/FromResourceDialog.vue';
import LinkDialog from './components/LinkDialog.vue';
import LinkGroups from './components/LinkGroups.vue';
import MemoryDialog from './components/MemoryDialog.vue';
import {
  emptyLinkDraft, filterOf, fromResourceRequest, groupLinks, isFiltered, linkKey, linkRequest, memoryDraft, memoryRequest, originOf, readContextQuery, removable, scopeText, sizeText, targetText, weightPercent,
} from './logic/context.ts';
import { targetRoute } from './logic/targets.ts';
import { contextLink, contextRecord, fakeContext, fixtureGraph, T_CONTEXT } from './test/fakes.ts';

const name = (text: string): QualifiedName => QualifiedName.parse(text);
const GUIDE = name('fs/guide');
const MEMORY = name('memory/likes-tabs-ab12');

describe('the context URL and drafts', () => {
  it('reads the query through its schema, dropping what does not parse', () => {
    expect(readContextQuery({ q: 'files', origin: 'memory', system: 'fs', remember: '1' })).toEqual({ q: 'files', origin: 'memory', system: 'fs', remember: '1' });
    expect(readContextQuery({ q: '', origin: 'nonsense', system: 'Not A System!', from: '2' })).toEqual({});
    expect(filterOf({ q: '  tabs ', origin: 'memory' })).toEqual({ search: 'tabs', origin: 'memory' });
    expect(filterOf({ q: '   ' })).toEqual({});
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ origin: 'system' })).toBe(true);
  });

  it('makes links for every target the app has a page for', () => {
    expect(links.contextItem(GUIDE)).toEqual({ name: 'context-item', params: { system: 'fs', local: 'guide' } });
    expect(links.context({ origin: 'memory', q: 'tabs' })).toEqual({ name: 'context', query: { origin: 'memory', q: 'tabs' } });
    expect(targetRoute({ kind: 'context', name: GUIDE }, false)).toEqual(links.contextItem(GUIDE));
    expect(targetRoute({ kind: 'fn', name: name('fs/read') }, false)).toBeUndefined();
    expect(targetRoute({ kind: 'fn', name: name('fs/read') }, true)).toEqual(links.fn(name('fs/read')));
    expect(targetRoute({ kind: 'type', name: name('fs/path') }, true)).toBeUndefined();
    expect(targetRoute({ kind: 'resource', uri: ResourceUri.parse('fs://work/a.md') }, false)).toEqual(links.resources({ uri: 'fs://work/a.md' }));
  });

  it('says what a record and a link are in words', () => {
    const { records, links: edges } = fixtureGraph();
    expect(records.map(originOf)).toEqual(['system', 'system', 'memory', 'resource']);
    expect(scopeText({ to: 'everyone' })).toBe('Everyone');
    expect(targetText({ kind: 'resource', uri: ResourceUri.parse('fs://work/a.md') })).toBe('fs://work/a.md');
    expect(weightPercent(1.4)).toBe(100);
    expect(weightPercent(0.333)).toBe(33);
    expect(edges.filter(removable).map((l) => l.relation)).toEqual(['related']);
    expect(linkKey(edges[0] ?? contextLink('fs/a', { kind: 'context', name: GUIDE }))).toBe('fs/guide|context:fs/shell|imports');
  });

  it('groups links by relation in a fixed order, strongest first', () => {
    const groups = groupLinks([
      contextLink('fs/a', { kind: 'fn', name: name('fs/x') }, { relation: 'suggests', weight: 0.2 }),
      contextLink('fs/a', { kind: 'fn', name: name('fs/y') }, { relation: 'suggests', weight: 0.9 }),
      contextLink('fs/a', { kind: 'context', name: GUIDE }, { relation: 'imports', weight: 1 }),
    ]);
    expect(groups.map((g) => g.relation)).toEqual(['imports', 'suggests']);
    expect(groups[1]?.links.map((l) => l.to.kind === 'fn' ? l.to.name : '')).toEqual(['fs/y', 'fs/x']);
  });

  it('reads the add-link form into a target, or one plain problem', () => {
    const base = emptyLinkDraft();
    expect(linkRequest(base, GUIDE)).toEqual({ ok: false, problem: 'Give a name.' });
    expect(linkRequest({ ...base, target: 'nope' }, GUIDE)).toMatchObject({ ok: false });
    expect(linkRequest({ ...base, target: 'fs/guide' }, GUIDE)).toEqual({ ok: false, problem: "An item can't link to itself." });
    expect(linkRequest({ ...base, kind: 'fn', target: ' fs/read ', relation: 'brings', weight: 3 }, GUIDE)).toEqual({ ok: true, value: { to: { kind: 'fn', name: 'fs/read' }, relation: 'brings', weight: 1 } });
    expect(linkRequest({ ...base, kind: 'resource', target: 'README.md' }, GUIDE)).toMatchObject({ ok: false });
    expect(linkRequest({ ...base, kind: 'resource', target: 'fs://work/README.md', section: 'Usage' }, GUIDE)).toEqual({ ok: true, value: { to: { kind: 'resource', uri: 'fs://work/README.md', section: 'Usage' }, relation: 'related', weight: 0.5 } });
  });

  it('reads the memory and make-from-a-resource forms', () => {
    expect(memoryRequest({ title: '', text: '  ', scope: 'user' })).toEqual({ ok: false, problem: 'Write what to remember.' });
    expect(memoryRequest({ title: ' Tabs ', text: 'Use tabs.', scope: 'everyone' }, [{ kind: 'context', name: GUIDE }])).toEqual({ ok: true, value: { text: 'Use tabs.', title: 'Tabs', scope: 'everyone', about: [{ kind: 'context', name: 'fs/guide' }] } });
    const memory = fixtureGraph().records[2];
    expect(memoryDraft(memory)).toEqual({ title: 'Likes tabs', text: 'The owner likes tabs, not spaces.', scope: 'user' });
    expect(memoryDraft()).toEqual({ title: '', text: '', scope: 'user' });
    expect(fromResourceRequest({ uri: 'readme', copy: 'live', command: '' })).toMatchObject({ ok: false });
    expect(fromResourceRequest({ uri: 'fs://work/README.md', copy: 'snapshot', command: '/readme' })).toEqual({ ok: true, value: { uri: 'fs://work/README.md', copy: 'snapshot', command: 'readme' } });
    expect(fromResourceRequest({ uri: 'fs://work/README.md', copy: 'live', command: 'Bad Name' })).toMatchObject({ ok: false });
    const bad = fromResourceRequest({ uri: 'readme', copy: 'live', command: '' });
    expect(bad.ok ? '' : bad.problem).toContain('hub://resources/uploads/notes.md');
  });

  it('says an item its system writes on load is written when loaded, not 0 tokens', () => {
    expect(sizeText(contextRecord('fs/system-authoring', { tokens: { full: 0, summary: 26 } }))).toBe('Written when loaded');
    expect(sizeText(contextRecord('fs/guide', { content: 'Use tabs.', tokens: { full: 1_200, summary: 40 } }))).toBe('1,200 tokens');
    expect(sizeText(contextRecord('fs/guide', { content: 'Use tabs.' }))).toBeUndefined();
  });
});

describe('ContextStore', () => {
  it('lists by filter, page by page, and refreshes rather than reloading the same filter', async () => {
    const { context, api } = fakeContext({ records: Array.from({ length: 60 }, (_, i) => contextRecord(`fs/item-${String(i).padStart(2, '0')}`)), links: [] });
    await context.show({});
    expect(context.list.items.value).toHaveLength(50);
    expect(context.list.hasMore.value).toBe(true);
    await context.list.more();
    expect(context.list.items.value).toHaveLength(60);
    await context.show({ search: 'item-05' });
    expect(context.list.items.value.map((r) => r.name)).toEqual(['fs/item-05']);
    const calls = api.list.calls.length;
    await context.show({ search: 'item-05' });
    expect(api.list.calls.length).toBe(calls + 1);
    expect(context.list.loading.value).toBe(false);
  });

  it('opens an item with its links both ways, draws and removes a link', async () => {
    const { context, api, state } = fakeContext();
    await context.item.open(GUIDE);
    const view = context.item.view.value.value;
    expect(view?.links.map((l) => l.relation).sort()).toEqual(['brings', 'imports', 'related', 'suggests']);
    expect(view?.backlinks.map((l) => l.from).sort()).toEqual(['fs/shell', 'memory/likes-tabs-ab12']);
    const bad = await context.item.addLink({ ...emptyLinkDraft(), target: 'oops' });
    expect(bad.ok).toBe(false);
    expect(context.item.linking.problem.value).toContain('system/name');
    expect(api.link.calls).toHaveLength(0);
    const made = await context.item.addLink({ ...emptyLinkDraft(), kind: 'type', target: 'fs/path', relation: 'about', weight: 0.7 });
    expect(made.ok).toBe(true);
    expect(api.link.calls[0]?.[0]).toEqual({ from: 'fs/guide', to: { kind: 'type', name: 'fs/path' }, relation: 'about', weight: 0.7 });
    expect(context.item.view.value.value?.links).toHaveLength(5);
    const drawn = state.links.find((l) => l.toKey === 'type:fs/path');
    if (drawn === undefined) { throw new Error('expected the drawn link'); }
    expect((await context.item.removeLink(drawn)).ok).toBe(true);
    expect(context.item.view.value.value?.links).toHaveLength(4);
    const declared = state.links.find((l) => l.relation === 'imports');
    if (declared === undefined) { throw new Error('expected the declared link'); }
    const refused = await context.item.removeLink(declared);
    expect(refused.ok).toBe(false);
    expect(context.item.unlinking.problem.value).toBe('That imports link comes from declared; only links people drew can be removed.');
  });

  it('writes, edits and forgets memory', async () => {
    const { context, api, state } = fakeContext();
    expect((await context.remember({ title: '', text: ' ', scope: 'user' })).ok).toBe(false);
    expect(api.remember.calls).toHaveLength(0);
    const made = await context.remember({ title: 'Short answers', text: 'Answer in one line.', scope: 'everyone' });
    if (!made.ok) { throw new Error(made.problem); }
    expect(state.records[0]?.origin).toMatchObject({ type: 'memory', scope: { to: 'everyone' } });

    await context.item.open(MEMORY);
    const edited = await context.item.edit({ title: 'Likes tabs', text: 'Tabs, always.', scope: 'user' });
    if (!edited.ok) { throw new Error(edited.problem); }
    expect(edited.value).not.toBe(MEMORY);
    expect(api.forget.calls[0]?.[0]).toEqual({ name: MEMORY });
    expect(context.item.name.value).toBe(edited.value);
    expect(context.item.view.value.value?.text).toBe('Tabs, always.');
    expect(state.links.some((l) => l.from === edited.value && l.relation === 'about' && l.toKey === 'context:fs/guide')).toBe(true);

    expect((await context.item.forget()).ok).toBe(true);
    expect(context.item.view.value.value?.record.disabled).toBe(true);
    await context.item.open(GUIDE);
    expect((await context.item.edit({ title: '', text: 'x', scope: 'user' })).ok).toBe(false);
    expect((await context.item.forget()).ok).toBe(false);
  });

  it('makes context from a resource, then updates the same items', async () => {
    const { context } = fakeContext();
    const first = await context.fromResource({ uri: ResourceUri.parse('fs://work/notes.md'), copy: 'live' });
    expect(first).toEqual({ ok: true, value: { created: ['resource/notes-md-ef56'], updated: [], links: 1 } });
    const again = await context.fromResource({ uri: ResourceUri.parse('fs://work/notes.md'), copy: 'live' });
    expect(again).toEqual({ ok: true, value: { created: [], updated: ['resource/notes-md-ef56'], links: 1 } });
  });

  it('follows live changes while followed: the list refreshes, the open item reloads when touched', async () => {
    const { context, api, events, state } = fakeContext();
    const stop = context.follow();
    const stopAgain = context.follow();
    expect(events.listeners).toBe(1);
    await context.show({});
    await context.item.open(GUIDE);
    const itemCalls = api.item.calls.length;
    const listCalls = api.list.calls.length;
    state.records.unshift(contextRecord('fs/new-one'));
    events.push(name('fs/elsewhere'));
    await flushPromises();
    expect(api.list.calls.length).toBe(listCalls + 1);
    expect(context.list.items.value[0]?.name).toBe('fs/new-one');
    expect(api.item.calls.length).toBe(itemCalls);
    events.push(name('fs/shell'));
    await flushPromises();
    expect(api.item.calls.length).toBe(itemCalls + 1);
    expect(context.item.view.value.value?.record.name).toBe(GUIDE);
    stop();
    stop();
    expect(events.listeners).toBe(1);
    stopAgain();
    expect(events.listeners).toBe(0);
  });
});

describe('the context components', () => {
  const router = () => createRouter({ history: createMemoryHistory(), routes });

  it('a row shows the origin, the command and when it changed', async () => {
    const record = contextRecord('fs/guide', { description: 'How to use the file tools', command: 'files', tokens: { full: 1200, summary: 20 }, stale: true });
    const r = router();
    const wrapper = mount(ContextRow, { props: { record, to: links.contextItem(GUIDE), now: T_CONTEXT + 5 * 60_000 }, global: { plugins: [r] } });
    await flushPromises();
    expect(wrapper.text()).toContain('fs/guide');
    expect(wrapper.text()).toContain('/files');
    expect(wrapper.text()).toContain('Stale');
    expect(wrapper.text()).toContain('1,200 tokens');
    expect(wrapper.text()).toContain('5m');
    expect(wrapper.attributes('href')).toBe('/context/fs/guide');
  });

  it('link groups show both directions, and only drawn links out can be removed', async () => {
    const { links: edges } = fixtureGraph();
    const r = router();
    const out = mount(LinkGroups, { props: { links: edges.filter((l) => l.from === GUIDE), direction: 'out', routeOf: (t: LinkTarget) => targetRoute(t, true) }, global: { plugins: [r] } });
    expect(out.findAll('[data-relation]').map((g) => g.attributes('data-relation'))).toEqual(['imports', 'brings', 'suggests', 'related']);
    expect(out.findAll('[data-testid="remove-link"]')).toHaveLength(1);
    await out.get('[data-testid="remove-link"]').trigger('click');
    expect(out.emitted('remove')?.[0]?.[0]).toMatchObject({ relation: 'related', source: 'authored' });
    const back = mount(LinkGroups, { props: { links: edges.filter((l) => l.to.kind === 'context' && l.to.name === GUIDE), direction: 'in', routeOf: (t: LinkTarget) => targetRoute(t, true) }, global: { plugins: [r] } });
    expect(back.text()).toContain('Has notes');
    expect(back.text()).toContain('memory/likes-tabs-ab12');
    expect(back.find('[data-testid="remove-link"]').exists()).toBe(false);
    const none = mount(LinkGroups, { props: { links: [], direction: 'in', routeOf: () => undefined, empty: 'Nothing links here yet.' }, global: { plugins: [r] } });
    expect(none.text()).toBe('Nothing links here yet.');
  });

  it('the link dialog checks its draft before it emits', async () => {
    const wrapper = mount(LinkDialog, { props: { open: true, from: GUIDE }, attachTo: document.body });
    await flushPromises();
    const save = document.querySelector<HTMLButtonElement>('[data-testid="link-save"]');
    save?.click();
    await flushPromises();
    expect(wrapper.emitted('save')).toBeUndefined();
    expect(document.body.textContent).toContain('Give a name.');
    const input = document.querySelector<HTMLInputElement>('[data-testid="link-target"] input, input[data-testid="link-target"]');
    if (input === null) { throw new Error('no target input'); }
    input.value = 'fs/shell';
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    save?.click();
    await flushPromises();
    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ kind: 'context', target: 'fs/shell', relation: 'related', weight: 0.5 });
    wrapper.unmount();
  });

  it('the memory dialog starts from the memory it edits', async () => {
    const memory = fixtureGraph().records[2];
    const wrapper = mount(MemoryDialog, { props: { open: true, memory }, attachTo: document.body });
    await flushPromises();
    expect(document.body.textContent).toContain('Edit this memory');
    const area = document.querySelector<HTMLTextAreaElement>('textarea');
    expect(area?.value).toBe('The owner likes tabs, not spaces.');
    document.querySelector<HTMLButtonElement>('[data-testid="memory-save"]')?.click();
    await flushPromises();
    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({ title: 'Likes tabs', text: 'The owner likes tabs, not spaces.', scope: 'user' });
    wrapper.unmount();
  });

  it('the make-from-a-resource dialog emits the checked arguments', async () => {
    const wrapper = mount(FromResourceDialog, { props: { open: true, uri: 'fs://work/README.md' }, attachTo: document.body });
    await flushPromises();
    document.querySelector<HTMLButtonElement>('[data-testid="from-resource-save"]')?.click();
    await flushPromises();
    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({ uri: 'fs://work/README.md', copy: 'live' });
    wrapper.unmount();
  });
});

describe('the context pages', () => {
  function screen(width: number): void {
    const happyDOM: unknown = Reflect.get(window, 'happyDOM');
    const setViewport: unknown = typeof happyDOM === 'object' && happyDOM !== null ? Reflect.get(happyDOM, 'setViewport') : undefined;
    if (typeof setViewport === 'function') { Reflect.apply(setViewport, happyDOM, [{ width, height: 900 }]); }
  }
  const mounted: { unmount: () => void }[] = [];
  async function start(path: string, width = 1440) {
    screen(width);
    const fakes = fakeStores({ signedIn: true });
    const r = createAppRouter(fakes.stores.session, createMemoryHistory());
    await r.push(path);
    await r.isReady();
    const app = mount(App, { attachTo: document.body, global: { plugins: [r], provide: { [STORES]: fakes.stores } } });
    mounted.push(app);
    await flushPromises();
    return { ...fakes, router: r, app };
  }
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { for (const app of mounted.splice(0)) { app.unmount(); } screen(1440); });

  it('lists context from the URL and filters by origin', async () => {
    const { app, router: r, context } = await start('/context?origin=memory');
    expect(context.api.list.calls[0]?.[0]).toMatchObject({ origin: 'memory' });
    expect(app.findAll('[data-testid="context-row"]').map((row) => row.attributes('data-context'))).toEqual(['memory/likes-tabs-ab12']);
    const all = app.findAll('[data-testid="context-origin"] [role="radio"]').find((b) => b.text() === 'All');
    await all?.trigger('click');
    await flushPromises();
    expect(r.currentRoute.value.query['origin']).toBeUndefined();
    expect(app.findAll('[data-testid="context-row"]')).toHaveLength(4);
  });

  it('remembers from the dialog in the URL and opens the new memory', async () => {
    const { app, router: r } = await start('/context?remember=1');
    const area = document.querySelector<HTMLTextAreaElement>('[data-testid="memory-text"] textarea, textarea');
    if (area === null) { throw new Error('no memory text'); }
    area.value = 'Prefer short answers.';
    area.dispatchEvent(new Event('input'));
    await flushPromises();
    document.querySelector<HTMLButtonElement>('[data-testid="memory-save"]')?.click();
    await flushPromises();
    await flushPromises();
    await vi.waitFor(() => { expect(r.currentRoute.value.name).toBe('context-item'); });
    await vi.waitFor(() => { expect(app.find('[data-testid="context-text"]').exists()).toBe(true); });
    expect(String(r.currentRoute.value.params['system'])).toBe('memory');
    expect(app.get('[data-testid="context-text"]').text()).toContain('Prefer short answers.');
  });

  it('shows one item with its links both ways and adds a link, at a phone width too', async () => {
    for (const width of [1440, 390]) {
      const { app, context } = await start('/context/fs/guide', width);
      expect(app.get('[data-testid="context-item"]').attributes('data-context')).toBe('fs/guide');
      expect(app.get('[data-testid="context-facts"]').text()).toContain('/files');
      expect(app.findAll('[data-testid="links-out"] [data-testid="context-link"]')).toHaveLength(4);
      expect(app.findAll('[data-testid="links-in"] [data-testid="context-link"]')).toHaveLength(2);
      await app.get('[data-testid="add-link"]').trigger('click');
      await flushPromises();
      const input = document.querySelector<HTMLInputElement>('[data-testid="link-target"] input, input[data-testid="link-target"]');
      if (input === null) { throw new Error('no target input'); }
      input.value = 'fs/shell';
      input.dispatchEvent(new Event('input'));
      await flushPromises();
      document.querySelector<HTMLButtonElement>('[data-testid="link-save"]')?.click();
      await flushPromises();
      await flushPromises();
      expect(context.api.link.calls.at(-1)?.[0]).toMatchObject({ from: 'fs/guide', to: { kind: 'context', name: 'fs/shell' } });
      expect(app.findAll('[data-testid="links-out"] [data-testid="context-link"]')).toHaveLength(5);
      for (const one of mounted.splice(0)) { one.unmount(); }
      document.body.innerHTML = '';
    }
  });

  it('forgets a memory after asking', async () => {
    const { app, context } = await start('/context/memory/likes-tabs-ab12');
    await app.get('[data-testid="memory-forget"]').trigger('click');
    await flushPromises();
    document.querySelector<HTMLButtonElement>('[data-testid="confirm"]')?.click();
    await flushPromises();
    await flushPromises();
    expect(context.api.forget.calls[0]?.[0]).toEqual({ name: 'memory/likes-tabs-ab12' });
    expect(app.find('[data-testid="context-forgotten"]').exists()).toBe(true);
    expect(app.find('[data-testid="memory-edit"]').exists()).toBe(false);
  });
});
