/**
 * Build 7: the graph of what systems declare and add, and how it connects. It is built from the rows the hub already
 * keeps, read through indexed queries and capped (a system's fns, context, types, kinds and instances by `system`,
 * up to its share of the cap; `fnFacts`, `fnTypes`, `fnUses` and `contextLinks` by the rows read), never a whole table:
 * - nodes: the system and its instances, fns (with their facts and examples), context items and their `/commands`,
 *   types, kinds, providers, the registries it hosts and the components it contributes
 * - edges: context links (brings, mentions, loads, offers next), fn types (reads, writes), fn uses, a fn's kind, its
 *   registry effects on a kind's fns, type references, contributions to a registry, and membership
 *
 * A focus is built outwards from its node, hop by hop, each node's neighbours read on their own. What the asked-for
 * systems reference elsewhere comes back as `external` nodes (drawn greyed). Rows past the cap, and nodes the final cap
 * cuts, become "+N more" stubs; filters and collapsing a system into one node are applied to what was read.
 */
import {
  GRAPH_EDGE_VERBS, QualifiedName, splitName, SystemName,
  linkTargetKey,
  type Audience, type ContextLink, type ContextRecord, type FnFactsRecord, type FnRecord, type FnTypeUse, type FnUse, type GraphEdge, type GraphEdgeKind, type GraphMore, type GraphNode, type GraphNodeId,
  type GraphNodeKind, type GraphPage, type GraphQuery, type InstanceRecord, type KindRecord, type LinkRelation, type Manifest, type SystemRecord, type TypeRecord,
} from '@harness/core';
import type { AccessScope } from '../access/index.ts';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { Catalog } from '../catalog/index.ts';
import { allRows, PAGE } from '../catalog/rows.ts';
import type { HubStore, Table, Where } from '../store/index.ts';

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

/** An edge, with its label from both ends' names. */
function edge(from: GraphNode | string, to: GraphNode | string, kind: GraphEdgeKind, ids: { from: GraphNodeId; to: GraphNodeId }, weight?: number): GraphEdge {
  const name = (end: GraphNode | string): string => (typeof end === 'string' ? end : end.name);
  return { from: ids.from, to: ids.to, kind, label: `${name(from)} ${GRAPH_EDGE_VERBS[kind]} ${name(to)}`, ...(weight === undefined ? {} : { weight }) };
}

/** The name in a node id. */
const nameOf = (id: GraphNodeId): string => id.slice(id.indexOf(':') + 1);

/** What one system's part of the graph is (or a neighbourhood's), before the asker's filters. */
interface Part {
  readonly nodes: Map<GraphNodeId, GraphNode>;
  readonly edges: GraphEdge[];
  /** Rows left unread past the cap, as "+N more" stubs on the node they belong to. */
  readonly more: GraphMore[];
}

/** An empty part. */
const emptyPart = (): Part => ({ nodes: new Map(), edges: [], more: [] });

/** Add one part to another. */
function merge(into: Part, part: Part): void {
  for (const [id, node] of part.nodes) { into.nodes.set(id, node); }
  into.edges.push(...part.edges);
  into.more.push(...part.more);
}

/** Up to `cap` rows matching `where`, read page by page, and how many more there are. */
async function capped<Row, Key>(table: Table<Row, Key>, where: Where<Row>, cap: number): Promise<{ rows: Row[]; hidden: number }> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  while (rows.length < cap) {
    const page = await table.find({ where, limit: Math.min(PAGE, cap - rows.length), ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...page.items);
    cursor = page.cursor;
    if (cursor === undefined) { return { rows, hidden: 0 }; }
  }
  return { rows, hidden: Math.max(0, (await table.count(where)) - rows.length) };
}

/** No rows, for a table the query's filters leave nothing of. */
const none = <Row>(): Promise<{ rows: Row[]; hidden: number }> => Promise.resolve({ rows: [], hidden: 0 });

/** "+N more" stubs on a node, one per kind with rows left unread. */
function stubs(node: GraphNodeId, counts: ReadonlyArray<readonly [GraphNodeKind, number]>): GraphMore[] {
  return counts.filter(([, count]) => count > 0).map(([kind, count]) => ({ node, kind, count }));
}

/** The fewest rows of each kind read for one system of a global graph, however many systems share the cap. */
const MIN_PER_SYSTEM = 10;

