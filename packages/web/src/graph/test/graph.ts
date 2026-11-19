/**
 * A sample graph of three systems and the hub's own memory, answering the graph query the way the hub does in small:
 * the systems asked for with what they reference elsewhere greyed (`external`), the query standard's filters and words, a focus
 * N hops out, collapsing a system into one node, and the cap with "+N more" stubs. The web tests' fake callers and the
 * mock hub both answer from it. Nodes and edges are written as their schemas' inputs, so a schema change breaks them.
 */
import {
  GRAPH_EDGE_VERBS, GraphEdge, GraphNode, GraphPage, type GraphEdgeKind, type GraphMore, type GraphNodeFacts, type GraphNodeId, type GraphNodeKind, type GraphQuery,
  type Filter,
} from '@harness/core';
import type { z } from 'zod';

/** A node: its kind, name, system and description, with its facts (on, unless said). */
function node(kind: GraphNodeKind, name: string, system: string | undefined, about: string, facts: Partial<z.input<typeof GraphNode>['facts']> = {}): GraphNode {
  const stage = system === 'notes' ? 'installed' : 'live';
  return GraphNode.parse({ id: `${kind}:${name}`, kind, name, about, ...(system === undefined ? {} : { system }), external: false, facts: { on: true, stage, ...facts } });
}

const fn = (name: string, about: string, facts: Partial<GraphNodeFacts> = {}): GraphNode => node('fn', name, name.split('/')[0], about, { fnKind: 'native', mode: 'read', visibility: 'both', ...facts });

/** Every node of the sample. */
export const SAMPLE_NODES: readonly GraphNode[] = [
  node('system', 'fs', 'fs', 'Files on this machine, and writing and installing systems.'),
  node('instance', 'fs/main', 'fs', 'The main fs instance.'),
  fn('fs/read', 'Read a file.', { reads: ['fs/file'], examples: 3 }),
  fn('fs/write', 'Write a file.', { mode: 'write', writes: ['fs/file'], examples: 2 }),
  fn('fs/install_system', 'Build a system folder, run its tests and ask to install it.', { mode: 'write', effects: [{ thing: 'fns', action: 'create' }], visibility: 'llm' }),
  node('context', 'fs/authoring', 'fs', 'How to write a system: layout, contract, tests.'),
  node('context', 'fs/authoring.kinds', 'fs', 'Fn kinds and how a system declares one.'),
  node('command', '/files', 'fs', 'Browse the files.'),
  node('type', 'fs/file', 'fs', 'A file: its path, size and text.'),
  node('root', 'fs/home', 'fs', 'The home folder.'),
  node('system', 'database', 'database', 'Tables, queries and the fns made from them.'),
  fn('database/query', 'Run a saved query.', { fnKind: 'database/query', reads: ['database/main.projects'], examples: 4 }),
  fn('database/create_query', 'Write a query from a description and save it as a fn.', { mode: 'write', effects: [{ thing: 'fns', action: 'create', kind: 'database/query' }] }),
  node('kind', 'database/query', 'database', 'A saved query, called as a fn.'),
  node('type', 'database/main.projects', 'database', 'Projects: id, name, owner, value.'),
  node('type', 'database/main.owners', 'database', 'Owners: id, name.'),
  node('context', 'database/guide', 'database', 'How the tables relate and which fns to use.'),
  node('component', 'database/table', 'database', 'Shows rows as a table.'),
  node('registry', 'database/renderers', 'database', 'Renderers for query results.'),
  node('system', 'notes', 'notes', 'Short notes, written from the chat.', { stage: 'installed' }),
  fn('notes/add', 'Add a note.', { mode: 'write', writes: ['notes/note'], pending: true }),
  fn('notes/list', 'List the notes.', { reads: ['notes/note'], on: false }),
  node('type', 'notes/note', 'notes', 'A note: its title and text.'),
  node('context', 'notes/howto', 'notes', 'When to write a note.'),
  node('component', 'notes/NoteCard', 'notes', 'One note as a card.'),
  node('context', 'memory/likes-short-answers', undefined, 'The owner likes short answers.', { stage: undefined }),
];

/** An edge, labelled from both ends' names. */
function edge(from: GraphNodeId, kind: GraphEdgeKind, to: GraphNodeId, weight?: number): GraphEdge {
  const name = (id: GraphNodeId): string => SAMPLE_NODES.find((n) => n.id === id)?.name ?? id.slice(id.indexOf(':') + 1);
  return GraphEdge.parse({ from, to, kind, label: `${name(from)} ${GRAPH_EDGE_VERBS[kind]} ${name(to)}`, ...(weight === undefined ? {} : { weight }) });
}

