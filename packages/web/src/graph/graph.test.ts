/**
 * The graphs (build 7): the URL query both ways, hover facts, where opening goes, the drawn elements (clusters, greyed
 * references, "+N more" stubs), the store on the fake caller, the sample graph's filters, the details and the graph's
 * own controls alone, and the search bar every list shares, on the graph list. Drawing and hovering are checked rendered, in `ui-tests/features/build7-graph.ts`.
 */
import { GraphQuery, SystemName, type Filter, type GraphNode } from '@harness/core';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ListSearch from '../components/query/ListSearch.vue';
import { fieldsOf, queryParam } from '../state/query.ts';
import { fakeGraphApi } from './test/fakes.ts';
import GraphControls from './components/GraphControls.vue';
import GraphDetails from './components/GraphDetails.vue';
import {
  clusterId, expandQuery, graphElements, graphQueryOf, graphUrlOf, moreId, nodeFacts, openTarget, pickOf, readGraphUrl, searchOf, shortName, totalsText, withPart, withSearch,
  packGroups,
} from './logic/graph.ts';
import { GraphStore } from './state/graph.ts';
import { graphOf, SAMPLE_NODES } from './test/graph.ts';

const sys = (name: string): SystemName => SystemName.parse(name);
const nodeOf = (id: string): GraphNode => {
  const found = SAMPLE_NODES.find((node) => node.id === id);
  if (found === undefined) { throw new Error(`no sample node ${id}`); }
  return found;
};

describe('the graph URL', () => {
  it('keeps its search and filters in q as every list writes them, its controls in their own keys, both ways', () => {
    const query: GraphQuery = {
      text: 'file',
      filters: [{ field: 'nodeKind', op: 'in', values: ['fn', 'type'] }, { field: 'edgeKind', op: 'is', value: 'reads' }, { field: 'mode', op: 'is', value: 'write' }, { field: 'on', op: 'is', value: false }],
      external: false, collapse: [sys('database')], focus: { node: 'fn:fs/read', hops: 2 },
    };
    const url = graphUrlOf(query);
    expect(url.q).toBe(queryParam('graph', searchOf(query)));
    expect(url).toMatchObject({ collapse: 'database', focus: 'fn:fs/read', hops: '2', external: '0' });
    expect(graphQueryOf(url)).toEqual(query);
    expect(graphQueryOf({ q: 'nodeKind:fn read' })).toEqual({ text: 'read', filters: [{ field: 'nodeKind', op: 'is', value: 'fn' }] });
  });

  it('drops values it cannot read, and keys whose values are wrong', () => {
    expect(graphQueryOf({ collapse: 'database,Not A System,database' })).toEqual({ collapse: ['database'] });
    expect(readGraphUrl({ hops: '9', q: 'x', part: 'roots', external: ['0'] })).toEqual({ q: 'x' });
    expect(graphUrlOf({ focus: { node: 'fn:fs/read', hops: 1 } })).toEqual({ focus: 'fn:fs/read' });
  });

  it('swaps the search and filters keeping the controls, and changes one control', () => {
    const query: GraphQuery = { text: 'old', collapse: [sys('fs')], focus: { node: 'fn:fs/read' } };
    expect(searchOf(query)).toEqual({ text: 'old' });
    const filters: Filter[] = [{ field: 'system', op: 'is', value: 'fs' }];
    // the graph is drawn, not sorted: a sort from the box is dropped
    expect(withSearch(query, { filters, sort: [{ field: 'name', dir: 'asc' }] })).toEqual({ filters, collapse: ['fs'], focus: { node: 'fn:fs/read' } });
    expect(withSearch(query, { text: '', filters: [] })).toEqual({ collapse: ['fs'], focus: { node: 'fn:fs/read' } });
    expect(withPart(query, 'external', false)).toEqual({ ...query, external: false });
    expect(withPart(query, 'collapse', [])).toEqual({ text: 'old', focus: { node: 'fn:fs/read' } });
    expect(expandQuery({ filters }, { node: 'fn:fs/read', kind: 'type', count: 3 })).toEqual({ filters, focus: { node: 'fn:fs/read', hops: 1 } });
  });

  it('says what a page holds: nodes / edges, and what the cap left out', () => {
    expect(totalsText({ nodes: [nodeOf('fn:fs/read')], edges: [], more: [], total: { nodes: 1, edges: 0 } })).toBe('1 node / 0 edges');
    const page = graphOf({ limit: 3 });
    expect(totalsText(page)).toMatch(/^3 nodes \/ \d+ edges?, \d+ more not drawn/);
  });
});

