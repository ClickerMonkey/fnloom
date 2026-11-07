/** Declaring agents: fns of the hub's `llm` kind, with tools and context given as refs. */
import type { Audience, ModelChoice } from '@harness/core';
import type { FnDef, KindFnTypes } from './fn.ts';
import type { GinType, Infer } from './gin.ts';
import { hub, type LlmPayloadType } from './hub.ts';
import type { AnyContextRef, AnyFnRef, AnyHookRef } from './refs.ts';

/** The payload of a `hub/llm` fn, as stored. */
export type LlmPayload = Infer<typeof LlmPayloadType>;

/** The ref type of the hub's `llm` kind. */
export type LlmKind = typeof hub.kinds.llm;

/** The types of an agent fn. */
export type AgentFnTypes<A, R> = KindFnTypes<LlmKind, LlmPayload, A, R>;

/** What `agent()` takes. */
export interface AgentInput<A, R> {
  description: string;
  args: GinType<A>;
  /** Text for a chat-style agent; any type for a structured answer. */
  returns: GinType<R>;
  /** Handlebars; `{{args.x}}` reads the args. */
  instructions: string;
  model?: ModelChoice;
  tools?: AnyFnRef[];
  /** Fns the agent may add to its toolset while running. Default `none`. */
  canLoad?: { fns?: AnyFnRef[]; systems?: string[]; tags?: string[] } | 'none';
  /** Default 32. */
  maxTools?: number;
  context?: AnyContextRef[];
  hooks?: AnyHookRef[];
  /** Default `parallel`. */
  toolExecution?: 'parallel' | 'sequential';
  /** Default 16. */
  maxIterations?: number;
  visibility?: Audience;
  tags?: string[];
}

/**
 * Declare an agent: an LLM with instructions, tools and context, callable like any fn. A system can ship its own
 * agents (a code reviewer, a planner) with tools from any system.
 */
export function agent<A, R>(def: AgentInput<A, R>): FnDef<AgentFnTypes<A, R>> {
  const canLoad = def.canLoad ?? 'none';
  return hub.kinds.llm.fn({
    description: def.description,
    args: def.args,
    returns: def.returns,
    ...(def.visibility === undefined ? {} : { visibility: def.visibility }),
    ...(def.tags === undefined ? {} : { tags: def.tags }),
    payload: {
      instructions: def.instructions,
      ...(def.model === undefined ? {} : { model: def.model }),
      tools: (def.tools ?? []).map((t) => t.name),
      canLoad: canLoad === 'none' ? 'none' : {
        ...(canLoad.fns === undefined ? {} : { fns: canLoad.fns.map((f) => f.name) }),
        ...(canLoad.systems === undefined ? {} : { systems: [...canLoad.systems] }),
        ...(canLoad.tags === undefined ? {} : { tags: [...canLoad.tags] }),
      },
      maxTools: def.maxTools ?? 32,
      context: (def.context ?? []).map((c) => c.name),
      hooks: (def.hooks ?? []).map((h) => h.name),
      toolExecution: def.toolExecution ?? 'parallel',
      maxIterations: def.maxIterations ?? 16,
    },
  });
}
