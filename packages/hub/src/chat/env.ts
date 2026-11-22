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
  HARNESS_FILE_INLINE_CHARS: z.number().int().min(0).default(4_000).describe('An attached text file (plain text, markdown, CSV, JSON…) is put in the message for the model up to this many characters (the rest read with hub/resource_read); 0 puts none in.'),
  HARNESS_TURN_ERRORS: z.number().int().min(0).default(3).describe('A turn stops after this many failed runs; 0 keeps feeding errors back to the agent.'),
  HARNESS_SUGGEST_THRESHOLD: z.number().min(0).max(1).default(0.3).describe('The least score (its similarity of meaning to the message, 0 to 1) a fn or context item needs to be suggested with a message when no model picks suggestions, or the one that does fails. With EmbeddingGemma a close fit scores 0.35 to 0.7, a relevant general fn 0.2 to 0.3, and the median item 0.09 to 0.19 (measured 2026-11-22).'),
  HARNESS_SUGGEST_DECISION_TIMEOUT: z.number().int().min(500).default(4_000).describe('How long the suggestion decision model has to choose before the score decides; a sent message waits this long at most before it shows.'),
  HARNESS_AUTOLOAD_TOKENS: z.number().int().min(0).default(6_000).describe('The most tokens of context text a suggestions chooser whose action is `load` may bring into one message (estimated); what doesn\'t fit is suggested instead. 0 loads no context (fns still load).'),
  HARNESS_AUTOLOAD_ROOM_SHARE: z.number().min(0).max(1).default(0.25).describe('The share of the prompt\'s room (the agent model\'s window less its output, reasoning, margin, instructions, tools and the message) that context loaded into a message may take, under HARNESS_AUTOLOAD_TOKENS, so it never crowds out the chat\'s history.'),
  HARNESS_CACHE_LOOKBACK: z.number().int().min(1).max(500).default(50).describe('How many of a session\'s model calls are looked through to tell whether a reply missed the prompt cache.'),
  HARNESS_CONFIG_NOTICE_GRACE: z.number().int().min(0).default(30_000).describe('How long a system may sit in "needs config" before the admins get an inbox notice; a system that connects configured within it gets none (as a fresh hub\'s systems usually do).'),
  HARNESS_CITE_HOLD_CHARS: z.number().int().min(64).default(2_000).describe('How long a cite (from <cite to </cite>) may run while an answer streams: until it closes the text is held back; longer, it was no cite and shows as text.'),
  HARNESS_CITE_VALUE_CHARS: z.number().int().min(0).default(4_000).describe('The most characters of JSON a cited value may take to be kept on its message; a larger one is read from its run\'s result.'),
  HARNESS_UNDO_RUNS: z.number().int().min(1).default(500).describe('The most runs one turn\'s undo looks at.'),
});

/** The parsed chat tunables. */
export type ChatEnv = ReturnType<typeof chatEnv.parse>;
