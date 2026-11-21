/**
 * Agent tools from a chat mode's native tools (`ModeTool`: a fn's args in tools mode, the static toolset's five in
 * static mode). Calling one never runs anything inline: the tool records the call and suspends the prompt
 * (`PromptSuspend`), and the agent loop asks the mode what each recorded call means (a run of a fn, or invalid input
 * answered at once) and turns the runs into queued runs.
 *
 * The call is recorded from the tool's own `call`, which aeye hands the tool call id (`ctx.toolCallId`). The schema
 * is what the model is shown; aeye only checks that the args are a JSON object (`acceptObject`), so args that don't
 * fit reach the hub, which checks them against the fn's type and settles the run `invalid-input` (a run the chat
 * shows as retried), instead of aeye retrying them where nothing records it. Args that aren't JSON at all are still
 * aeye's to retry.
 */
import { PromptSuspend, Tool } from '@aeye/core';
import { Json, JsonObject } from '@harness/core';
import type { ModeTool } from '../contextor/index.ts';
import type { HubCallContext, HubCallMetadata } from './scope.ts';

/** A tool call the model made, waiting to be interpreted. */
export interface ToolCallIntent {
  readonly toolCallId: string;
  /** The tool's name as the model called it. */
  readonly name: string;
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

/** A value with every `undefined` object field left out, at any depth (aeye hands strict-schema `null`s back as `undefined`). */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined).map(([key, field]) => [key, withoutUndefined(field)]));
}

/** Any JSON object, else the error aeye feeds back to the model. A field left `undefined` counts as left out. */
export function acceptObject(raw: unknown): object | Error {
  const parsed = JsonObject.safeParse(withoutUndefined(raw));
  return parsed.success ? parsed.data : new Error('The args must be one JSON object.');
}

/** An agent tool. */
export type AgentTool = Tool<HubCallContext, HubCallMetadata, string, object, never, [], object>;

/** The aeye tool for a mode's tool: it records its calls and suspends. */
export function agentTool(tool: ModeTool, calls: PendingCalls): AgentTool {
  return new Tool<HubCallContext, HubCallMetadata, string, object, never, [], object>({
    name: tool.name,
    description: tool.description,
    ...(tool.instructions === undefined ? {} : { instructions: tool.instructions }),
    schema: tool.schema,
    parse: acceptObject,
    call: (input, _refs, ctx) => {
      const toolCallId = ctx.toolCallId;
      if (toolCallId === undefined) throw new Error(`tool ${tool.name} was called without a tool call id`);
      calls.add({ toolCallId, name: tool.name, args: Json.parse(input) });
      throw new PromptSuspend(`${tool.name} runs as a queued run`);
    },
  });
}

/** The aeye tools of a prompt, each once by name. */
export function agentTools(tools: readonly ModeTool[], calls: PendingCalls): AgentTool[] {
  const seen = new Set<string>();
  return tools.flatMap((tool) => (seen.has(tool.name) ? [] : (seen.add(tool.name), [agentTool(tool, calls)])));
}
