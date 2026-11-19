/**
 * The graph's vocabulary: what a node is, what an edge means, and the stages a node can be filtered by. A leaf module
 * (zod and the system stages only) so the query standard (`query.ts`) can declare the graph list's fields from the
 * same lists the graph itself uses; `graph.ts` re-exports it.
 */
import { z } from 'zod';
import { SYSTEM_STAGES } from './grants.ts';

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

/** The stages a node is filtered by: its system's stage, or `pending` (waiting in its system's pending review). */
export const GRAPH_STAGES = [...SYSTEM_STAGES, 'pending'] as const;
export const GraphStage = z.enum(GRAPH_STAGES);
export type GraphStage = z.infer<typeof GraphStage>;
