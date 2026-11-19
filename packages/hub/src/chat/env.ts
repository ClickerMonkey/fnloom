/**
 * The chat module's tunables, an `@ayepi/env` slice. Durations are milliseconds. Boot parses it with the hub's other
 * slices; chat code gets the parsed values through `ChatDeps.settings`, never from `process.env`.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Chat tunables. */
export const chatEnv = env({
  HARNESS_MENTION_TIMEOUT: z.number().int().min(100).default(5_000).describe('How long a system has to write a mention\'s LLM text when a message is sent.'),
  HARNESS_MENTION_SEARCH_TIMEOUT: z.number().int().min(100).default(3_000).describe('How long a system has to answer `@` search and hover.'),
  HARNESS_MENTION_REQUEST_TTL: z.number().int().min(1_000).default(120_000).describe('How long a system may search the hub\'s resources for an `@` search the hub sent it, as the person mentioning.'),
  HARNESS_DELIVERY_TIMEOUT: z.number().int().min(100).default(30_000).describe('How long a system has to answer one delivered action or form.'),
  HARNESS_MESSAGE_PAGE: z.number().int().min(1).max(200).default(50).describe('Messages per page when a request gives no limit.'),
  HARNESS_SESSION_PAGE: z.number().int().min(1).max(200).default(30).describe('Sessions per page when a request gives no limit.'),
  HARNESS_TITLE_LENGTH: z.number().int().min(8).default(60).describe('A session titled by its first message keeps this many characters of it.'),
  HARNESS_TURN_ERRORS: z.number().int().min(0).default(3).describe('A turn stops after this many failed runs; 0 keeps feeding errors back to the agent.'),
  HARNESS_SUGGEST_THRESHOLD: z.number().min(0).max(1).default(0.45).describe('The least score (its similarity of meaning to the message, 0 to 1; unrelated text scores about 0.2 to 0.4 with EmbeddingGemma) a fn or context item needs to be suggested with a message when the decision model is off.'),
  HARNESS_SUGGEST_DECISION_TIMEOUT: z.number().int().min(500).default(4_000).describe('How long the suggestion decision model has to choose before the score decides; a sent message waits this long at most before it shows.'),
  HARNESS_CACHE_LOOKBACK: z.number().int().min(1).max(500).default(50).describe('How many of a session\'s model calls are looked through to tell whether a reply missed the prompt cache.'),
  HARNESS_CONFIG_NOTICE_GRACE: z.number().int().min(0).default(30_000).describe('How long a system may sit in "needs config" before the admins get an inbox notice; a system that connects configured within it gets none (as a fresh hub\'s systems usually do).'),
  HARNESS_UNDO_RUNS: z.number().int().min(1).default(500).describe('The most runs one turn\'s undo looks at.'),
});

/** The parsed chat tunables. */
export type ChatEnv = ReturnType<typeof chatEnv.parse>;