/** Every edge of the sample. */
export const SAMPLE_EDGES: readonly GraphEdge[] = [
  ...SAMPLE_NODES.filter((n) => n.kind !== 'system' && n.system !== undefined).map((n) => edge(n.id, 'belongs', `system:${n.system ?? ''}`)),
  edge('context:fs/authoring', 'brings', 'fn:fs/install_system'),
  edge('context:fs/authoring', 'loads', 'context:fs/authoring.kinds'),
  edge('context:fs/authoring.kinds', 'brings', 'fn:database/create_query'),
  edge('context:fs/authoring.kinds', 'names', 'kind:database/query', 0.6),
  edge('fn:fs/read', 'reads', 'type:fs/file'),
  edge('fn:fs/write', 'writes', 'type:fs/file'),
  edge('fn:fs/install_system', 'calls', 'fn:fs/write'),
  edge('fn:database/query', 'kind', 'kind:database/query'),
  edge('fn:database/query', 'reads', 'type:database/main.projects'),
  edge('fn:database/create_query', 'creates', 'kind:database/query'),
  edge('type:database/main.projects', 'refers', 'type:database/main.owners'),
  edge('context:database/guide', 'brings', 'fn:database/query'),
  edge('context:database/guide', 'next', 'context:fs/authoring', 0.4),
  edge('component:database/table', 'contributes', 'registry:database/renderers'),
  edge('component:database/table', 'renders', 'type:database/main.projects'),
  edge('fn:notes/add', 'writes', 'type:notes/note'),
  edge('fn:notes/add', 'uses', 'fn:fs/write'),
  edge('fn:notes/list', 'reads', 'type:notes/note'),
  edge('context:notes/howto', 'brings', 'fn:notes/add'),
  edge('component:notes/NoteCard', 'renders', 'type:notes/note'),
  edge('context:memory/likes-short-answers', 'names', 'context:notes/howto', 0.3),
];

/** What a graph field reads off a node, for the sample's filters (the hub's `GRAPH_FIELDS`, in small). */
function reading(n: GraphNode, field: string): ReadonlyArray<string | boolean> {
  const { facts } = n;
  switch (field) {
    case 'name': return [n.name];
    case 'system': return n.system === undefined ? [] : [n.system];
    case 'nodeKind': return [n.kind];
    case 'fnKind': return facts.fnKind === undefined ? [] : [facts.fnKind];
    case 'mode': return facts.mode === undefined ? [] : [facts.mode];
    case 'effect': return (facts.effects ?? []).map((effect) => effect.thing);
    case 'visibility': return facts.visibility === undefined ? [] : [facts.visibility];
    case 'stage': return [...(facts.stage === undefined ? [] : [facts.stage]), ...(facts.pending === true ? ['pending'] : [])];
    case 'on': return [facts.on];
    default: return [];
  }
}

/** Whether readings pass a filter (the ops the graph's fields take). */
function holds(values: ReadonlyArray<string | boolean>, filter: Filter): boolean {
  switch (filter.op) {
    case 'is': return values.some((value) => value === filter.value);
    case 'isNot': return !values.some((value) => value === filter.value);
    case 'in': return values.some((value) => filter.values.includes(value));
    case 'notIn': return !values.some((value) => filter.values.includes(value));
    case 'contains': return values.some((value) => String(value).toLowerCase().includes(String(filter.value).toLowerCase()));
    case 'empty': return values.length === 0;
    case 'notEmpty': return values.length > 0;
    case 'gt': case 'gte': case 'lt': case 'lte': case 'between': return true;
  }
}

const FN_FACTS = new Set(['fnKind', 'mode', 'effect']);