/** The node kinds a query can keep: a table whose nodes would all be filtered out is not read. */
function wanted(query: GraphQuery): (kind: GraphNodeKind) => boolean {
  const byFnFacts = query.fnKinds !== undefined || query.modes !== undefined || query.effects !== undefined;
  return (kind) => (query.nodeKinds === undefined || query.nodeKinds.includes(kind))
    && (!byFnFacts || kind === 'fn' || kind === 'system' || kind === 'kind' || kind === 'type');
}

/** A system's rows the graph reads beside its parts: its record, contract, review and switches, and its node. */
interface SystemState {
  readonly manifest: Manifest | undefined;
  readonly node: GraphNode;
  readonly stage: GraphNode['facts']['stage'];
  /** Items in its pending review, as `section\0name`. */
  readonly pending: ReadonlySet<string>;
  /** Items switched off, as `section\0name`. */
  readonly off: ReadonlySet<string>;
}

/** Each system's state, read once per query. */
type StateOf = (system: SystemName) => Promise<SystemState>;

/** The key a pending or switched-off item is kept under. */
const partKey = (section: string, name: string): string => `${section}\u0000${name}`;

/** The graph on the hub's store. */
export class HubGraph {
  readonly #deps: GraphDeps;

  constructor(deps: GraphDeps) {
    this.#deps = deps;
  }

  /**
   * The graph as `access`'s person may see it. A focus is built outwards from its node, hop by hop, each node's
   * neighbours read through the indexes that lead to it; otherwise each asked-for system (every one, for the global
   * graph) is read up to its share of the cap, the rest left as "+N more" stubs. No table is read whole.
   */
  async query(query: GraphQuery, access: AccessScope): Promise<GraphPage> {
    const limit = query.limit ?? this.#deps.limit;
    const states = new Map<SystemName, Promise<SystemState>>();
    const stateOf: StateOf = (system) => {
      const known = states.get(system);
      if (known !== undefined) { return known; }
      const loaded = this.#state(system);
      states.set(system, loaded);
      return loaded;
    };
    const built = query.focus === undefined
      ? await this.#overview(query, access, limit, stateOf)
      : await this.#around(query.focus.node, query.focus.hops ?? 1, query, access, limit, stateOf);
    const { nodes, edges } = built;
    // the ends of edges outside what was built are external: resolved one by one, greyed, unless asked not to
    if (query.external !== false) {
      for (const e of edges) {
        for (const id of [e.from, e.to]) {
          if (nodes.has(id)) { continue; }
          const found = await this.#external(id, access);
          if (found !== undefined) { nodes.set(id, found); }
        }
      }
    }
    // with systems asked for, the rest is external; the global graph and a free focus have nothing outside them
    const own = query.systems === undefined ? undefined : new Set<SystemName>(query.systems);
    for (const [id, node] of nodes) {
      const external = own !== undefined && !own.has(node.system ?? HUB_SYSTEM);
      if (external !== node.external) { nodes.set(id, { ...node, external }); }
    }
    if (query.external === false) { for (const [id, node] of nodes) { if (node.external) { nodes.delete(id); } } }
    return finish(filter(nodes, edges, query), built.more, query, limit);
  }

  /** Each asked-for system's part (every system the asker sees, for the global graph), each up to its share of the cap. */
  async #overview(query: GraphQuery, access: AccessScope, limit: number, stateOf: StateOf): Promise<Part> {
    const asked = await this.#systems(query, access);
    const out = emptyPart();
    const share = Math.max(MIN_PER_SYSTEM, Math.ceil(limit / Math.max(1, asked.length)));
    for (const system of asked) {
      const room = Math.min(share, limit - out.nodes.size);
      if (room > 0) { merge(out, await this.#part(system, access, room, wanted(query), stateOf)); continue; }
      // past the cap a system is its own node only
      const state = await stateOf(system);
      out.nodes.set(state.node.id, state.node);
    }
    return out;
  }

  /** A focus: its node and its neighbours, `hops` out, each node's neighbours read on their own. */
  async #around(focus: GraphNodeId, hops: number, query: GraphQuery, access: AccessScope, limit: number, stateOf: StateOf): Promise<Part> {
    const out = emptyPart();
    const expanded = new Set<GraphNodeId>();
    let frontier: GraphNodeId[] = [focus];
    for (let hop = 0; hop < hops && frontier.length > 0 && out.nodes.size < limit; hop += 1) {
      const next = new Set<GraphNodeId>();
      for (const id of frontier) {
        if (expanded.has(id) || out.nodes.size >= limit) { continue; }
        expanded.add(id);
        const part = await this.#neighbours(id, query, access, limit, stateOf);
        merge(out, part);
        for (const e of part.edges) { for (const end of [e.from, e.to]) { if (!expanded.has(end)) { next.add(end); } } }
      }
      frontier = [...next];
    }
    return out;
  }

