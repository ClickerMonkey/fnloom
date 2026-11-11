/**
 * Build 7: the graph of what systems declare and add, and how it connects. It is built from the rows the hub already
 * keeps, read per system through indexed queries (fns, context, types and kinds by `system`; `fnFacts` by system;
 * `fnTypes`, `fnUses` and `contextLinks` by the fns and items asked about), never by loading every table:
 * - nodes: the system and its instances, fns (with their facts and examples), context items and their `/commands`,
 *   types, kinds, providers, the registries it hosts and the components it contributes
 * - edges: context links (brings, mentions, loads, offers next), fn types (reads, writes), fn uses, a fn's kind, its
 *   registry effects on a kind's fns, type references, contributions to a registry, and membership
 *
 * What the asked-for systems reference elsewhere comes back as `external` nodes (drawn greyed). Filters, a focus with
 * hops, collapsing a system into one node, and a cap with "+N more" stubs are applied after, for the asker's view.
 */
import {
  GRAPH_EDGE_VERBS, QualifiedName, splitName, SystemName,
  type Audience, type ContextRecord, type FnFactsRecord, type FnRecord, type GraphEdge, type GraphEdgeKind, type GraphMore, type GraphNode, type GraphNodeId,
  type GraphNodeKind, type GraphPage, type GraphQuery, type KindRecord, type LinkRelation, type Manifest, type SystemRecord, type TypeRecord,
} from '@harness/core';
import type { AccessScope } from '../access/index.ts';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { Catalog } from '../catalog/index.ts';
import { allRows } from '../catalog/rows.ts';
import type { HubStore } from '../store/index.ts';

/** What the graph reads. */
export interface GraphDeps {
  readonly store: HubStore;
  readonly catalog: Pick<Catalog, 'manifest'>;
  /** The most nodes an answer holds when the query doesn't say (`HARNESS_GRAPH_LIMIT`). */
  readonly limit: number;
}

/** The context link relations drawn, as edge kinds; the rest (parent, related, about, learned) are the contextor's. */
const LINK_EDGES: Partial<Record<LinkRelation, GraphEdgeKind>> = { brings: 'brings', mentions: 'names', imports: 'loads', next: 'next', suggests: 'next' };

/** The order nodes are kept in when the cap cuts: the most telling kinds first. */
const KIND_ORDER: readonly GraphNodeKind[] = ['system', 'fn', 'context', 'type', 'kind', 'command', 'component', 'registry', 'provider', 'resource', 'root', 'instance'];

/** A node's id from its kind and name. */
export const nodeId = (kind: GraphNodeKind, name: string): GraphNodeId => `${kind}:${name}`;

/** What one system's part of the graph is, before the asker's filters. */
interface Part {
  readonly nodes: Map<GraphNodeId, GraphNode>;
  readonly edges: GraphEdge[];
}

/** An edge, with its label from both ends' names. */
function edge(from: GraphNode | string, to: GraphNode | string, kind: GraphEdgeKind, ids: { from: GraphNodeId; to: GraphNodeId }, weight?: number): GraphEdge {
  const name = (end: GraphNode | string): string => (typeof end === 'string' ? end : end.name);
  return { from: ids.from, to: ids.to, kind, label: `${name(from)} ${GRAPH_EDGE_VERBS[kind]} ${name(to)}`, ...(weight === undefined ? {} : { weight }) };
}

/** The name in a node id. */
const nameOf = (id: GraphNodeId): string => id.slice(id.indexOf(':') + 1);

/** The graph on the hub's store. */
export class HubGraph {
  readonly #deps: GraphDeps;

  constructor(deps: GraphDeps) {
    this.#deps = deps;
  }

