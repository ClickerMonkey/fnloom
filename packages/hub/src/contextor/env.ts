/**
 * The contextor module's tunables, an `@ayepi/env` slice. Token counts are estimates (characters over characters per
 * token, calibrated per model); durations are milliseconds. Boot parses it with the hub's other slices.
 */
import { env } from '@ayepi/env';
import type { GraphMetric } from '@harness/core';
import { z } from 'zod';

/** A metric's weight: how much it counts in the graph contextor's score. */
const weight = (metric: string, value: number) => z.number().min(0).max(10).default(value).describe(`How much the ${metric} signal counts in the graph contextor's score (0 leaves it out). A session's override wins.`);
/** A metric's target: the signal value it scores best at. */
const target = (metric: string, value: number) => z.number().default(value).describe(`The ${metric} value the graph contextor scores best. A session's override wins.`);
/** A metric's steepness: how fast its score falls away from the target. */
const steepness = (metric: string, value: number) => z.number().positive().default(value).describe(`How fast the ${metric} score falls away from its target (higher is steeper). A session's override wins.`);

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
  HARNESS_CONTEXT_PARALLEL: z.number().int().min(1).default(8).describe('How many context items planning a prompt reads at once where each may be written by its system (dynamic context in the injected section, the items a contextor shows); 1 reads them one after another.'),
  HARNESS_DYNAMIC_CONTEXT_CACHE: z.number().int().min(1).default(500).describe('The most dynamic context texts kept in memory (the oldest go first).'),
  HARNESS_USED_WINDOW: z.number().int().min(1).max(50).default(5).describe('How many of the newest turns the graph contextor\'s `used` signal looks back over.'),
  HARNESS_MEMORY_WEIGHT: z.number().min(0).max(4).default(0.8).describe('What a memory weighs in the graph contextor\'s score when it sets no weight of its own (other items weigh 1).'),
  HARNESS_FLOOR_RESULT_CHARS: z.number().int().min(50).default(600).describe('The characters a tool result in the newest exchange is shortened to when that exchange does not fit whole.'),
  HARNESS_OLD_RESULT_CHARS: z.number().int().min(50).default(400).describe('The characters older tool results of the current exchange are shortened to when it doesn\'t fit.'),
  HARNESS_MIN_RESULT_CHARS: z.number().int().min(20).default(200).describe('The fewest characters the planner shortens a tool result to before it says the prompt can\'t fit.'),
  HARNESS_MAX_RESELECTS: z.number().int().min(0).max(50).default(8).describe('How many times the planner chooses context and fns again with less room when the whole prompt comes out over budget.'),
  // each graph metric's weight, target and steepness (`score.ts`), the defaults a session's overrides sit on
  HARNESS_METRIC_EMBEDDING_WEIGHT: weight('embedding similarity', 1),
  HARNESS_METRIC_EMBEDDING_TARGET: target('embedding similarity', 1),
  // the signal is a cosine similarity: at 6 an item known by meaning alone crosses the graph threshold (0.15) at the
  // suggestion threshold (0.45), and unrelated text (0.2 to 0.4) stays under it (`thresholds.test.ts`)
  HARNESS_METRIC_EMBEDDING_K: steepness('embedding similarity', 6),
  HARNESS_METRIC_WORDS_WEIGHT: weight('shared words', 0.3),
  HARNESS_METRIC_WORDS_TARGET: target('shared words', 1),
  HARNESS_METRIC_WORDS_K: steepness('shared words', 2),
  HARNESS_METRIC_TURNS_AGO_WEIGHT: weight('turns since last use', 0.4),
  HARNESS_METRIC_TURNS_AGO_TARGET: target('turns since last use', 0),
  HARNESS_METRIC_TURNS_AGO_K: steepness('turns since last use', 0.15),
  HARNESS_METRIC_AGE_WEIGHT: weight('age in days', 0.1),
  HARNESS_METRIC_AGE_TARGET: target('age in days', 0),
  HARNESS_METRIC_AGE_K: steepness('age in days', 0.02),
  HARNESS_METRIC_SELECTED_BEFORE_WEIGHT: weight('chosen before', 0.3),
  HARNESS_METRIC_SELECTED_BEFORE_TARGET: target('chosen before', 1),
  HARNESS_METRIC_SELECTED_BEFORE_K: steepness('chosen before', 1),
  HARNESS_METRIC_USED_WEIGHT: weight('recent use', 0.5),
  HARNESS_METRIC_USED_TARGET: target('recent use', 1),
  HARNESS_METRIC_USED_K: steepness('recent use', 1.5),
  HARNESS_AGENT_MAX_OUTPUT: z.number().int().min(0).default(16_000).describe('The most tokens one answer of an agent fn (the chat\'s among them) may take when its payload declares no `maxOutput`, so a stuck model cannot write for minutes; 0 leaves it to the model\'s own limit.'),
  HARNESS_INJECTED_SHARE: z.number().min(0.05).max(1).default(0.5).describe('The most of a prompt\'s room (after the instructions, the mode\'s guide and its tools) an agent\'s injected section may take, besides its own `injected.maxTokens`; past it, items fall back to their summary, a `<more_ctx>` line, then out. Worked out from the model alone, so the section stays the same from turn to turn and caches.'),
  HARNESS_INJECTED_STEPS: z.number().int().min(1).default(256).describe('The most turns whose injected section the planner keeps in memory, so every step of a turn sends the same fixed region.'),
  HARNESS_PROMPT_MARGIN: z.number().min(0).max(0.5).default(0.06).describe('The share of a model\'s window kept free for estimate error (at least 64 tokens).'),
});

/** The parsed contextor tunables. */
export type ContextorEnv = ReturnType<typeof contextorEnv.parse>;

/** A metric's weight, target and steepness, all known. */
export interface MetricSetting {
  readonly weight: number;
  readonly target: number;
  readonly k: number;
}

/** Each graph metric's default weight, target and steepness, from the settings. */
export function metricDefaults(settings: ContextorEnv): Readonly<Record<GraphMetric, MetricSetting>> {
  return {
    embedding: { weight: settings.HARNESS_METRIC_EMBEDDING_WEIGHT, target: settings.HARNESS_METRIC_EMBEDDING_TARGET, k: settings.HARNESS_METRIC_EMBEDDING_K },
    words: { weight: settings.HARNESS_METRIC_WORDS_WEIGHT, target: settings.HARNESS_METRIC_WORDS_TARGET, k: settings.HARNESS_METRIC_WORDS_K },
    turnsAgo: { weight: settings.HARNESS_METRIC_TURNS_AGO_WEIGHT, target: settings.HARNESS_METRIC_TURNS_AGO_TARGET, k: settings.HARNESS_METRIC_TURNS_AGO_K },
    age: { weight: settings.HARNESS_METRIC_AGE_WEIGHT, target: settings.HARNESS_METRIC_AGE_TARGET, k: settings.HARNESS_METRIC_AGE_K },
    selectedBefore: { weight: settings.HARNESS_METRIC_SELECTED_BEFORE_WEIGHT, target: settings.HARNESS_METRIC_SELECTED_BEFORE_TARGET, k: settings.HARNESS_METRIC_SELECTED_BEFORE_K },
    used: { weight: settings.HARNESS_METRIC_USED_WEIGHT, target: settings.HARNESS_METRIC_USED_TARGET, k: settings.HARNESS_METRIC_USED_K },
  };
}
