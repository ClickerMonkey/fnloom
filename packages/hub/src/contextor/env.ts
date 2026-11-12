/**
 * The contextor module's tunables, an `@ayepi/env` slice. Token counts are estimates (characters over characters per
 * token, calibrated per model); durations are milliseconds. Boot parses it with the hub's other slices.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Contextor tunables. */
export const contextorEnv = env({
  HARNESS_DEFAULT_CONTEXT_WINDOW: z.number().int().min(256).default(4_096).describe('The context window assumed for a model nothing else describes (logged once per model as `model.limits.guessed`).'),
  HARNESS_DEFAULT_MAX_OUTPUT: z.number().int().min(16).default(1_024).describe('The reply length assumed for a model nothing else describes.'),
  HARNESS_OLLAMA_DEFAULT_CTX: z.number().int().min(256).default(4_096).describe('The most window assumed for an Ollama model when neither its Modelfile (num_ctx) nor its provider record sets one; Ollama\'s own default for its version (2048 before 0.6, else 4096) wins when smaller. Never its trained length.'),
  HARNESS_MODEL_PROBE_TTL: z.number().int().min(1_000).default(600_000).describe('How long a provider probe of a model\'s served limits is kept.'),
  HARNESS_GRAPH_POOL: z.number().int().min(4).max(500).default(48).describe('Context and fns the graph contextor retrieves per message before scoring (messages get half).'),
  HARNESS_LOADED_TURNS: z.number().int().min(0).default(3).describe('Turns an item the agent or person loaded stays forced into the prompt after its last use.'),
  HARNESS_EARLIER_TOKENS: z.number().int().min(16).default(120).describe('The most tokens one earlier exchange\'s summary takes in the system prompt.'),
  HARNESS_LINK_HALF_LIFE: z.number().int().min(86_400_000).default(30 * 86_400_000).describe('A learned link\'s use count halves after this long without use.'),
  HARNESS_DYNAMIC_CONTEXT_TTL: z.number().int().min(0).default(300_000).describe('How long the text a system wrote for a dynamic context item (`fs/tree`, `/new-system`) is kept per session and person before it is asked again.'),
  HARNESS_DYNAMIC_CONTEXT_TIMEOUT: z.number().int().min(100).default(15_000).describe('How long the hub waits for a system to write a dynamic context item.'),
  HARNESS_DYNAMIC_CONTEXT_CACHE: z.number().int().min(1).default(500).describe('The most dynamic context texts kept in memory (the oldest go first).'),
  HARNESS_USED_WINDOW: z.number().int().min(1).max(50).default(5).describe('How many of the newest turns the graph contextor\'s `used` signal looks back over.'),
  HARNESS_MEMORY_WEIGHT: z.number().min(0).max(4).default(0.8).describe('What a memory weighs in the graph contextor\'s score when it sets no weight of its own (other items weigh 1).'),
  HARNESS_FLOOR_RESULT_CHARS: z.number().int().min(50).default(600).describe('The characters a tool result in the newest exchange is shortened to when that exchange does not fit whole.'),
  HARNESS_OLD_RESULT_CHARS: z.number().int().min(50).default(400).describe('The characters older tool results of the current exchange are shortened to when it doesn\'t fit.'),
  HARNESS_MIN_RESULT_CHARS: z.number().int().min(20).default(200).describe('The fewest characters the planner shortens a tool result to before it says the prompt can\'t fit.'),
  HARNESS_MAX_RESELECTS: z.number().int().min(0).max(50).default(8).describe('How many times the planner chooses context and fns again with less room when the whole prompt comes out over budget.'),
  HARNESS_PROMPT_MARGIN: z.number().min(0).max(0.5).default(0.06).describe('The share of a model\'s window kept free for estimate error (at least 64 tokens).'),
});

/** The parsed contextor tunables. */
export type ContextorEnv = ReturnType<typeof contextorEnv.parse>;
