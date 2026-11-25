/**
 * Agent tools from a chat mode's native tools (`ModeTool`: a fn's args in tools mode, the static toolset's five in
 * static mode). Calling one never runs anything inline: the tool records the call and suspends the prompt
 * (`PromptSuspend`), and the agent loop asks the mode what each recorded call means (a run of a fn, or invalid input
 * answered at once) and turns the runs into queued runs.
 *
 * The call is recorded from the tool's own `call`, which aeye hands the tool call id (`ctx.toolCallId`) and the args
 * it decoded: `@aeye/core` plans each tool's `@aeye/schema` args for the model, decodes the model's call through that
 * plan into the code shape (fn-name fields as qualified names, a field sent as a string of its JSON repaired) and
 * answers args that don't fit itself, in `@aeye/schema`'s words (`AGENT_TOOL_ERRORS`), retrying in the same job; the
 * agent loop records each such answer as an invalid-input run (`toolError`), so the chat shows it as retried.
 */
import { PromptSuspend, Tool } from '@aeye/core';
import type { ErrorFormatInput } from '@aeye/schema';
import { CONCISE_LIMITS, Json } from '@harness/core';
import type { ModeTool } from '../contextor/index.ts';
import type { HubCallContext, HubCallMetadata } from './scope.ts';

/** A tool call the model made, waiting to be interpreted. */
export interface ToolCallIntent {
  readonly toolCallId: string;
  /** The tool's name as the model called it. */
  readonly name: string;
  /** Its args as core decoded them (the code shape). */
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

/**
 * How args that don't fit a tool are told to the model: one line a problem (with "did you mean" for a misspelt name),
 * a few at most, within a small window's means.
 */
export const AGENT_TOOL_ERRORS: ErrorFormatInput = { detail: 'list', maxErrors: CONCISE_LIMITS.max, maxChars: 1_000 };

/** An agent tool. */
export type AgentTool = Tool<HubCallContext, HubCallMetadata, string, object, never, []>;

/**
 * The aeye tool for a mode's tool: it records its calls and suspends. Its description is the whole of what the model
 * reads about the tool (`spec.description`: the fn's description, then its instructions and examples), because the
 * agent's prompt has no `{{tools}}` section for aeye to put tool instructions in: an `instructions` given to aeye
 * apart would never reach the model. The schema is planned per model by core (strict where the model takes it,
 * adapted to the provider's limits), and a call is decoded through that plan.
 */
export function agentTool(tool: ModeTool, calls: PendingCalls): AgentTool {
  return new Tool<HubCallContext, HubCallMetadata, string, object, never, []>({
    name: tool.name,
    description: tool.spec.description ?? tool.description,
    schema: tool.schema,
    errorFormat: AGENT_TOOL_ERRORS,
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