  /** The graph as `access`'s person may see it. */
  async query(query: GraphQuery, access: AccessScope): Promise<GraphPage> {
    const asked = await this.#systems(query, access);
    const parts = new Map<SystemName, Part>();
    const nodes = new Map<GraphNodeId, GraphNode>();
    const edges: GraphEdge[] = [];
    const add = async (system: SystemName): Promise<void> => {
      if (parts.has(system)) { return; }
      const part = await this.#part(system, access);
      parts.set(system, part);
      for (const [id, node] of part.nodes) { nodes.set(id, node); }
      edges.push(...part.edges);
    };
    for (const system of asked) { await add(system); }
    // a focus reaches into the systems its neighbourhood touches, hop by hop
    if (query.focus !== undefined) {
      const focusSystem = await this.#systemOfNode(query.focus.node);
      if (focusSystem !== undefined && access.seesSystem(focusSystem)) { await add(focusSystem); }
      for (let hop = 0; hop < (query.focus.hops ?? 1); hop += 1) {
        const near = reach(query.focus.node, edges, hop + 1);
        for (const id of near) {
          const system = nodes.get(id)?.system ?? await this.#systemOfNode(id);
          if (system !== undefined && access.seesSystem(system) && query.systems === undefined) { await add(system); }
        }
      }
    }
    const own = new Set(query.systems ?? [...parts.keys()]);
    // the ends of edges outside what was built are external: resolved one by one, greyed, unless asked not to
    for (const e of edges) {
      for (const id of [e.from, e.to]) {
        if (nodes.has(id) || query.external === false) { continue; }
        const found = await this.#external(id, access);
        if (found !== undefined) { nodes.set(id, found); }
      }
    }
    for (const [id, node] of nodes) {
      const external = node.system === undefined ? !own.has(HUB_SYSTEM) : !own.has(node.system);
      if (external !== node.external) { nodes.set(id, { ...node, external }); }
    }
    if (query.external === false) { for (const [id, node] of nodes) { if (node.external) { nodes.delete(id); } } }
    return finish(filter(nodes, edges, query), query, query.limit ?? this.#deps.limit);
  }

  /** The systems asked for (each one the asker may see), or every system for the global graph. */
  async #systems(query: GraphQuery, access: AccessScope): Promise<SystemName[]> {
    if (query.systems !== undefined) { return query.systems.filter((system) => access.seesSystem(system)); }
    if (query.focus !== undefined) { return []; }
    const rows = await allRows(this.#deps.store.table('systems'));
    return rows.filter((row) => row.status !== 'removed' && access.seesSystem(row.name)).map((row) => row.name);
  }

  /** The system a node belongs to, from its id. */
  async #systemOfNode(id: GraphNodeId): Promise<SystemName | undefined> {
    const kind = id.slice(0, id.indexOf(':'));
    const name = nameOf(id);
    if (kind === 'system') { return SystemName.safeParse(name).data; }
    const qualified = QualifiedName.safeParse(kind === 'component' ? name.split(':')[0] ?? name : name).data;
    if (qualified === undefined) { return undefined; }
    if (kind === 'context') { return (await this.#deps.store.table('context').get(qualified))?.system; }
    return SystemName.safeParse(splitName(qualified).system).data;
  }

  /** A node in a system not asked for, as the asker may see it (undefined when they may not, or it is gone). */
  async #external(id: GraphNodeId, access: AccessScope): Promise<GraphNode | undefined> {
    const { store } = this.#deps;
    const kind = id.slice(0, id.indexOf(':'));
    const name = nameOf(id);
    const base = { id, external: true, facts: { on: true } };
    const qualified = QualifiedName.safeParse(name).data;
    if (kind !== 'system' && qualified === undefined) { return undefined; }
    switch (kind) {
      case 'fn': {
        const fn = qualified === undefined ? undefined : await store.table('fns').get(qualified);
        return fn === undefined || !access.seesFn(fn) ? undefined : fnNode(fn, undefined, 0, { stage: undefined, pending: false }, true);
      }
      case 'context': {
        const item = qualified === undefined ? undefined : await store.table('context').get(qualified);
        return item === undefined || !access.seesContext(item) ? undefined : { ...contextNode(item, undefined, false), external: true };
      }
      case 'type': {
        const type = qualified === undefined ? undefined : await store.table('types').get(qualified);
        return type === undefined || !access.seesType(type) ? undefined : { ...typeNode(type, undefined, false), external: true };
      }
      case 'kind': {
        const found = qualified === undefined ? undefined : await store.table('kinds').get(qualified);
        return found === undefined || !access.seesSystem(found.system) ? undefined : { ...kindNode(found, undefined, false), external: true };
      }
      case 'system': {
        const system = SystemName.safeParse(name).data;
        return system === undefined || !access.seesSystem(system) ? undefined : { ...base, kind: 'system', name: system, about: '', system };
      }
      case 'registry': {
        const system = qualified === undefined ? undefined : SystemName.safeParse(splitName(qualified).system).data;
        return system === undefined || !access.seesSystem(system) ? undefined : { ...base, kind: 'registry', name, about: '', system };
      }
      default: return undefined;
    }
  }

  /** One system's nodes and edges, as the asker may see them. */
  async #part(system: SystemName, access: AccessScope): Promise<Part> {
    const { store, catalog } = this.#deps;
    const [record, manifest, fns, facts, context, types, kinds, review, instances, switches] = await Promise.all([
      store.table('systems').get(system), catalog.manifest(system), allRows(store.table('fns'), { system }), allRows(store.table('fnFacts'), { system }),
      allRows(store.table('context'), { system }), allRows(store.table('types'), { system }), allRows(store.table('kinds'), { system }),
      store.table('systemReviews').get(system), allRows(store.table('instances'), { system }), allRows(store.table('itemSwitches'), { system }),
    ]);
    const stage = record?.stage ?? (system === HUB_SYSTEM ? undefined : 'live');
    const pending = new Set((review?.pending?.changes ?? []).filter((c) => c.change !== 'removed').map((c) => `${c.section}\u0000${c.name}`));
    const off = new Set(switches.map((s) => `${s.section}\u0000${s.name}`));
    const state = (section: string, name: string): { stage: typeof stage; pending: boolean } => ({ stage, pending: pending.has(`${section}\u0000${name}`) });
    const nodes = new Map<GraphNodeId, GraphNode>();
    const edges: GraphEdge[] = [];
    const put = (node: GraphNode): GraphNode => { nodes.set(node.id, node); return node; };
    const systemNode = put(systemNodeOf(system, record, manifest));
    const belongs = (node: GraphNode): void => { edges.push(edge(node, systemNode, 'belongs', { from: node.id, to: systemNode.id })); };

    for (const row of instances) {
      if (row.status === 'removed') { continue; }
      const node = put({ id: nodeId('instance', `${system}/${row.instance}`), kind: 'instance', name: `${system}/${row.instance}`, about: row.description, system, external: false, facts: { on: row.status === 'connected' } });
      belongs(node);
    }
    const factsOf = new Map(facts.map((f) => [f.fn, f]));
    const seenFns = fns.filter((fn) => access.seesFn(fn));
    const exampleCounts = await this.#exampleCounts(seenFns.map((fn) => fn.name));
    for (const fn of seenFns) {
      const node = put(fnNode(fn, factsOf.get(fn.name), exampleCounts.get(fn.name) ?? 0, state('fns', fn.name), false));
      belongs(node);
      if (fn.decl.kind !== 'native') { edges.push(edge(node, fn.decl.kind, 'kind', { from: node.id, to: nodeId('kind', fn.decl.kind) })); }
      for (const effect of factsOf.get(fn.name)?.registry ?? fn.decl.effects?.registry ?? []) {
        if (effect.kind === undefined || effect.kind === 'native') { continue; }
        const verb = effect.action === 'create' ? 'creates' : effect.action === 'update' ? 'updates' : 'removes';
        edges.push(edge(node, `${effect.kind} fns`, verb, { from: node.id, to: nodeId('kind', effect.kind) }));
      }
    }
    const fnNames = seenFns.map((fn) => fn.name);
    if (fnNames.length > 0) {
      const [uses, typeUses] = await Promise.all([
        allRows(store.table('fnUses'), { fn: { in: fnNames } }), allRows(store.table('fnTypes'), { fn: { in: fnNames } }),
      ]);
      for (const use of uses) {
        const declared = fns.find((fn) => fn.name === use.fn)?.decl.deps.includes(use.uses) === true;
        edges.push(edge(use.fn, use.uses, declared ? 'calls' : 'uses', { from: nodeId('fn', use.fn), to: nodeId('fn', use.uses) }));
      }
      for (const use of typeUses) { edges.push(edge(use.fn, use.type, use.use === 'read' ? 'reads' : 'writes', { from: nodeId('fn', use.fn), to: nodeId('type', use.type) })); }
    }
    const seenContext = context.filter((item) => access.seesContext(item));
    for (const item of seenContext) {
      const node = put(contextNode(item, stage, pending.has(`context\u0000${item.name}`)));
      belongs(node);
      const command = item.decl.command;
      if (command !== undefined) {
        const name = `/${command.name}`;
        const commandNode = put({
          id: nodeId('command', `${system}:${name}`), kind: 'command', name, about: item.decl.description, system, external: false,
          facts: { on: node.facts.on && !off.has(`commands\u0000${name}`), visibility: item.decl.suggest, ...state('commands', name) },
        });
        edges.push(edge(commandNode, node, 'belongs', { from: commandNode.id, to: node.id }));
      }
    }
    const names = seenContext.map((item) => item.name);
    if (names.length > 0) {
      for (const link of await allRows(store.table('contextLinks'), { from: { in: names } })) {
        const kind = LINK_EDGES[link.relation];
        if (kind === undefined || link.to.kind === 'resource') { continue; }
        edges.push(edge(link.from, link.to.name, kind, { from: nodeId('context', link.from), to: nodeId(link.to.kind, link.to.name) }, link.source === 'declared' ? undefined : link.weight));
      }
    }
    for (const type of types) {
      if (!access.seesType(type)) { continue; }
      const node = put(typeNode(type, stage, pending.has(`types\u0000${type.name}`)));
      belongs(node);
      for (const ref of type.references) { if (ref !== type.name) { edges.push(edge(node, ref, 'refers', { from: node.id, to: nodeId('type', ref) })); } }
    }
    for (const kind of kinds) {
      const node = put({ ...kindNode(kind, stage, pending.has(`kinds\u0000${kind.name}`)), facts: { on: !off.has(`kinds\u0000${kind.name}`), ...state('kinds', kind.name) } });
      belongs(node);
    }
    for (const decl of manifest?.providers ?? []) {
      const name = `${system}/${decl.name}`;
      belongs(put({ id: nodeId('provider', name), kind: 'provider', name, about: decl.description, system, external: false, facts: { on: !off.has(`providers\u0000${name}`), ...state('providers', name) } }));
    }
    for (const decl of manifest?.registries ?? []) {
      const name = `${system}/${decl.name}`;
      belongs(put({ id: nodeId('registry', name), kind: 'registry', name, about: decl.description, system, external: false, facts: { on: !off.has(`registries\u0000${name}`), ...state('registries', name) } }));
    }
    for (const decl of manifest?.contributes ?? []) {
      const name = `${decl.registry}: ${decl.label}`;
      const node = put({ id: nodeId('component', `${system}/${decl.name}`), kind: 'component', name, about: decl.description ?? decl.label, system, external: false, facts: { on: !off.has(`components\u0000${name}`), ...state('components', name) } });
      belongs(node);
      edges.push(edge(node, decl.registry, 'contributes', { from: node.id, to: nodeId('registry', decl.registry) }));
    }
    return { nodes, edges };
  }