/** Whether a node passes the query's filters and words (fn facts test fns and keep what they hang off), as the hub does. */
function passes(n: GraphNode, query: GraphQuery): boolean {
  for (const filter of query.filters ?? []) {
    if (filter.field === 'edgeKind') { continue; }
    if (FN_FACTS.has(filter.field) && n.kind !== 'fn') { if (n.kind === 'system' || n.kind === 'kind' || n.kind === 'type') { continue; } return false; }
    if (filter.field === 'visibility' && n.facts.visibility === undefined) { continue; }
    if (!holds(reading(n, filter.field), filter)) { return false; }
  }
  const words = query.text?.toLowerCase().split(/\s+/).filter((word) => word !== '') ?? [];
  const text = `${n.name} ${n.about} ${n.kind} ${n.system ?? ''}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Whether an edge passes the query's `edgeKind` filters. */
const edgePasses = (e: GraphEdge, query: GraphQuery): boolean => (query.filters ?? []).every((filter) => filter.field !== 'edgeKind' || holds([e.kind], filter));

/** The nodes within `hops` of a node, over edges either way. */
function reach(start: GraphNodeId, edges: readonly GraphEdge[], hops: number): Set<GraphNodeId> {
  const seen = new Set([start]);
  let frontier = [start];
  for (let hop = 0; hop < hops; hop += 1) {
    const next = edges.flatMap((e) => [[e.from, e.to], [e.to, e.from]] as const).filter(([a, b]) => frontier.includes(a) && !seen.has(b)).map(([, b]) => b);
    for (const id of next) { seen.add(id); }
    frontier = next;
  }
  return seen;
}

/** Answer a graph query from the sample, as the hub would. */
export function graphOf(query: GraphQuery, nodes: readonly GraphNode[] = SAMPLE_NODES, allEdges: readonly GraphEdge[] = SAMPLE_EDGES): GraphPage {
  const asked = query.systems;
  let kept = new Map<GraphNodeId, GraphNode>();
  for (const n of nodes) { if (asked === undefined || (n.system !== undefined && asked.includes(n.system))) { kept.set(n.id, n); } }
  if (asked !== undefined && query.external !== false) {
    const own = new Set(kept.keys());
    for (const e of allEdges) {
      for (const [here, there] of [[e.from, e.to], [e.to, e.from]] as const) {
        const other = nodes.find((n) => n.id === there);
        if (own.has(here) && !kept.has(there) && other !== undefined && other.kind !== 'system') { kept.set(there, { ...other, external: true }); }
      }
    }
  }
  kept = new Map([...kept].filter(([, n]) => passes(n, query)));
  let edges = allEdges.filter((e) => kept.has(e.from) && kept.has(e.to) && edgePasses(e, query));
  if (query.focus !== undefined) {
    const near = reach(query.focus.node, edges, query.focus.hops ?? 1);
    kept = new Map([...kept].filter(([id]) => near.has(id)));
    edges = edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  }
  if (query.collapse !== undefined) {
    const into = new Map<GraphNodeId, GraphNodeId>();
    for (const n of kept.values()) { if (n.system !== undefined && query.collapse.includes(n.system)) { into.set(n.id, `system:${n.system}`); } }
    for (const system of query.collapse) {
      const id: GraphNodeId = `system:${system}`;
      const count = [...into.values()].filter((to) => to === id).length;
      const was = nodes.find((n) => n.id === id);
      if (count > 0 && was !== undefined) { kept.set(id, { ...was, collapsed: count }); }
    }
    for (const id of into.keys()) { if (into.get(id) !== id) { kept.delete(id); } }
    const unique = new Map<string, GraphEdge>();
    for (const e of edges) {
      const from = into.get(e.from) ?? e.from;
      const to = into.get(e.to) ?? e.to;
      if (from !== to) { unique.set(`${from} ${e.kind} ${to}`, from === e.from && to === e.to ? e : edge(from, e.kind, to)); }
    }
    edges = [...unique.values()];
  }
  const total = { nodes: kept.size, edges: edges.length };
  const limit = query.limit ?? 200;
  if (kept.size <= limit) { return GraphPage.parse({ nodes: [...kept.values()], edges, more: [], total }); }
  const shown = new Map([...kept].slice(0, limit));
  const cut = new Map<string, GraphMore>();
  for (const e of edges) {
    for (const [here, there] of [[e.from, e.to], [e.to, e.from]] as const) {
      const dropped = kept.get(there);
      if (!shown.has(here) || shown.has(there) || dropped === undefined) { continue; }
      const key = `${here} ${dropped.kind}`;
      const was = cut.get(key);
      cut.set(key, { node: here, kind: dropped.kind, count: (was?.count ?? 0) + 1 });
    }
  }
  return GraphPage.parse({ nodes: [...shown.values()], edges: edges.filter((e) => shown.has(e.from) && shown.has(e.to)), more: [...cut.values()], total });
}
