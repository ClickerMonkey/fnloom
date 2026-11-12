/**
 * The graph pages' rules, kept apart from the drawing so they are tested without a canvas: the graph query read from
 * and written to the URL (one comma-separated key per filter), what hovering a node or an edge says, where opening a
 * node goes, and the elements handed to the graph library (a cluster per system, external references greyed, "+N
 * more" stubs that expand the neighbourhood they stand for).
 */
import {
  Audience, FnKindName, FnMode, GRAPH_EDGE_KINDS, GRAPH_NODE_KINDS, GraphEdgeKind, GraphNodeId, GraphNodeKind, GraphQuery, InstanceName, QualifiedName, RegistryThing, SystemName,
  SystemStage, type GraphEdge, type GraphMore, type GraphNode, type GraphPage,
} from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import type { z } from 'zod';
import { links } from '../../app/routes.ts';
import { GRAPH_URL_KEYS, GraphUrl } from '../url.ts';

export { GRAPH_URL_KEYS, GraphUrl, type GraphUrlKey } from '../url.ts';

/** Each node kind as a person reads it, one and many. */
export const NODE_KIND_LABELS = {
  system: ['System', 'systems'],
  instance: ['Instance', 'instances'],
  fn: ['Fn', 'fns'],
  context: ['Context', 'context items'],
  type: ['Type', 'types'],
  kind: ['Fn kind', 'fn kinds'],
  resource: ['Resource', 'resources'],
  root: ['Root', 'roots'],
  component: ['Component', 'components'],
  registry: ['Registry', 'registries'],
  command: ['Command', 'commands'],
  provider: ['Provider', 'providers'],
} as const satisfies Record<GraphNodeKind, readonly [string, string]>;

/** Each edge kind as a filter names it. */
export const EDGE_KIND_LABELS = {
  brings: 'Brings', names: 'Mentions', loads: 'Loads', next: 'Offers next', reads: 'Reads', writes: 'Writes', calls: 'Calls', uses: 'Depends on',
  kind: 'Is of kind', creates: 'Creates', updates: 'Updates', removes: 'Removes', refers: 'Refers to', renders: 'Renders', contributes: 'Contributes to',
  belongs: 'Belongs to',
} as const satisfies Record<GraphEdgeKind, string>;

/** Each stage filter as a person reads it. */
export const STAGE_LABELS = { live: 'Live', installed: 'Installed, not live', pending: 'Waiting for review' } as const;

/** Each node kind's colour, light and dark, from one categorical palette (the graph library needs plain colours). */
export const NODE_KIND_COLORS = {
  system: ['#4b5563', '#9ca3af'],
  instance: ['#6b7280', '#a1a1aa'],
  fn: ['#2a78d6', '#5b9cf0'],
  context: ['#15936a', '#34c08c'],
  type: ['#e3572b', '#f08a5d'],
  kind: ['#8b5cf6', '#a78bfa'],
  resource: ['#0e9aa7', '#38bdc9'],
  root: ['#4d7c0f', '#a3e635'],
  component: ['#c026d3', '#e879f9'],
  registry: ['#4f46e5', '#818cf8'],
  command: ['#a16207', '#eab308'],
  provider: ['#be123c', '#fb7185'],
} as const satisfies Record<GraphNodeKind, readonly [string, string]>;

/** The graph keys of a page's URL query: the string values, without any key whose value can't be read. */
export function readGraphUrl(query: Readonly<Record<string, unknown>>): GraphUrl {
  const raw = Object.fromEntries(GRAPH_URL_KEYS.flatMap((key) => { const value = query[key]; return typeof value === 'string' ? [[key, value] as const] : []; }));
  const parsed = GraphUrl.safeParse(raw);
  if (parsed.success) { return parsed.data; }
  const bad = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
  return GraphUrl.parse(Object.fromEntries(Object.entries(raw).filter(([key]) => !bad.has(key))));
}

/** The values of a comma-separated list that `item` accepts, in order and once each; undefined when none are. */
function listOf<T extends z.ZodType>(text: string | undefined, item: T): Array<z.output<T>> | undefined {
  if (text === undefined || text === '') { return undefined; }
  const kept = new Set<z.output<T>>();
  for (const part of text.split(',')) {
    const parsed = item.safeParse(part.trim());
    if (parsed.success) { kept.add(parsed.data); }
  }
  return kept.size === 0 ? undefined : [...kept];
}