  /** One node and the edges that touch it, read through the indexes that lead to it. */
  async #neighbours(id: GraphNodeId, query: GraphQuery, access: AccessScope, cap: number, stateOf: StateOf): Promise<Part> {
    const { store } = this.#deps;
    const out = emptyPart();
    const kind = id.slice(0, id.indexOf(':'));
    const name = QualifiedName.safeParse(nameOf(id)).data;
    const belongs = async (node: GraphNode): Promise<void> => {
      out.nodes.set(node.id, node);
      if (node.system === undefined) { return; }
      const state = await stateOf(node.system);
      out.nodes.set(state.node.id, state.node);
      out.edges.push(edge(node, state.node, 'belongs', { from: node.id, to: state.node.id }));
    };
    switch (kind) {
      case 'fn': {
        const fn = name === undefined ? undefined : await store.table('fns').get(name);
        if (fn === undefined || !access.seesFn(fn)) { return out; }
        const [facts, examples, state, calls, callers, types, mentions] = await Promise.all([
          store.table('fnFacts').get(fn.name), this.#exampleCounts([fn.name]), stateOf(fn.system),
          capped(store.table('fnUses'), { fn: fn.name }, cap), capped(store.table('fnUses'), { uses: fn.name }, cap),
          capped(store.table('fnTypes'), { fn: fn.name }, cap), capped(store.table('contextLinks'), { toKey: linkTargetKey({ kind: 'fn', name: fn.name }) }, cap),
        ]);
        const node = fnNode(fn, facts, examples.get(fn.name) ?? 0, { stage: state.stage, pending: state.pending.has(partKey('fns', fn.name)) }, false);
        await belongs(node);
        out.edges.push(...fnEdges(fn, node, facts));
        for (const use of [...calls.rows, ...callers.rows]) {
          const caller = use.fn === fn.name ? fn : await store.table('fns').get(use.fn);
          out.edges.push(useEdge(use, caller?.decl.deps.includes(use.uses) === true));
        }
        for (const use of types.rows) { out.edges.push(typeUseEdge(use)); }
        for (const link of mentions.rows) { const e = linkEdge(link); if (e !== undefined) { out.edges.push(e); } }
        out.more.push(...stubs(node.id, [['fn', calls.hidden + callers.hidden], ['type', types.hidden], ['context', mentions.hidden]]));
        return out;
      }
      case 'type': {
        const type = name === undefined ? undefined : await store.table('types').get(name);
        if (type === undefined || !access.seesType(type)) { return out; }
        const [state, users] = await Promise.all([stateOf(type.system), capped(store.table('fnTypes'), { type: type.name }, cap)]);
        const node = typeNode(type, state.stage, state.pending.has(partKey('types', type.name)));
        await belongs(node);
        out.edges.push(...typeEdges(type, node));
        for (const use of users.rows) { out.edges.push(typeUseEdge(use)); }
        out.more.push(...stubs(node.id, [['fn', users.hidden]]));
        return out;
      }
      case 'context': {
        const item = name === undefined ? undefined : await store.table('context').get(name);
        if (item === undefined || !access.seesContext(item)) { return out; }
        const [links, linked, state] = await Promise.all([
          capped(store.table('contextLinks'), { from: item.name }, cap), capped(store.table('contextLinks'), { toKey: linkTargetKey({ kind: 'context', name: item.name }) }, cap),
          item.system === HUB_SYSTEM ? Promise.resolve(undefined) : stateOf(item.system),
        ]);
        const node = contextNode(item, state?.stage, state?.pending.has(partKey('context', item.name)) === true);
        await belongs(node);
        if (state !== undefined) { merge(out, commandOf(item, node, state)); }
        for (const link of [...links.rows, ...linked.rows]) { const e = linkEdge(link); if (e !== undefined) { out.edges.push(e); } }
        out.more.push(...stubs(node.id, [['context', links.hidden + linked.hidden]]));
        return out;
      }
      case 'kind': {
        const found = name === undefined ? undefined : await store.table('kinds').get(name);
        if (found === undefined || !access.seesSystem(found.system)) { return out; }
        const [state, made] = await Promise.all([stateOf(found.system), capped(store.table('fnFacts'), { kind: found.name }, cap)]);
        const node = kindNodeIn(found, state);
        await belongs(node);
        for (const facts of made.rows) { out.edges.push(edge(facts.fn, found.name, 'kind', { from: nodeId('fn', facts.fn), to: node.id })); }
        out.more.push(...stubs(node.id, [['fn', made.hidden]]));
        return out;
      }
      default: {
        // a system, or a part only its system's rows say more of (an instance, command, provider, registry, component)
        const system = await this.#systemOfNode(id);
        if (system === undefined || !access.seesSystem(system)) { return out; }
        return this.#part(system, access, cap, wanted(query), stateOf);
      }
    }
  }

  /** The systems asked for (each one the asker may see), or every system for the global graph. */
  async #systems(query: GraphQuery, access: AccessScope): Promise<SystemName[]> {
    if (query.systems !== undefined) { return query.systems.filter((system) => access.seesSystem(system)); }
    // the system directory: one row per system, each drawn as a node in the global graph
    const rows = await allRows(this.#deps.store.table('systems'));
    return rows.filter((row) => row.status !== 'removed' && access.seesSystem(row.name)).map((row) => row.name);
  }

  /** A system's record, contract, review and switches, and its node. */
  async #state(system: SystemName): Promise<SystemState> {
    const { store, catalog } = this.#deps;
    const [record, manifest, review, switches] = await Promise.all([
      store.table('systems').get(system), catalog.manifest(system), store.table('systemReviews').get(system), allRows(store.table('itemSwitches'), { system }),
    ]);
    return {
      manifest, node: systemNodeOf(system, record, manifest), stage: record?.stage ?? (system === HUB_SYSTEM ? undefined : 'live'),
      pending: new Set((review?.pending?.changes ?? []).filter((c) => c.change !== 'removed').map((c) => partKey(c.section, c.name))),
      off: new Set(switches.map((s) => partKey(s.section, s.name))),
    };
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


  /** One system's nodes and edges as the asker may see them: each kind of row read up to `cap`, the rest as stubs. */
  async #part(system: SystemName, access: AccessScope, cap: number, wants: (kind: GraphNodeKind) => boolean, stateOf: StateOf): Promise<Part> {
    const { store } = this.#deps;
    const [state, fns, context, types, kinds, instances] = await Promise.all([
      stateOf(system),
      wants('fn') ? capped(store.table('fns'), { system }, cap) : none<FnRecord>(),
      wants('context') || wants('command') ? capped(store.table('context'), { system }, cap) : none<ContextRecord>(),
      wants('type') ? capped(store.table('types'), { system }, cap) : none<TypeRecord>(),
      wants('kind') ? capped(store.table('kinds'), { system }, cap) : none<KindRecord>(),
      wants('instance') ? capped(store.table('instances'), { system }, cap) : none<InstanceRecord>(),
    ]);
    const out = emptyPart();
    const systemNode = state.node;
    out.nodes.set(systemNode.id, systemNode);
    const put = (node: GraphNode): GraphNode => {
      out.nodes.set(node.id, node);
      out.edges.push(edge(node, systemNode, 'belongs', { from: node.id, to: systemNode.id }));
      return node;
    };
    const flags = (section: string, name: string): { stage: SystemState['stage']; pending: boolean } => ({ stage: state.stage, pending: state.pending.has(partKey(section, name)) });
    out.more.push(...stubs(systemNode.id, [['fn', fns.hidden], ['context', context.hidden], ['type', types.hidden], ['kind', kinds.hidden], ['instance', instances.hidden]]));

    for (const row of instances.rows) {
      if (row.status === 'removed') { continue; }
      put({ id: nodeId('instance', `${system}/${row.instance}`), kind: 'instance', name: `${system}/${row.instance}`, about: row.description, system, external: false, facts: { on: row.status === 'connected' } });
    }
    const seenFns = fns.rows.filter((fn) => access.seesFn(fn));
    const fnNames = seenFns.map((fn) => fn.name);
    if (fnNames.length > 0) {
      const [facts, examples, uses, typeUses] = await Promise.all([
        allRows(store.table('fnFacts'), { fn: { in: fnNames } }), this.#exampleCounts(fnNames),
        allRows(store.table('fnUses'), { fn: { in: fnNames } }), allRows(store.table('fnTypes'), { fn: { in: fnNames } }),
      ]);
      const factsOf = new Map(facts.map((f) => [f.fn, f]));
      const byName = new Map(seenFns.map((fn) => [fn.name, fn]));
      for (const fn of seenFns) {
        const node = put(fnNode(fn, factsOf.get(fn.name), examples.get(fn.name) ?? 0, flags('fns', fn.name), false));
        out.edges.push(...fnEdges(fn, node, factsOf.get(fn.name)));
      }
      for (const use of uses) { out.edges.push(useEdge(use, byName.get(use.fn)?.decl.deps.includes(use.uses) === true)); }
      for (const use of typeUses) { out.edges.push(typeUseEdge(use)); }
    }
    const seenContext = context.rows.filter((item) => access.seesContext(item));
    for (const item of seenContext) { merge(out, commandOf(item, put(contextNode(item, state.stage, state.pending.has(partKey('context', item.name)))), state)); }
    const names = seenContext.map((item) => item.name);
    if (names.length > 0) {
      for (const link of await allRows(store.table('contextLinks'), { from: { in: names } })) { const e = linkEdge(link); if (e !== undefined) { out.edges.push(e); } }
    }
    for (const type of types.rows) {
      if (access.seesType(type)) { out.edges.push(...typeEdges(type, put(typeNode(type, state.stage, state.pending.has(partKey('types', type.name)))))); }
    }
    for (const kind of kinds.rows) { put(kindNodeIn(kind, state)); }
    const manifest = state.manifest;
    for (const decl of wants('provider') ? manifest?.providers ?? [] : []) {
      const name = `${system}/${decl.name}`;
      put({ id: nodeId('provider', name), kind: 'provider', name, about: decl.description, system, external: false, facts: { on: !state.off.has(partKey('providers', name)), ...flags('providers', name) } });
    }
    for (const decl of wants('registry') ? manifest?.registries ?? [] : []) {
      const name = `${system}/${decl.name}`;
      put({ id: nodeId('registry', name), kind: 'registry', name, about: decl.description, system, external: false, facts: { on: !state.off.has(partKey('registries', name)), ...flags('registries', name) } });
    }
    for (const decl of wants('component') ? manifest?.contributes ?? [] : []) {
      const name = `${decl.registry}: ${decl.label}`;
      const node = put({ id: nodeId('component', `${system}/${decl.name}`), kind: 'component', name, about: decl.description ?? decl.label, system, external: false, facts: { on: !state.off.has(partKey('components', name)), ...flags('components', name) } });
      out.edges.push(edge(node, decl.registry, 'contributes', { from: node.id, to: nodeId('registry', decl.registry) }));
    }
    return out;
  }

  /** How many examples each fn keeps (collapsed into the fn's node). */
  async #exampleCounts(fns: readonly QualifiedName[]): Promise<Map<QualifiedName, number>> {
    const out = new Map<QualifiedName, number>();
    if (fns.length === 0) { return out; }
    for (const row of await allRows(this.#deps.store.table('fnExamples'), { fn: { in: [...fns] } })) { out.set(row.fn, (out.get(row.fn) ?? 0) + 1); }
    return out;
  }
}

