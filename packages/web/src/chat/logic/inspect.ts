/**
 * Reading a turn's record: the LLM calls in its fn tree, their usage and cost added up for an answer's details, and
 * the parts of a request "what the model saw" shows, and the tabs the inspectors open on (kept in the URL). Pure, so
 * it is tested alone.
 */
import type { LlmInteraction, LlmInteractionId, LlmMessage, RunId, TreeNode } from '@harness/core';
import { z } from 'zod';

/** The tabs of an LLM call's details. */
export const LlmCallTab = z.enum(['saw', 'context', 'tools', 'answer', 'json']);
export type LlmCallTab = z.infer<typeof LlmCallTab>;

/** The tabs of a run's details. */
export const RunTab = z.enum(['overview', 'args', 'result', 'errors', 'json']);
export type RunTab = z.infer<typeof RunTab>;

/** The query keys the inspectors' tabs live under, wherever they open. */
export const TAB_KEYS = { run: 'runTab', llm: 'callTab' } as const;

/** Every LLM call in a tree, in the order the tree lists them. */
export function treeCalls(node: TreeNode): LlmInteractionId[] {
  return [...node.llmCalls.map((c) => c.id), ...node.children.flatMap(treeCalls)];
}

/** Every run in a tree. */
export function treeRuns(node: TreeNode): RunId[] {
  return [node.run.id, ...node.children.flatMap(treeRuns)];
}

/** How many runs a tree holds. */
export function treeSize(node: TreeNode): number {
  return 1 + node.children.reduce((n, child) => n + treeSize(child), 0);
}

/** A turn's LLM use, added up. */
export interface TurnUsage {
  readonly calls: number;
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly reasoning: number;
  readonly cost: number;
  /** From the first call being queued to its first token. */
  readonly firstToken: number | undefined;
  /** From the first call starting to the last ending. */
  readonly duration: number | undefined;
  readonly models: readonly string[];
  readonly providers: readonly string[];
}

/** Add up LLM calls. */
export function turnUsage(calls: readonly LlmInteraction[]): TurnUsage {
  const sorted = [...calls].sort((a, b) => a.queuedAt - b.queuedAt);
  const first = sorted[0];
  const starts = sorted.flatMap((c) => (c.startedAt === undefined ? [] : [c.startedAt]));
  const ends = sorted.flatMap((c) => (c.endedAt === undefined ? [] : [c.endedAt]));
  return {
    calls: calls.length,
    input: calls.reduce((n, c) => n + (c.usage?.input ?? 0), 0),
    output: calls.reduce((n, c) => n + (c.usage?.output ?? 0), 0),
    cached: calls.reduce((n, c) => n + (c.usage?.cached ?? 0), 0),
    reasoning: calls.reduce((n, c) => n + (c.usage?.reasoning ?? 0), 0),
    cost: calls.reduce((n, c) => n + c.cost, 0),
    firstToken: first?.firstTokenAt === undefined ? undefined : first.firstTokenAt - first.queuedAt,
    duration: starts.length === 0 || ends.length === 0 ? undefined : Math.max(...ends) - Math.min(...starts),
    models: [...new Set(calls.map((c) => c.model))],
    providers: [...new Set(calls.map((c) => c.provider))],
  };
}

/** A message's content as text, for reading a request: parts joined, media named. */
export function messageContent(message: Pick<LlmMessage, 'content'>): string {
  if (typeof message.content === 'string') { return message.content; }
  return message.content.map((part) => (part.type === 'text' ? part.content : `[${part.type}${part.name === undefined ? '' : `: ${part.name}`}]`)).join('\n');
}

/** The tagged blocks the hub adds to a user message (`<local-time>…</local-time>`), found in a request's text. */
export interface TaggedBlock {
  readonly tag: string;
  readonly text: string;
}

/** Find the tagged blocks in a text. */
export function taggedBlocks(text: string): TaggedBlock[] {
  const blocks: TaggedBlock[] = [];
  const pattern = /<([a-z][a-z0-9-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  for (const match of text.matchAll(pattern)) {
    const [, tag, body] = match;
    if (tag !== undefined && body !== undefined) { blocks.push({ tag, text: body.trim() }); }
  }
  return blocks;
}