/** The URL keys that hold a comma-separated list. */
type ListKey = 'systems' | 'nodes' | 'edges' | 'fnKinds' | 'modes' | 'effects' | 'visibility' | 'stages' | 'collapse';

/** The stage filter's values (a system stage, or waiting in a pending review), as the graph query declares them. */
const StageFilter = GraphQuery.shape.stages.unwrap().element;
/** Every stage filter value, in the order the filters offer them. */
const STAGE_CHOICES = [...SystemStage.options, 'pending'] as const satisfies ReadonlyArray<z.output<typeof StageFilter>>;

/** How many hops out a focus reaches, as the URL writes it. */
const HopsText = GraphUrl.shape.hops.unwrap();

/** The graph query the page's URL describes; values it can't read are left out. */
export function graphQueryOf(url: GraphUrl): GraphQuery {
  const query: GraphQuery = {};
  const systems = listOf(url.systems, SystemName);
  if (systems !== undefined) { query.systems = systems; }
  if (url.external === '0') { query.external = false; }
  const nodeKinds = listOf(url.nodes, GraphNodeKind);
  if (nodeKinds !== undefined) { query.nodeKinds = nodeKinds; }
  const edgeKinds = listOf(url.edges, GraphEdgeKind);
  if (edgeKinds !== undefined) { query.edgeKinds = edgeKinds; }
  const fnKinds = listOf(url.fnKinds, FnKindName);
  if (fnKinds !== undefined) { query.fnKinds = fnKinds; }
  const modes = listOf(url.modes, FnMode);
  if (modes !== undefined) { query.modes = modes; }
  const effects = listOf(url.effects, RegistryThing);
  if (effects !== undefined) { query.effects = effects; }
  const visibility = listOf(url.visibility, Audience);
  if (visibility !== undefined) { query.visibility = visibility; }
  const stages = listOf(url.stages, StageFilter);
  if (stages !== undefined) { query.stages = stages; }
  if (url.on !== undefined) { query.on = url.on === '1'; }
  const collapse = listOf(url.collapse, SystemName);
  if (collapse !== undefined) { query.collapse = collapse; }
  const text = url.q?.trim() ?? '';
  if (text !== '') { query.text = text.slice(0, 200); }
  const focus = GraphNodeId.safeParse(url.focus);
  if (focus.success) { query.focus = url.hops === undefined ? { node: focus.data } : { node: focus.data, hops: Number(url.hops) }; }
  return GraphQuery.parse(query);
}

/** The URL query that describes a graph query (the inverse of `graphQueryOf`); empty keys are left out. */
export function graphUrlOf(query: GraphQuery): GraphUrl {
  const url: GraphUrl = {};
  const join = (values: readonly string[] | undefined): string | undefined => (values === undefined || values.length === 0 ? undefined : values.join(','));
  const lists: ReadonlyArray<readonly [ListKey, readonly string[] | undefined]> = [
    ['systems', query.systems], ['nodes', query.nodeKinds], ['edges', query.edgeKinds], ['fnKinds', query.fnKinds], ['modes', query.modes],
    ['effects', query.effects], ['visibility', query.visibility], ['stages', query.stages], ['collapse', query.collapse],
  ];
  for (const [key, values] of lists) {
    const joined = join(values);
    if (joined !== undefined) { url[key] = joined; }
  }
  if (query.external === false) { url.external = '0'; }
  if (query.on !== undefined) { url.on = query.on ? '1' : '0'; }
  if (query.text !== undefined) { url.q = query.text; }
  if (query.focus !== undefined) {
    url.focus = query.focus.node;
    const hops = HopsText.safeParse(String(query.focus.hops ?? 1));
    if (hops.success && hops.data !== '1') { url.hops = hops.data; }
  }
  return url;
}

