/**
 * Agent tools from fn signatures. Every tool an agent sees is a fn: its schema is the fn's gin args as a zod value
 * schema (from the catalog), and calling it never runs anything inline. The tool records the call and suspends the
 * prompt (`PromptSuspend`), and the agent loop turns each recorded call into a queued run.
 *
 * The call is recorded from the tool's own `call`, which aeye hands the tool call id (`ctx.toolCallId`).
 */
import { PromptSuspend, Tool } from '@aeye/core';
import { Json, type FnRecord, type QualifiedName } from '@harness/core';
import type { FnSignature } from '../catalog/index.ts';
import type { HubCallContext, HubCallMetadata } from './scope.ts';
import { isObjectSchema, toolName } from './wire.ts';

/** A tool call the model made, waiting to become a run. */
export interface ToolCallIntent {
  readonly toolCallId: string;
  readonly fn: QualifiedName;
  readonly args: Json;
}

/** The calls one prompt job made, in the order the model made them. */
export class PendingCalls {
  readonly #calls = new Map<string, ToolCallIntent>();

  add(call: ToolCallIntent): void {
    this.#calls.set(call.toolCallId, call);
  }

  /** The calls, in the order of `toolCallIds` (the assistant message's order); ids with no call are left out. */
  inOrder(toolCallIds: readonly string[]): ToolCallIntent[] {
    return toolCallIds.flatMap((id) => {
      const call = this.#calls.get(id);
      return call === undefined ? [] : [call];
    });
  }

  get size(): number {
    return this.#calls.size;
  }
}

/** An agent tool for one fn. */
export type FnTool = Tool<HubCallContext, HubCallMetadata, string, object, never, [], object>;

/** The tools of one prompt job, and which fn each tool name stands for. */
export interface Toolset {
  readonly tools: FnTool[];
  readonly fns: ReadonlyMap<string, QualifiedName>;
}

/** Build the tool for a fn. Refused (undefined) when the fn's args aren't an object, which no LLM tool can take. */
export function fnTool(fn: FnRecord, signature: FnSignature, calls: PendingCalls): FnTool | undefined {
  const schema = signature.argsSchema;
  if (!isObjectSchema(schema)) return undefined;
  return new Tool<HubCallContext, HubCallMetadata, string, object, never, [], object>({
    name: toolName(fn.name),
    description: fn.decl.description,
    ...(fn.decl.instructions === undefined ? {} : { instructions: fn.decl.instructions }),
    schema,
    call: (input, _refs, ctx) => {
      const toolCallId = ctx.toolCallId;
      if (toolCallId === undefined) throw new Error(`tool ${fn.name} was called without a tool call id`);
      calls.add({ toolCallId, fn: fn.name, args: Json.parse(input) });
      throw new PromptSuspend(`${fn.name} runs as a queued run`);
    },
  });
}

/** Build the tools for fns (each with its signature), skipping any that can't be a tool. */
export function toolset(entries: ReadonlyArray<{ fn: FnRecord; signature: FnSignature }>, calls: PendingCalls): Toolset {
  const tools: FnTool[] = [];
  const fns = new Map<string, QualifiedName>();
  for (const { fn, signature } of entries) {
    const tool = fnTool(fn, signature, calls);
    if (tool === undefined || fns.has(tool.name)) continue;
    tools.push(tool);
    fns.set(tool.name, fn.name);
  }
  return { tools, fns };
}
