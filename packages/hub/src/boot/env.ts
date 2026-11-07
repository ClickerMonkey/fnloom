/**
 * Every hub tunable, as `@ayepi/env` slices with defaults in the schema. Feature code reads these slices, never
 * `process.env`. Durations are milliseconds. Each module owns its slice; the boot module parses them all at start
 * so a bad value fails start-up with one aggregated error.
 */
import { env } from '@ayepi/env';
import { PRIORITIES } from '@harness/core';
import { z } from 'zod';

/** Where the hub listens and keeps its data. */
export const hubEnv = env({
  HARNESS_PORT: z.number().int().min(1).max(65535).default(4300),
  HARNESS_HOST: z.string().default('0.0.0.0'),
  /** The public URL, for pairing links and push. Defaults to the LAN-bound port. */
  HARNESS_URL: z.string().default('http://localhost:4300'),
  /** The data folder: database, files, installed systems, logs. */
  HARNESS_DATA: z.string().default('.harness'),
}).add({
  HARNESS_DB_FILE: (e) => z.string().default(`${e.HARNESS_DATA}/hub.sqlite`),
  HARNESS_FILES_DIR: (e) => z.string().default(`${e.HARNESS_DATA}/files`),
  HARNESS_SYSTEMS_DIR: (e) => z.string().default(`${e.HARNESS_DATA}/systems`),
  HARNESS_LOG_DIR: (e) => z.string().default(`${e.HARNESS_DATA}/logs`),
});

/** Sign-in and secrets. Secrets are generated and stored in the data folder when not given. */
export const authEnv = env({
  HARNESS_JWT_SECRET: z.string().min(32).optional(),
  HARNESS_SECRET_KEY: z.string().min(32).optional(),
  HARNESS_ADMIN_EMAIL: z.email().optional(),
  HARNESS_ADMIN_PASSWORD: z.string().min(10).optional(),
  HARNESS_ACCESS_TTL: z.number().int().min(60_000).default(900_000),
  HARNESS_REFRESH_TTL: z.number().int().min(3_600_000).default(30 * 86_400_000),
  HARNESS_SIGN_IN_LIMIT: z.number().int().min(1).default(10),
  HARNESS_SIGN_IN_WINDOW: z.number().int().min(1_000).default(60_000),
});

/** Queues and timing. */
export const queueEnv = env({
  HARNESS_LLM_CONCURRENCY: z.number().int().min(1).default(4),
  /** Per system. */
  HARNESS_RUN_CONCURRENCY: z.number().int().min(1).default(8),
  /** A tool running longer than this stops blocking the agent, if a user is active in the session. */
  HARNESS_TOOL_TIMEOUT: z.number().int().min(1_000).default(30_000),
  /** How recently a user must have been active to count as present. */
  HARNESS_ACTIVE_WINDOW: z.number().int().min(1_000).default(120_000),
  HARNESS_DEFAULT_PRIORITY: z.enum(PRIORITIES).default('interactive'),
  HARNESS_TURN_COST: z.number().min(0).default(0.5),
  HARNESS_TURN_TIME: z.number().int().min(1_000).default(600_000),
  /** Reserve this much more than the estimate before an LLM call. */
  HARNESS_BUDGET_MARGIN: z.number().min(1).default(1.25),
});

/** The system link. */
export const linkEnv = env({
  HARNESS_MAX_FRAME: z.number().int().min(16_384).default(262_144),
  HARNESS_MAX_CHUNK: z.number().int().min(16_384).default(131_072),
  HARNESS_HEARTBEAT: z.number().int().min(1_000).default(15_000),
  HARNESS_PAIRING_TIMEOUT: z.number().int().min(10_000).default(600_000),
  HARNESS_STOP_TIMEOUT: z.number().int().min(100).default(10_000),
  HARNESS_RESTART_BACKOFF: z.number().int().min(100).default(2_000),
  HARNESS_RESTARTS_PER_HOUR: z.number().int().min(1).default(10),
});

/** Models, embeddings and the index. */
export const modelEnv = env({
  /** An OpenRouter key; configures the openrouter provider on first start. */
  OPENROUTER_API_KEY: z.string().optional(),
  /** The model the chat agent uses until an admin picks one. */
  HARNESS_DEFAULT_MODEL: z.string().default('openrouter/auto'),
  /** The embedder that embeds indexed text (documents): a qualified embedder name from a system. */
  HARNESS_EMBEDDER_DOCUMENT: z.string().default('embedder/document'),
  /** The embedder that embeds search text (queries), in the same vector space as the document embedder. */
  HARNESS_EMBEDDER_QUERY: z.string().default('embedder/query'),
  HARNESS_EMBED_DIMENSIONS: z.number().int().min(1).default(768),
  HARNESS_EMBED_BATCH: z.number().int().min(1).default(32),
  HARNESS_SUGGESTIONS: z.number().int().min(0).default(6),
});

/** Logging. */
export const logEnv = env({
  HARNESS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HARNESS_LOG_JSON: z.boolean().default(false),
});

/** Web push (VAPID). Keys are generated and stored when not given. */
export const pushEnv = env({
  HARNESS_VAPID_PUBLIC: z.string().optional(),
  HARNESS_VAPID_PRIVATE: z.string().optional(),
  HARNESS_VAPID_SUBJECT: z.string().default('mailto:admin@localhost'),
});

/** Every slice, so boot can parse them all and an admin page can list them. */
export const HUB_ENV = { hubEnv, authEnv, queueEnv, linkEnv, modelEnv, logEnv, pushEnv } as const;

/** The parsed hub settings, derived from the slices (never written by hand). */
export type HubSettings = { [K in keyof typeof HUB_ENV]: ReturnType<(typeof HUB_ENV)[K]['parse']> };

/** Parse every slice; throws one aggregated `EnvError` listing every bad value. */
export function parseHubSettings(): HubSettings {
  return {
    hubEnv: hubEnv.parse(), authEnv: authEnv.parse(), queueEnv: queueEnv.parse(), linkEnv: linkEnv.parse(),
    modelEnv: modelEnv.parse(), logEnv: logEnv.parse(), pushEnv: pushEnv.parse(),
  };
}

/** Live tests only: which free OpenRouter models they call. Kept here so test code holds no model ids. */
export const liveEnv = env({
  HARNESS_LIVE_MODEL: z.string().default('nvidia/nemotron-3.5-super-vl:free'),
  HARNESS_LIVE_FALLBACKS: z.string().default('nvidia/nemotron-3-ultra-550b-a55b:free,dots-studio/dots-3-note-preview:free'),
  HARNESS_LIVE_EMBEDDER_URL: z.string().default('http://127.0.0.1:8760'),
});
