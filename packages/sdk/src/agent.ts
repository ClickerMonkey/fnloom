/** Declaring agents: fns of the hub's `llm` kind, with tools and context given as refs. */
import type { Audience, FnEffects, FnRouting, ModelChoice } from '@harness/core';
import type { FnDef, FnExampleOf, FnValidators, KindFnTypes } from './fn.ts';
import type { StatusTemplates } from '@harness/core';
import type { StatusInput } from './status.ts';
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
export interface AgentInput<A, R, T extends StatusTemplates = StatusTemplates> {
  description: string;
  args: GinType<A>;
  /** Text for a chat-style agent; any type for a structured answer. */
  returns: GinType<R>;
  /**
   * The agent's own prompt (Handlebars; `{{args.x}}` reads the args): its job, how to use its tools step by step,
   * what to answer with, and worked examples. Write it for the model.
   */
  instructions: string;
  /** What callers read (the fn's `instructions`): when to use it, how to call it, what it returns, pitfalls. */
  usage?: string;
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
  /** How fns reach the model: strict tools (the hub's default) or the static toolset. */
  mode?: NonNullable<LlmPayload['mode']>;
  /** What goes into each prompt: plain (the hub's default), suggest, or graph (for small local models). */
  contextor?: NonNullable<LlmPayload['contextor']>;
  /** The most tokens one answer may take (never past the model's own limit); the hub's `HARNESS_AGENT_MAX_OUTPUT` when absent. */
  maxOutput?: number;
  visibility?: Audience;
  tags?: string[];
  /** The API group it is listed in: one of the system's `groups` (`system(name, { groups })`); the general group when absent. */
  group?: string;
  /** Example calls (args of its own args type), shown to other agents on its card. */
  examples?: FnExampleOf<NoInfer<A>, NoInfer<R>>[];
  /** Checks its system runs on the args before it starts and on its answer after (`retry` sends the model back with why). */
  validate?: FnValidators<NoInfer<A>, NoInfer<R>, {}>;
  /** What its runs say they are doing; the hub's agent words when absent. Tokens are checked against `args` and `returns`. */
  status?: StatusInput<NoInfer<A>, NoInfer<R>, T>;
  /** For a fleet: always one instance, or whichever is first available (get_query routed to the database it serves). */
  routing?: FnRouting;
  /** What it does to data and the registry: its mode, the types it reads and writes, and the fns it creates (`FnFacts`). */
  effects?: FnEffects;
}

/**
 * Declare an agent: an LLM with instructions, tools and context, callable like any fn. A system can ship its own
 * agents (a code reviewer, a planner) with tools from any system.
 */
export function agent<A, R, const T extends StatusTemplates = StatusTemplates>(def: AgentInput<A, R, T>): FnDef<AgentFnTypes<A, R>> {
  const canLoad = def.canLoad ?? 'none';
  return hub.kinds.llm.fn({
    description: def.description,
    ...(def.usage === undefined ? {} : { instructions: def.usage }),
    args: def.args,
    returns: def.returns,
    ...(def.visibility === undefined ? {} : { visibility: def.visibility }),
    ...(def.tags === undefined ? {} : { tags: def.tags }),
    ...(def.group === undefined ? {} : { group: def.group }),
    ...(def.examples === undefined ? {} : { examples: def.examples }),
    ...(def.validate === undefined ? {} : { validate: def.validate }),
    ...(def.status === undefined ? {} : { status: def.status }),
    ...(def.routing === undefined ? {} : { routing: def.routing }),
    ...(def.effects === undefined ? {} : { effects: def.effects }),
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
      ...(def.mode === undefined ? {} : { mode: def.mode }),
      ...(def.contextor === undefined ? {} : { contextor: def.contextor }),
      ...(def.maxOutput === undefined ? {} : { maxOutput: def.maxOutput }),
    },
  });
}