/** A fn's own edges: its kind, and its registry effects on a kind's fns. */
function fnEdges(fn: FnRecord, node: GraphNode, facts: FnFactsRecord | undefined): GraphEdge[] {
  const out: GraphEdge[] = [];
  if (fn.decl.kind !== 'native') { out.push(edge(node, fn.decl.kind, 'kind', { from: node.id, to: nodeId('kind', fn.decl.kind) })); }
  for (const effect of facts?.registry ?? fn.decl.effects?.registry ?? []) {
    if (effect.kind === undefined || effect.kind === 'native') { continue; }
    const verb = effect.action === 'create' ? 'creates' : effect.action === 'update' ? 'updates' : 'removes';
    out.push(edge(node, `${effect.kind} fns`, verb, { from: node.id, to: nodeId('kind', effect.kind) }));
  }
  return out;
}

/** A fn using another: `calls` when the user declared it in its deps, else `uses`. */
function useEdge(use: FnUse, declared: boolean): GraphEdge {
  return edge(use.fn, use.uses, declared ? 'calls' : 'uses', { from: nodeId('fn', use.fn), to: nodeId('fn', use.uses) });
}

/** A fn reading or writing a type. */
function typeUseEdge(use: FnTypeUse): GraphEdge {
  return edge(use.fn, use.type, use.use === 'read' ? 'reads' : 'writes', { from: nodeId('fn', use.fn), to: nodeId('type', use.type) });
}