/** How many filters a query sets (the system scope, search and focus not counted). */
export function filterCount(query: GraphQuery): number {
  const lists = [query.nodeKinds, query.edgeKinds, query.fnKinds, query.modes, query.effects, query.visibility, query.stages, query.collapse];
  return lists.filter((list) => list !== undefined && list.length > 0).length + (query.on === undefined ? 0 : 1) + (query.external === false ? 1 : 0);
}

/** A query with one part changed, or removed when `value` is undefined or an empty list. */
export function withPart<K extends keyof GraphQuery>(query: GraphQuery, key: K, value: NonNullable<GraphQuery[K]> | undefined): GraphQuery {
  const next: GraphQuery = { ...query };
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    Reflect.deleteProperty(next, key);
  } else {
    next[key] = value;
  }
  return next;
}

/** One line of what hovering a node shows: a label and its value. */
export interface FactLine {
  readonly label: string;
  readonly value: string;
}

const VISIBILITY_WORDS = { user: 'People only', llm: 'Models only', both: 'People and models', none: 'Hidden' } as const satisfies Record<Audience, string>;

/** What hovering a node shows beside its name, kind and description: only the facts that apply to it. */
export function nodeFacts(node: GraphNode): FactLine[] {
  const { facts } = node;
  const lines: FactLine[] = [];
  if (node.collapsed !== undefined) { lines.push({ label: 'Stands for', value: `${node.collapsed} items` }); }
  if (facts.fnKind !== undefined) { lines.push({ label: 'Fn kind', value: fnKindLabel(facts.fnKind) }); }
  if (facts.mode !== undefined) { lines.push({ label: 'Mode', value: facts.mode }); }
  if (facts.effects !== undefined && facts.effects.length > 0) {
    lines.push({ label: 'Effects', value: facts.effects.map((effect) => `${effect.action} ${effect.kind === undefined ? effect.thing : `${effect.kind} fns`}`).join(', ') });
  }
  if (facts.reads !== undefined && facts.reads.length > 0) { lines.push({ label: 'Reads', value: facts.reads.join(', ') }); }
  if (facts.writes !== undefined && facts.writes.length > 0) { lines.push({ label: 'Writes', value: facts.writes.join(', ') }); }
  if (facts.visibility !== undefined) { lines.push({ label: 'Visible to', value: VISIBILITY_WORDS[facts.visibility] }); }
  if (facts.examples !== undefined && facts.examples > 0) { lines.push({ label: 'Examples', value: String(facts.examples) }); }
  const stage = facts.pending === true ? STAGE_LABELS.pending : facts.stage === undefined ? undefined : STAGE_LABELS[facts.stage];
  lines.push({ label: 'State', value: [facts.on ? 'On' : 'Off', ...(stage === undefined ? [] : [stage])].join(' · ') });
  if (node.external) { lines.push({ label: 'From', value: node.system === undefined ? 'the hub' : `${node.system} (outside this view)` }); }
  return lines;
}

/** A fn kind as filters and details name it: the built-in `native` reads "Native", the rest by their own name. */
export const fnKindLabel = (kind: string): string => (kind === 'native' ? 'Native' : kind);

/** A registry thing as the effects filter names it ("Context"). */
export const effectLabel = (thing: string): string => `${thing.charAt(0).toUpperCase()}${thing.slice(1)}`;

/** A node's kind as its heading names it. */
export const kindLabel = (kind: GraphNodeKind): string => NODE_KIND_LABELS[kind][0];

/** What a "+N more" stub says. */
export function moreLabel(more: GraphMore): string {
  const [one, many] = NODE_KIND_LABELS[more.kind];
  return `+${more.count} ${more.count === 1 ? one.toLowerCase() : many}`;
}

/** Where opening a node goes: fns open in the fn modal, everything else on its page. */
export type OpenTarget = { readonly type: 'fn'; readonly fn: QualifiedName } | { readonly type: 'page'; readonly to: RouteLocationRaw };