describe('what a node says and where it opens', () => {
  it('lists only the facts that apply', () => {
    const lines = Object.fromEntries(nodeFacts(nodeOf('fn:fs/write')).map((line) => [line.label, line.value]));
    expect(lines).toEqual({ 'Fn kind': 'Native', Mode: 'write', Writes: 'fs/file', 'Visible to': 'People and models', Examples: '2', State: 'On · Live' });
    const pending = Object.fromEntries(nodeFacts(nodeOf('fn:notes/add')).map((line) => [line.label, line.value]));
    expect(pending['State']).toBe('On · Waiting for review');
    const effects = Object.fromEntries(nodeFacts(nodeOf('fn:database/create_query')).map((line) => [line.label, line.value]));
    expect(effects['Effects']).toBe('create database/query fns');
    expect(nodeFacts({ ...nodeOf('fn:fs/read'), external: true }).at(-1)).toEqual({ label: 'From', value: 'fs (outside this view)' });
  });

  it('opens fns in the modal and the rest on their pages', () => {
    expect(openTarget(nodeOf('fn:fs/read'))).toEqual({ type: 'fn', fn: 'fs/read' });
    expect(openTarget(nodeOf('context:fs/authoring'))).toMatchObject({ type: 'page', to: { name: 'context-item' } });
    expect(openTarget(nodeOf('type:fs/file'))).toMatchObject({ type: 'page', to: { name: 'system', params: { name: 'fs', tab: 'types' } } });
    expect(openTarget(nodeOf('instance:fs/main'))).toMatchObject({ type: 'page', to: { name: 'instance', params: { name: 'fs', instance: 'main' } } });
    expect(openTarget({ ...nodeOf('system:database'), collapsed: 9 })).toMatchObject({ type: 'page', to: { params: { name: 'database', tab: 'graph' } } });
    expect(openTarget(nodeOf('component:notes/NoteCard'))).toMatchObject({ type: 'page', to: { params: { name: 'notes', tab: 'parts' } } });
    expect(shortName(nodeOf('type:database/main.projects'))).toBe('main.projects');
  });
});

describe('placing clusters', () => {
  it('puts groups in rows that never overlap, about as wide as the box', () => {
    const groups = [{ width: 400, height: 300 }, { width: 200, height: 120 }, { width: 220, height: 160 }, { width: 180, height: 90 }, { width: 500, height: 60 }];
    const gap = 50;
    const places = packGroups(groups, { aspect: 16 / 9, gap });
    const boxes = groups.map((g, at) => ({ ...g, ...(places[at] ?? { x: 0, y: 0 }) }));
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const apart = a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y;
        expect(apart, JSON.stringify([a, b])).toBe(true);
      }
    }
    // the tallest leads the first row; the whole is wider than tall for a wide box
    expect(places[0]).toEqual({ x: 0, y: 0 });
    const width = Math.max(...boxes.map((b) => b.x + b.width));
    const height = Math.max(...boxes.map((b) => b.y + b.height));
    expect(width).toBeGreaterThan(height);
    expect(packGroups([], { aspect: 1, gap })).toEqual([]);
    expect(packGroups([{ width: 10, height: 10 }], { aspect: Number.NaN, gap })).toEqual([{ x: 0, y: 0 }]);
  });
});

describe('the drawn elements', () => {
  it('clusters each system, greys references outside, and hangs stubs off their node', () => {
    const whole = graphOf({ systems: [sys('fs')] });
    const external = whole.nodes.find((node) => node.external);
    expect(external?.system).toBe('database');
    const drawn = graphElements(whole);
    expect(drawn.find((el) => el.data.id === external?.id)?.classes).toContain('external');
    expect(drawn.some((el) => el.data.id === clusterId(sys('fs')) && el.classes === 'cluster')).toBe(true);
    expect(drawn.some((el) => el.data.id === clusterId(sys('database')) && el.classes === 'cluster external')).toBe(true);
    const page = graphOf({ systems: [sys('fs')], limit: 6 });
    expect(page.more.length).toBeGreaterThan(0);
    const elements = graphElements(page);
    const more = page.more[0];
    expect(more && elements.some((el) => el.data.id === moreId(more))).toBe(true);
    expect(more && pickOf(page, moreId(more))).toMatchObject({ type: 'more' });
    expect(pickOf(page, 'edge:0')).toMatchObject({ type: 'edge' });
    expect(pickOf(page, 'nothing')).toBeUndefined();
  });

  it('draws one system without clusters unless asked', () => {
    const page = graphOf({ systems: [sys('notes')], external: false });
    expect(page.nodes.every((node) => node.system === 'notes')).toBe(true);
    expect(graphElements(page).some((el) => el.data.kind === 'cluster')).toBe(false);
    expect(graphElements(page, { clusters: true }).some((el) => el.data.kind === 'cluster')).toBe(true);
  });

  it('collapses a system into one node standing for its items', () => {
    const page = graphOf({ collapse: [sys('database')] });
    const system = page.nodes.find((node) => node.id === 'system:database');
    expect(system?.collapsed).toBeGreaterThan(1);
    expect(page.nodes.some((node) => node.system === 'database' && node.kind !== 'system')).toBe(false);
    expect(page.edges.some((edge) => edge.to === 'system:database' && edge.kind === 'brings')).toBe(true);
  });

  it('filters by kind, focus and text as the hub does', () => {
    expect(graphOf({ filters: [{ field: 'nodeKind', op: 'is', value: 'type' }] }).nodes.every((node) => node.kind === 'type')).toBe(true);
    const near = graphOf({ focus: { node: 'type:fs/file', hops: 1 } }).nodes.map((node) => node.id).sort();
    expect(near).toEqual(['fn:fs/read', 'fn:fs/write', 'system:fs', 'type:fs/file']);
    expect(graphOf({ text: 'note', filters: [{ field: 'mode', op: 'is', value: 'write' }] }).nodes.map((node) => node.id)).toEqual(['system:notes', 'fn:notes/add', 'type:notes/note']);
    // several words each must match, split on whitespace (regression: the sample once split on the letter "s")
    expect(graphOf({ text: 'notes add', filters: [{ field: 'nodeKind', op: 'is', value: 'fn' }] }).nodes.map((node) => node.id)).toEqual(['fn:notes/add']);
  });
});