/** A context link drawn as an edge, when its relation is one the graph draws. */
function linkEdge(link: ContextLink): GraphEdge | undefined {
  const kind = LINK_EDGES[link.relation];
  if (kind === undefined || link.to.kind === 'resource') { return undefined; }
  return edge(link.from, link.to.name, kind, { from: nodeId('context', link.from), to: nodeId(link.to.kind, link.to.name) }, link.source === 'declared' ? undefined : link.weight);
}

/** The types a type refers to. */
function typeEdges(type: TypeRecord, node: GraphNode): GraphEdge[] {
  return type.references.filter((ref) => ref !== type.name).map((ref) => edge(node, ref, 'refers', { from: node.id, to: nodeId('type', ref) }));
}

/** A context item's `/command`, as a node belonging to the item. */
function commandOf(item: ContextRecord, node: GraphNode, state: SystemState): Part {
  const out = emptyPart();
  const command = item.decl.command;
  if (command === undefined || item.system === HUB_SYSTEM) { return out; }
  const name = `/${command.name}`;
  const commandNode: GraphNode = {
    id: nodeId('command', `${item.system}:${name}`), kind: 'command', name, about: item.decl.description, system: item.system, external: false,
    facts: { on: node.facts.on && !state.off.has(partKey('commands', name)), visibility: item.decl.suggest, stage: state.stage, pending: state.pending.has(partKey('commands', name)) },
  };
  out.nodes.set(commandNode.id, commandNode);
  out.edges.push(edge(commandNode, node, 'belongs', { from: commandNode.id, to: node.id }));
  return out;
}

