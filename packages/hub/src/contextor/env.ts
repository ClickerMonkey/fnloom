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
  HARNESS_OLLAMA_DEFAULT_CTX: z.number().int().min(256).default(4_096).describe('The window an Ollama model is served with when its Modelfile sets no num_ctx (never its trained length).'),
  HARNESS_MODEL_PROBE_TTL: z.number().int().min(1_000).default(600_000).describe('How long a provider probe of a model\'s served limits is kept.'),
  HARNESS_GRAPH_POOL: z.number().int().min(4).max(500).default(48).describe('Context and fns the graph contextor retrieves per message before scoring (messages get half).'),
  HARNESS_LOADED_TURNS: z.number().int().min(0).default(3).describe('Turns an item the agent or person loaded stays forced into the prompt after its last use.'),
  HARNESS_EARLIER_TOKENS: z.number().int().min(16).default(120).describe('The most tokens one earlier exchange\'s summary takes in the system prompt.'),
  HARNESS_LINK_HALF_LIFE: z.number().int().min(86_400_000).default(30 * 86_400_000).describe('A learned link\'s use count halves after this long without use.'),
  HARNESS_PROMPT_MARGIN: z.number().min(0).max(0.5).default(0.06).describe('The share of a model\'s window kept free for estimate error (at least 64 tokens).'),
});

/** The parsed contextor tunables. */
export type ContextorEnv = ReturnType<typeof contextorEnv.parse>;
