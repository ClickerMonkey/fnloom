/**
 * Build 7: the graph of everything systems declare and add, and how it connects, built from the relations the hub
 * already records (context links, fn facts, fn uses, kinds, effects, type references, contributions). One query serves
 * the system graph (one system, its references into others greyed as `external`), the global graph (filters, a focus
 * N hops out, systems collapsed into one node) and the hub fn `hub/graph` the chat calls.
 */
import { z } from 'zod';
import { FnMode, RegistryEffect, RegistryThing } from './manifest.ts';
import { Audience, FnKindName, QualifiedName, SystemName } from './primitives.ts';
import { SystemStage } from './grants.ts';

/** What a node is. Examples are not nodes: they are counted on their fn (`GraphNodeFacts.examples`). */
export const GRAPH_NODE_KINDS = ['system', 'instance', 'fn', 'context', 'type', 'kind', 'resource', 'root', 'component', 'registry', 'command', 'provider'] as const;
export const GraphNodeKind = z.enum(GRAPH_NODE_KINDS);
export type GraphNodeKind = z.infer<typeof GraphNodeKind>;

/** What an edge means, read from its source to its target. */
export const GRAPH_EDGE_KINDS = [
  'brings', 'names', 'loads', 'next', 'reads', 'writes', 'calls', 'uses', 'kind', 'creates', 'updates', 'removes', 'refers', 'renders', 'contributes', 'belongs',
] as const;
export const GraphEdgeKind = z.enum(GRAPH_EDGE_KINDS);
export type GraphEdgeKind = z.infer<typeof GraphEdgeKind>;

/** Each edge kind in plain words, as "<source> <verb> <target>" ("fs.authoring.kinds brings fs/write"). */
export const GRAPH_EDGE_VERBS = {
  brings: 'brings',
  names: 'mentions',
  loads: 'loads',
  next: 'offers next',
  reads: 'reads',
  writes: 'writes',
  calls: 'calls',
  uses: 'depends on',
  kind: 'is a fn of kind',
  creates: 'creates',
  updates: 'updates',
  removes: 'removes',
  refers: 'refers to',
  renders: 'renders',
  contributes: 'contributes to',
  belongs: 'belongs to',
} as const satisfies Record<GraphEdgeKind, string>;

/** A node's id: its kind and name, `fn:fs/read`, `type:database/main.projects`, `system:fs`. */
export const GraphNodeId = z.string().regex(/^[a-z]+:.+$/);
export type GraphNodeId = z.infer<typeof GraphNodeId>;

/** What hovering a node shows beside its name and description; each part only where it applies. */
export const GraphNodeFacts = z.object({
  fnKind: FnKindName.optional(),
  mode: FnMode.optional(),
  effects: z.array(RegistryEffect).optional(),
  reads: z.array(QualifiedName).optional(),
  writes: z.array(QualifiedName).optional(),
  visibility: Audience.optional(),
  on: z.boolean(),
  /** Its system's stage. */
  stage: SystemStage.optional(),
  /** Waiting in its system's pending review. */
  pending: z.boolean().optional(),
  /** A fn's examples, collapsed into it. */
  examples: z.number().int().min(0).optional(),
});
export type GraphNodeFacts = z.infer<typeof GraphNodeFacts>;

export const GraphNode = z.object({
  id: GraphNodeId,
  kind: GraphNodeKind,
  /** Qualified name, URI or `/command`. */
  name: z.string().min(1),
  /** One line about it. */
  about: z.string(),
  /** The system it belongs to; absent for the hub's own (memories, resources). */
  system: SystemName.optional(),
  /** Outside the systems asked for: drawn greyed, and clicking it opens it in its own system. */
  external: z.boolean(),
  /** A system collapsed into one node: how many nodes it stands for. */
  collapsed: z.number().int().min(0).optional(),
  facts: GraphNodeFacts,
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  from: GraphNodeId,
  to: GraphNodeId,
  kind: GraphEdgeKind,
  /** The relation in plain words (`GRAPH_EDGE_VERBS`, with both ends named). */
  label: z.string().min(1),
  /** A context link's weight; absent for hard facts. */
  weight: z.number().min(0).max(1).optional(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

/** A "+N more" stub: `count` neighbours of `node` of kind `kind` left out, expanded by asking with `focus` on it. */
export const GraphMore = z.object({ node: GraphNodeId, kind: GraphNodeKind, count: z.number().int().min(1) });
export type GraphMore = z.infer<typeof GraphMore>;

/** The graph query: every part optional; nothing set is the global graph, capped. */
export const GraphQuery = z.object({
  /** Only these systems' own nodes, plus what they reference (as `external`, unless `external` is false). */
  systems: z.array(SystemName).min(1).optional(),
  external: z.boolean().optional(),
  /** Centre on a node and its neighbourhood, `hops` out (default 1). */
  focus: z.object({ node: GraphNodeId, hops: z.number().int().min(1).max(4).optional() }).optional(),
  /** Text matched against names and descriptions; matching nodes and their edges among themselves. */
  text: z.string().min(1).max(200).optional(),
  nodeKinds: z.array(GraphNodeKind).min(1).optional(),
  edgeKinds: z.array(GraphEdgeKind).min(1).optional(),
  fnKinds: z.array(FnKindName).min(1).optional(),
  modes: z.array(FnMode).min(1).optional(),
  /** Fns with an effect on one of these things. */
  effects: z.array(RegistryThing).min(1).optional(),
  visibility: z.array(Audience).min(1).optional(),
  /** `live`, `installed`, or `pending` (in a pending review). */
  stages: z.array(z.union([SystemStage, z.literal('pending')])).min(1).optional(),
  on: z.boolean().optional(),
  /** Draw each of these systems as one node. */
  collapse: z.array(SystemName).min(1).optional(),
  /** The most nodes returned (default 200); past it, neighbours become `more` stubs. */
  limit: z.number().int().min(1).max(1000).optional(),
});
export type GraphQuery = z.infer<typeof GraphQuery>;

/** The graph as the asker may see it: nodes, the edges among them, the stubs left out, and the totals before the cap. */
export const GraphPage = z.object({
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  more: z.array(GraphMore),
  total: z.object({ nodes: z.number().int().min(0), edges: z.number().int().min(0) }),
});
export type GraphPage = z.infer<typeof GraphPage>;