/** A kind's node, on or off by its switch. */
function kindNodeIn(kind: KindRecord, state: SystemState): GraphNode {
  const pending = state.pending.has(partKey('kinds', kind.name));
  return { ...kindNode(kind, state.stage, pending), facts: { on: !state.off.has(partKey('kinds', kind.name)), stage: state.stage, pending } };
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
function filter(all: ReadonlyMap<GraphNodeId, GraphNode>, allEdges: readonly GraphEdge[], query: GraphQuery): Pick<Part, 'nodes' | 'edges'> {
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

/**
 * Collapse systems into one node each, then cap the nodes, leaving "+N more" stubs for the neighbours cut and for the
 * rows never read (`unread`, on the nodes they belong to).
 */
function finish(part: Pick<Part, 'nodes' | 'edges'>, unread: readonly GraphMore[], query: GraphQuery, limit: number): GraphPage {
  let nodes = part.nodes;
  let edges = part.edges;
  const into = new Map<GraphNodeId, GraphNodeId>();
  if (query.collapse !== undefined) {
    const collapsed = new Set(query.collapse);
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
  const unseen = unread.reduce((sum, stub) => sum + stub.count, 0);
  const total = { nodes: nodes.size + unseen, edges: edges.length };
  // the unread stubs on the nodes shown, one per node and kind
  const unreadOn = (shown: ReadonlyMap<GraphNodeId, GraphNode>): GraphMore[] => {
    const out = new Map<string, GraphMore>();
    for (const stub of unread) {
      const node = into.get(stub.node) ?? stub.node;
      if (!shown.has(node)) { continue; }
      const key = `${node} ${stub.kind}`;
      out.set(key, { node, kind: stub.kind, count: (out.get(key)?.count ?? 0) + stub.count });
    }
    return [...out.values()];
  };
  if (nodes.size <= limit) { return { nodes: [...nodes.values()], edges, more: unreadOn(nodes), total }; }
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
  const more: GraphMore[] = [...unreadOn(kept), ...[...cut.values()].map((entry) => ({ node: entry.node, kind: entry.kind, count: entry.ids.size }))];
  return { nodes: [...kept.values()], edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)), more, total };
}