/** Where opening a node goes; a greyed node opens in its own system. */
export function openTarget(node: GraphNode): OpenTarget {
  const fn = QualifiedName.safeParse(node.name);
  if (node.kind === 'fn' && fn.success) { return { type: 'fn', fn: fn.data }; }
  if (node.kind === 'context' && fn.success) { return { type: 'page', to: links.contextItem(fn.data) }; }
  const system = node.system;
  if (system === undefined) { return { type: 'page', to: node.kind === 'context' ? links.context() : links.resources() }; }
  switch (node.kind) {
    case 'system': return { type: 'page', to: links.system(system, node.collapsed === undefined ? 'overview' : 'graph') };
    case 'instance': {
      const instance = InstanceName.safeParse(node.name.slice(system.length + 1));
      return { type: 'page', to: instance.success ? links.instance(system, instance.data) : links.system(system, 'instances') };
    }
    case 'type': return { type: 'page', to: links.system(system, 'types') };
    case 'context': return { type: 'page', to: links.system(system, 'context') };
    case 'fn': case 'kind': case 'resource': case 'root': case 'component': case 'registry': case 'command': case 'provider':
      return { type: 'page', to: links.system(system, 'parts') };
  }
}

/** The systems a page draws, own first, in name order. */
export function systemsOf(page: GraphPage): SystemName[] {
  return [...new Set(page.nodes.flatMap((node) => (node.system === undefined ? [] : [node.system])))].sort();
}

/** A cluster's id: the box drawn around one system's nodes. */
export const clusterId = (system: SystemName): string => `cluster:${system}`;
/** A "+N more" stub's id. */
export const moreId = (more: GraphMore): string => `more:${more.node}:${more.kind}`;

/** What the graph library is handed for one node, cluster or stub. */
export interface NodeElement {
  readonly group: 'nodes';
  readonly data: { readonly id: string; readonly label: string; readonly kind: GraphNodeKind | 'cluster' | 'more'; readonly parent?: string };
  readonly classes: string;
}

/** What the graph library is handed for one edge. */
export interface EdgeElement {
  readonly group: 'edges';
  readonly data: { readonly id: string; readonly source: string; readonly target: string; readonly kind: GraphEdgeKind | 'more'; readonly label: string };
  readonly classes: string;
}

/** The short name drawn on a node: the part after its system (the cluster names the system). */
export function shortName(node: GraphNode): string {
  if (node.kind === 'system' || node.system === undefined || node.external) { return node.name; }
  for (const sep of ['/', '.', ':']) {
    const prefix = `${node.system}${sep}`;
    if (node.name.startsWith(prefix)) { return node.name.slice(prefix.length); }
  }
  return node.name;
}

/**
 * The elements to draw: a cluster per system holding its nodes (when more than one system shows, or always with
 * `clusters`), the edges among them, and a stub per "+N more" tied to the node it hangs off.
 */
export function graphElements(page: GraphPage, options: { readonly clusters?: boolean } = {}): Array<NodeElement | EdgeElement> {
  const systems = systemsOf(page);
  const clustered = options.clusters === true || systems.length > 1;
  const elements: Array<NodeElement | EdgeElement> = [];
  if (clustered) {
    // a collapsed system is one node of its own: no box around it
    const boxed = systems.filter((system) => page.nodes.some((node) => node.system === system && node.collapsed === undefined));
    for (const system of boxed) {
      const own = page.nodes.some((node) => node.system === system && !node.external);
      elements.push({ group: 'nodes', data: { id: clusterId(system), label: system, kind: 'cluster' }, classes: own ? 'cluster' : 'cluster external' });
    }
  }
  for (const node of page.nodes) {
    const parent = clustered && node.system !== undefined && node.collapsed === undefined ? clusterId(node.system) : undefined;
    const classes = [`kind-${node.kind}`, ...(node.external ? ['external'] : []), ...(node.facts.on ? [] : ['off']), ...(node.facts.pending === true ? ['pending'] : []), ...(node.collapsed === undefined ? [] : ['collapsed'])];
    elements.push({ group: 'nodes', data: { id: node.id, label: node.collapsed === undefined ? shortName(node) : `${node.name} (${node.collapsed})`, kind: node.kind, ...(parent === undefined ? {} : { parent }) }, classes: classes.join(' ') });
  }
  page.edges.forEach((edge, at) => {
    elements.push({ group: 'edges', data: { id: `edge:${at}`, source: edge.from, target: edge.to, kind: edge.kind, label: edge.label }, classes: `edge-${edge.kind}${edge.weight === undefined ? '' : ' weighted'}` });
  });
  const known = new Set(page.nodes.map((node) => node.id));
  for (const more of page.more) {
    if (!known.has(more.node)) { continue; }
    const id = moreId(more);
    const hangs = page.nodes.find((node) => node.id === more.node);
    const parent = clustered && hangs?.system !== undefined && hangs.collapsed === undefined ? clusterId(hangs.system) : undefined;
    elements.push({ group: 'nodes', data: { id, label: moreLabel(more), kind: 'more', ...(parent === undefined ? {} : { parent }) }, classes: 'more' });
    elements.push({ group: 'edges', data: { id: `edge:${id}`, source: more.node, target: id, kind: 'more', label: `${moreLabel(more)} left out; open it to see them` }, classes: 'edge-more' });
  }
  return elements;
}

