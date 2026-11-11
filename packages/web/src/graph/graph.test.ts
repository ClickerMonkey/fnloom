/**
 * The graphs (build 7): the URL query both ways, hover facts, where opening goes, the drawn elements (clusters, greyed
 * references, "+N more" stubs), the store on the fake caller, the sample graph's filters, and the details and filter
 * components alone. Drawing and hovering are checked rendered, in `ui-tests/features/build7-graph.ts`.
 */
import { SystemName, type GraphNode, type GraphQuery } from '@harness/core';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { fakeGraphApi } from './test/fakes.ts';
import GraphDetails from './components/GraphDetails.vue';
import GraphChips from './components/GraphChips.vue';
import {
  clusterId, expandQuery, filterCount, graphElements, graphQueryOf, graphUrlOf, moreId, nodeFacts, openTarget, pickOf, readGraphUrl, shortName, withPart,
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
  it('reads every filter and writes it back the same', () => {
    const url = { systems: 'fs,database', nodes: 'fn,type', edges: 'reads', modes: 'write', stages: 'pending', on: '0', collapse: 'database', q: 'file', focus: 'fn:fs/read', hops: '2', external: '0' } as const;
    const query = graphQueryOf(url);
    expect(query).toEqual({
      systems: ['fs', 'database'], external: false, nodeKinds: ['fn', 'type'], edgeKinds: ['reads'], modes: ['write'], stages: ['pending'], on: false,
      collapse: [sys('database')], text: 'file', focus: { node: 'fn:fs/read', hops: 2 },
    });
    expect(graphUrlOf(query)).toEqual(url);
    expect(filterCount(query)).toBe(7);
  });

  it('drops values it cannot read, and keys whose values are wrong', () => {
    expect(graphQueryOf({ nodes: 'fn,bogus,fn', modes: 'nope' })).toEqual({ nodeKinds: ['fn'] });
    expect(readGraphUrl({ hops: '9', q: 'x', part: 'roots', on: ['1'] })).toEqual({ q: 'x' });
    expect(graphUrlOf({ focus: { node: 'fn:fs/read', hops: 1 } })).toEqual({ focus: 'fn:fs/read' });
  });

  it('changes one part, and removes it when empty', () => {
    const query: GraphQuery = { nodeKinds: ['fn'] };
    expect(withPart(query, 'modes', ['read'])).toEqual({ nodeKinds: ['fn'], modes: ['read'] });
    expect(withPart(query, 'nodeKinds', [])).toEqual({});
    expect(expandQuery(query, { node: 'fn:fs/read', kind: 'type', count: 3 })).toEqual({ nodeKinds: ['fn'], focus: { node: 'fn:fs/read', hops: 1 } });
  });
});

describe('what a node says and where it opens', () => {
  it('lists only the facts that apply', () => {
    const lines = Object.fromEntries(nodeFacts(nodeOf('fn:fs/write')).map((line) => [line.label, line.value]));
    expect(lines).toEqual({ 'Fn kind': 'native', Mode: 'write', Writes: 'fs/file', 'Visible to': 'People and models', Examples: '2', State: 'On · Live' });
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
    expect(graphOf({ nodeKinds: ['type'] }).nodes.every((node) => node.kind === 'type')).toBe(true);
    const near = graphOf({ focus: { node: 'type:fs/file', hops: 1 } }).nodes.map((node) => node.id).sort();
    expect(near).toEqual(['fn:fs/read', 'fn:fs/write', 'system:fs', 'type:fs/file']);
    expect(graphOf({ text: 'note', modes: ['write'] }).nodes.map((node) => node.id)).toEqual(['system:notes', 'fn:notes/add', 'type:notes/note']);
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

  it('toggles chips in the order offered', async () => {
    const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] as const;
    const wrapper = mount(GraphChips, { props: { label: 'Kinds', options, modelValue: ['b'] } });
    await wrapper.findAll('button')[0]?.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual(['a', 'b']);
  });
});