describe('the store', () => {
  it('asks the hub for the query and refreshes it', async () => {
    const store = new GraphStore(fakeGraphApi());
    await store.show({ systems: [sys('fs')] });
    expect(store.page.problem.value).toBe('');
    expect(store.page.value.value?.nodes.some((node) => node.id === 'fn:fs/read')).toBe(true);
    await store.refresh();
    expect(store.page.problem.value).toBe('');
  });
});

describe('the components', () => {
  it('shows a node with its facts and actions', async () => {
    const wrapper = mount(GraphDetails, { props: { pick: { type: 'node', node: { ...nodeOf('fn:fs/read'), external: true } }, actions: true } });
    expect(wrapper.text()).toContain('Read a file.');
    expect(wrapper.text()).toContain('Open in fs');
    await wrapper.get('[data-testid="graph-focus"]').trigger('click');
    expect(wrapper.emitted('focus')?.[0]?.[0]).toMatchObject({ id: 'fn:fs/read' });
  });

  it('the controls change the hops, collapse a system, hide references outside and go back to everything', async () => {
    const focused: GraphQuery = { filters: [{ field: 'nodeKind', op: 'is', value: 'fn' }], focus: { node: 'fn:fs/read' } };
    const wrapper = mount(GraphControls, { props: { modelValue: focused, systems: [sys('database'), sys('fs')], focusName: 'fs/read' }, attachTo: document.body });
    const last = (): GraphQuery | undefined => {
      const all = wrapper.emitted('update:modelValue') ?? [];
      const args = all.at(-1);
      return args === undefined ? undefined : GraphQuery.parse(args[0]);
    };
    expect(wrapper.get('[data-testid=graph-focus-chip]').text()).toContain('Around fs/read');
    await wrapper.findAll('[role=radio]')[1]?.trigger('click');
    expect(last()).toEqual({ ...focused, focus: { node: 'fn:fs/read', hops: 2 } });
    await wrapper.findAll('button').find((button) => button.text() === 'Everything')?.trigger('click');
    expect(last()).toEqual({ filters: focused.filters });
    await wrapper.get('[data-testid=graph-collapse]').trigger('click');
    const item = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((el) => el.textContent.trim() === 'fs');
    expect(item).toBeDefined();
    item?.click();
    await nextTick();
    // the model holds each change: unfocused now, so the next ones build on that
    expect(last()).toEqual({ filters: focused.filters, collapse: ['fs'] });
    await wrapper.get('[data-testid=graph-external] [role=switch]').trigger('click');
    expect(last()).toEqual({ filters: focused.filters, collapse: ['fs'], external: false });
    wrapper.unmount();
    // a system's own graph has no collapse menu
    expect(mount(GraphControls, { props: { modelValue: {}, systems: [sys('fs')], scoped: true } }).find('[data-testid=graph-collapse]').exists()).toBe(false);
  });

  it('the graph list searches with the box every list has: its fields, filter only, the controls in its slot', () => {
    const fields = fieldsOf('graph');
    expect(Object.keys(fields)).toEqual(['name', 'system', 'nodeKind', 'edgeKind', 'fnKind', 'mode', 'effect', 'visibility', 'stage', 'on']);
    expect(fields['nodeKind']?.values).toContain('fn');
    expect(fields['stage']?.values).toEqual(['installed', 'live', 'pending']);
    expect(Object.values(fields).every((decl) => decl.filterable && !decl.sortable)).toBe(true);
    const search = mount(ListSearch, { props: { list: 'graph', label: 'graph items', modelValue: { text: 'read' }, noSort: true }, slots: { default: '<span class="extra-control">focus</span>' } });
    expect(search.find('.extra-control').exists()).toBe(true);
    expect(search.findComponent({ name: 'UiSort' }).exists()).toBe(false);
  });
});