/** What a selected or hovered element is: a node, an edge, or a "+N more" stub. */
export type GraphPick =
  | { readonly type: 'node'; readonly node: GraphNode }
  | { readonly type: 'edge'; readonly edge: GraphEdge; readonly from: GraphNode | undefined; readonly to: GraphNode | undefined }
  | { readonly type: 'more'; readonly more: GraphMore };

/** Find what an element id stands for in a page. */
export function pickOf(page: GraphPage, id: string): GraphPick | undefined {
  const node = page.nodes.find((n) => n.id === id);
  if (node !== undefined) { return { type: 'node', node }; }
  const more = page.more.find((m) => moreId(m) === id);
  if (more !== undefined) { return { type: 'more', more }; }
  const at = /^edge:(\d+)$/.exec(id)?.[1];
  const edge = at === undefined ? undefined : page.edges[Number(at)];
  if (edge === undefined) { return undefined; }
  return { type: 'edge', edge, from: page.nodes.find((n) => n.id === edge.from), to: page.nodes.find((n) => n.id === edge.to) };
}

/** The query that expands a "+N more" stub: the same filters, focused on the node it hangs off. */
export const expandQuery = (query: GraphQuery, more: GraphMore): GraphQuery => ({ ...query, focus: { node: more.node, hops: query.focus?.hops ?? 1 } });

/** Every node kind, edge kind, mode, visibility and stage the filters offer. */
export const FILTER_CHOICES = {
  nodeKinds: GRAPH_NODE_KINDS,
  edgeKinds: GRAPH_EDGE_KINDS,
  modes: FnMode.options,
  visibility: Audience.options,
  stages: STAGE_CHOICES,
  effects: RegistryThing.options,
} as const;

/** A laid-out group's size (a system's cluster, or the nodes outside any), in graph units. */
export interface GroupSize {
  readonly width: number;
  readonly height: number;
}

/** Where a group's top-left corner goes. */
export interface GroupPlace {
  readonly x: number;
  readonly y: number;
}

/**
 * Place groups in rows so none overlaps: tallest first, each row filled left to right up to a width that makes the
 * whole about as wide as the box it is drawn in (`aspect`, width over height), with `gap` between groups and rows.
 * Each group keeps its own layout; only where it sits changes. The places come back in the groups' order.
 */
export function packGroups(groups: readonly GroupSize[], options: { readonly aspect: number; readonly gap: number }): GroupPlace[] {
  const { gap } = options;
  const aspect = Number.isFinite(options.aspect) && options.aspect > 0 ? options.aspect : 1;
  const area = groups.reduce((sum, group) => sum + (group.width + gap) * (group.height + gap), 0);
  const widest = groups.reduce((most, group) => Math.max(most, group.width), 0);
  const rowWidth = Math.max(widest, Math.sqrt(area * aspect));
  const order = groups.map((group, at) => ({ group, at })).sort((a, b) => b.group.height - a.group.height || a.at - b.at);
  const places: GroupPlace[] = groups.map(() => ({ x: 0, y: 0 }));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const { group, at } of order) {
    if (x > 0 && x + group.width > rowWidth) {
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    places[at] = { x, y };
    x += group.width + gap;
    rowHeight = Math.max(rowHeight, group.height);
  }
  return places;
}
