/**
 * Reading a turn's record: the LLM calls in its fn tree, their usage and cost added up for an answer's details, and
 * the parts of a request "what the model saw" shows, and the tabs the inspectors open on (kept in the URL). Pure, so
 * it is tested alone.
 */
import { fnOfStoredToolName, RunArgs, type QualifiedName, type LlmInteraction, type LlmInteractionId, type LlmMessage, type LlmToolCall, type RunId, type StaticTool, type TreeNode } from '@harness/core';
import { z } from 'zod';
import { NO_BEARING, STOPPED_BY_HUB } from './runs.ts';

/** The tabs of an LLM call's details. */
export const LlmCallTab = z.enum(['saw', 'context', 'tools', 'answer', 'json']);
export type LlmCallTab = z.infer<typeof LlmCallTab>;

/** The tabs of a run's details. */
export const RunTab = z.enum(['overview', 'args', 'result', 'changes', 'errors', 'json']);
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

/** The static toolset's tool that runs a fn named in its args (`{ fn, args }`). */
const RUN_TOOL: StaticTool = 'run';

/**
 * The fn a tool call runs: a fn's own tool (`hub__fns_search` read back to `hub/fns_search`, by core's display-only
 * `fnOfStoredToolName`, which also reads old records' spelling), or the fn the static `run` tool names in its args.
 * `cut` reads back a cut name the hub was asked for (`ModelNamesStore`). Other static tools (find, load, …) and args
 * that don't parse run no fn.
 */
export function toolCallFn(tool: Pick<LlmToolCall, 'name' | 'arguments'>, cut?: (name: string) => QualifiedName | undefined): QualifiedName | undefined {
  const own = fnOfStoredToolName(tool.name, cut);
  if (own !== undefined || tool.name !== RUN_TOOL) { return own; }
  try {
    const named = RunArgs.safeParse(JSON.parse(tool.arguments)).data?.fn;
    return named === undefined ? undefined : fnOfStoredToolName(named, cut);
  } catch {
    return undefined;
  }
}

/**
 * A calm note on a tool call the model got wrong, for an LLM call's details, or '' when there is nothing to say: a call
 * the hub stopped while the model was still writing it, or (given what this call offered) a tool name it wasn't
 * offered. Either went back to the model to try again: its slip, never shown as an error.
 */
export function toolCallSlip(tool: Pick<LlmToolCall, 'name' | 'arguments'>, offered?: readonly string[]): string {
  if (tool.arguments.trimStart().startsWith(STOPPED_BY_HUB)) {
    return `The hub stopped this call while the model was still writing it (it ran too long); the model was told and called again. ${NO_BEARING}.`;
  }
  if (offered !== undefined && offered.length > 0 && tool.name !== RUN_TOOL && !offered.includes(tool.name)) {
    return `Not one of the tools offered to this call; the model was told and tried again. ${NO_BEARING}.`;
  }
  return '';
}

/** Every tool name a call offered or called, and every `run` target, for asking the hub about cut names. */
export function callToolNames(call: LlmInteraction): string[] {
  const calls = [...call.request.messages.flatMap((message) => message.toolCalls ?? []), ...(call.response?.toolCalls ?? [])];
  const runs = calls.flatMap((tool) => {
    if (tool.name !== RUN_TOOL) { return []; }
    try { const fn = RunArgs.safeParse(JSON.parse(tool.arguments)).data?.fn; return fn === undefined ? [] : [fn]; } catch { return []; }
  });
  return [...(call.request.tools ?? []).map((tool) => tool.name), ...calls.map((tool) => tool.name), ...runs];
}

/** The fns a turn's LLM calls called, each once, in the order first called (a fn's tool, or the static `run` naming it). */
export function turnFns(calls: readonly LlmInteraction[]): readonly QualifiedName[] {
  const sorted = [...calls].sort((a, b) => a.queuedAt - b.queuedAt);
  return [...new Set(sorted.flatMap((call) => (call.response?.toolCalls ?? []).flatMap((tool) => toolCallFn(tool) ?? [])))];
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