  /** How many examples each fn keeps (collapsed into the fn's node). */
  async #exampleCounts(fns: readonly QualifiedName[]): Promise<Map<QualifiedName, number>> {
    const out = new Map<QualifiedName, number>();
    if (fns.length === 0) { return out; }
    for (const row of await allRows(this.#deps.store.table('fnExamples'), { fn: { in: [...fns] } })) { out.set(row.fn, (out.get(row.fn) ?? 0) + 1); }
    return out;
  }
}

/** A system's node. */
function systemNodeOf(system: SystemName, record: SystemRecord | undefined, manifest: Manifest | undefined): GraphNode {
  return {
    id: nodeId('system', system), kind: 'system', name: system, about: manifest?.description ?? record?.description ?? '', system, external: false,
    facts: { on: record === undefined ? system === HUB_SYSTEM : record.enabled.functions && record.status !== 'removed', ...(record === undefined ? {} : { stage: record.stage ?? 'live' }) },
  };
}

/** A fn's node, with its facts. */
function fnNode(fn: FnRecord, facts: FnFactsRecord | undefined, examples: number, state: { stage: GraphNode['facts']['stage']; pending: boolean }, external: boolean): GraphNode {
  const effects = facts?.registry ?? fn.decl.effects?.registry ?? [];
  const reads = facts?.reads ?? fn.decl.effects?.reads ?? [];
  const writes = facts?.writes ?? fn.decl.effects?.writes ?? [];
  const mode = facts?.mode ?? fn.decl.effects?.mode;
  const visibility: Audience = fn.decl.visibility;
  return {
    id: nodeId('fn', fn.name), kind: 'fn', name: fn.name, about: fn.decl.description, system: fn.system, external,
    facts: {
      fnKind: fn.decl.kind, ...(mode === undefined ? {} : { mode }), ...(effects.length === 0 ? {} : { effects: [...effects] }),
      ...(reads.length === 0 ? {} : { reads: [...reads] }), ...(writes.length === 0 ? {} : { writes: [...writes] }), visibility,
      on: !fn.disabled && fn.available === true, ...(state.stage === undefined ? {} : { stage: state.stage }), ...(state.pending ? { pending: true } : {}),
      ...(examples > 0 ? { examples } : {}),
    },
  };
}

/** A context item's node; the hub's own (memories, resources) have no system. */
function contextNode(item: ContextRecord, stage: GraphNode['facts']['stage'], pending: boolean): GraphNode {
  const off = item.disabled === true || item.systemOff === true;
  return {
    id: nodeId('context', item.name), kind: 'context', name: item.name, about: item.decl.description, ...(item.system === HUB_SYSTEM ? {} : { system: item.system }), external: false,
    facts: { visibility: item.decl.suggest, on: !off, ...(stage === undefined ? {} : { stage }), ...(pending ? { pending: true } : {}) },
  };
}

/** A type's node. */
function typeNode(type: TypeRecord, stage: GraphNode['facts']['stage'], pending: boolean): GraphNode {
  return { id: nodeId('type', type.name), kind: 'type', name: type.name, about: type.description, system: type.system, external: false, facts: { on: true, ...(stage === undefined ? {} : { stage }), ...(pending ? { pending: true } : {}) } };
}

/** A kind's node. */
function kindNode(kind: KindRecord, stage: GraphNode['facts']['stage'], pending: boolean): GraphNode {
  return { id: nodeId('kind', kind.name), kind: 'kind', name: kind.name, about: kind.decl.description, system: kind.system, external: false, facts: { on: true, ...(stage === undefined ? {} : { stage }), ...(pending ? { pending: true } : {}) } };
}

/** The nodes within `hops` of a node, over edges either way (the node itself included). */
export function reach(start: GraphNodeId, edges: readonly GraphEdge[], hops: number): Set<GraphNodeId> {
  const seen = new Set<GraphNodeId>([start]);
  let frontier = [start];
  for (let hop = 0; hop < hops && frontier.length > 0; hop += 1) {
    const next: GraphNodeId[] = [];
    for (const e of edges) {
      const pairs: Array<[GraphNodeId, GraphNodeId]> = [[e.from, e.to], [e.to, e.from]];
      for (const [a, b] of pairs) { if (frontier.includes(a) && !seen.has(b)) { seen.add(b); next.push(b); } }
    }
    frontier = next;
  }
  return seen;
}

/** Whether a node passes the query's node filters (fn filters apply to fns only). */
function passes(node: GraphNode, query: GraphQuery): boolean {
  if (query.nodeKinds !== undefined && !query.nodeKinds.includes(node.kind)) { return false; }
  const { facts } = node;
  if (node.kind === 'fn') {
    if (query.fnKinds !== undefined && (facts.fnKind === undefined || !query.fnKinds.includes(facts.fnKind))) { return false; }
    if (query.modes !== undefined && (facts.mode === undefined || !query.modes.includes(facts.mode))) { return false; }
    if (query.effects !== undefined && !(facts.effects ?? []).some((effect) => query.effects?.includes(effect.thing) === true)) { return false; }
  } else if (query.fnKinds !== undefined || query.modes !== undefined || query.effects !== undefined) {
    // filtering by fn facts keeps the fns and what they belong to
    if (node.kind !== 'system' && node.kind !== 'kind' && node.kind !== 'type') { return false; }
  }
  if (query.visibility !== undefined && facts.visibility !== undefined && !query.visibility.includes(facts.visibility)) { return false; }
  if (query.stages !== undefined) {
    const stages: string[] = [...(facts.stage === undefined ? [] : [facts.stage]), ...(facts.pending === true ? ['pending'] : [])];
    if (!query.stages.some((stage) => stages.includes(stage))) { return false; }
  }
  if (query.on !== undefined && facts.on !== query.on) { return false; }
  if (query.text !== undefined) {
    const text = query.text.toLowerCase();
    if (!node.name.toLowerCase().includes(text) && !node.about.toLowerCase().includes(text)) { return false; }
  }
  return true;
}

/** The nodes and edges left after the query's filters and its focus, edges only among nodes kept. */
function filter(all: ReadonlyMap<GraphNodeId, GraphNode>, allEdges: readonly GraphEdge[], query: GraphQuery): Part {
  const nodes = new Map([...all].filter(([, node]) => passes(node, query)));
  const unique = new Map<string, GraphEdge>();
  for (const e of allEdges) {
    if (query.edgeKinds !== undefined && !query.edgeKinds.includes(e.kind)) { continue; }
    if (nodes.has(e.from) && nodes.has(e.to) && e.from !== e.to) { unique.set(`${e.from}\u0000${e.kind}\u0000${e.to}`, e); }
  }
  let edges = [...unique.values()];
  if (query.focus !== undefined) {
    const near = reach(query.focus.node, edges, query.focus.hops ?? 1);
    for (const id of nodes.keys()) { if (!near.has(id)) { nodes.delete(id); } }
    edges = edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
  }
  return { nodes, edges };
}

/** Collapse systems into one node each, then cap the nodes, leaving "+N more" stubs for the neighbours cut. */
function finish(part: Part, query: GraphQuery, limit: number): GraphPage {
  let nodes = part.nodes;
  let edges = part.edges;
  if (query.collapse !== undefined) {
    const collapsed = new Set(query.collapse);
    const into = new Map<GraphNodeId, GraphNodeId>();
    const counts = new Map<SystemName, number>();
    for (const node of nodes.values()) {
      if (node.system === undefined || !collapsed.has(node.system)) { continue; }
      into.set(node.id, nodeId('system', node.system));
      counts.set(node.system, (counts.get(node.system) ?? 0) + 1);
    }
    const next = new Map([...nodes].filter(([id]) => !into.has(id)));
    for (const [system, count] of counts) {
      const id = nodeId('system', system);
      const was = nodes.get(id);
      next.set(id, { ...(was ?? { id, kind: 'system', name: system, about: '', system, external: false, facts: { on: true } }), collapsed: count });
    }
    const unique = new Map<string, GraphEdge>();
    for (const e of edges) {
      const from = into.get(e.from) ?? e.from;
      const to = into.get(e.to) ?? e.to;
      if (from === to) { continue; }
      const key = `${from}\u0000${e.kind}\u0000${to}`;
      if (!unique.has(key)) { unique.set(key, from === e.from && to === e.to ? e : edge(next.get(from) ?? nameOf(from), next.get(to) ?? nameOf(to), e.kind, { from, to })); }
    }
    nodes = next;
    edges = [...unique.values()];
  }
  const total = { nodes: nodes.size, edges: edges.length };
  if (nodes.size <= limit) { return { nodes: [...nodes.values()], edges, more: [], total }; }
  // keep the focus and its nearest first, then by kind, own before external
  const near = query.focus === undefined ? undefined : reach(query.focus.node, edges, query.focus.hops ?? 1);
  const rank = (node: GraphNode): number => (near?.has(node.id) === true ? 0 : 1000) + (node.external ? 100 : 0) + KIND_ORDER.indexOf(node.kind);
  const kept = new Map([...nodes.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, limit).map((node) => [node.id, node]));
  // each kept node's cut neighbours, counted once per kind
  const cut = new Map<string, { node: GraphNodeId; kind: GraphNodeKind; ids: Set<GraphNodeId> }>();
  for (const e of edges) {
    const pairs: Array<[GraphNodeId, GraphNodeId]> = [[e.from, e.to], [e.to, e.from]];
    for (const [here, there] of pairs) {
      const dropped = nodes.get(there);
      if (!kept.has(here) || kept.has(there) || dropped === undefined) { continue; }
      const key = `${here}\u0000${dropped.kind}`;
      const entry = cut.get(key) ?? { node: here, kind: dropped.kind, ids: new Set<GraphNodeId>() };
      entry.ids.add(there);
      cut.set(key, entry);
    }
  }
  const more: GraphMore[] = [...cut.values()].map((entry) => ({ node: entry.node, kind: entry.kind, count: entry.ids.size }));
  return { nodes: [...kept.values()], edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)), more, total };
}
