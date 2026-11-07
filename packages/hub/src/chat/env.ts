/**
 * The chat module's tunables, an `@ayepi/env` slice. Durations are milliseconds. Boot parses it with the hub's other
 * slices; chat code gets the parsed values through `ChatDeps.settings`, never from `process.env`.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Chat tunables. */
export const chatEnv = env({
  /** How long a system has to write a mention's LLM text when a message is sent. */
  HARNESS_MENTION_TIMEOUT: z.number().int().min(100).default(5_000),
  /** How long a system has to answer `@` search and hover. */
  HARNESS_MENTION_SEARCH_TIMEOUT: z.number().int().min(100).default(3_000),
  /** How long a system has to answer one delivered action or form. */
  HARNESS_DELIVERY_TIMEOUT: z.number().int().min(100).default(30_000),
  /** Messages per page when a request gives no limit. */
  HARNESS_MESSAGE_PAGE: z.number().int().min(1).max(200).default(50),
  /** Sessions per page when a request gives no limit. */
  HARNESS_SESSION_PAGE: z.number().int().min(1).max(200).default(30),
  /** A session titled by its first message keeps this many characters of it. */
  HARNESS_TITLE_LENGTH: z.number().int().min(8).default(60),
  /** A turn stops after this many failed runs; 0 keeps feeding errors back to the agent. */
  HARNESS_TURN_ERRORS: z.number().int().min(0).default(3),
  /** The most runs one turn's undo looks at. */
  HARNESS_UNDO_RUNS: z.number().int().min(1).default(500),
});

/** The parsed chat tunables. */
export type ChatEnv = ReturnType<typeof chatEnv.parse>;
