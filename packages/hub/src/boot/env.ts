/**
 * Every hub tunable, as `@ayepi/env` slices with defaults in the schema. Feature code reads these slices, never
 * `process.env`. Durations are milliseconds. Each module owns its slice; the boot module parses them all at start
 * so a bad value fails start-up with one aggregated error.
 */
import { env, mergeEnvs } from '@ayepi/env';
import { HUB_PORT, PRIORITIES } from '@harness/core';
import { z } from 'zod';
import { chatEnv } from '../chat/env.ts';
import { connectionsEnv } from '../connections/env.ts';
import { executionEnv } from '../execution/env.ts';
import { fnsEnv } from '../fns/env.ts';
import { indexEnv } from '../index/env.ts';
import { contextorEnv } from '../contextor/env.ts';
import { dataEnv } from '../data/env.ts';
import { packagingEnv, reviewEnv } from '../link/env.ts';
import { mcpEnv } from '../mcp/env.ts';
import { queryEnv } from '../query/env.ts';
import { resourcesEnv } from '../resources/env.ts';
import { storeEnv } from '../store/env.ts';

/** Where the hub listens and keeps its data. */
export const hubEnv = env({
  ...HUB_PORT,
  HARNESS_HOST: z.string().default('0.0.0.0').describe('The address the hub binds to.'),
  HARNESS_NAME: z.string().optional().describe('The name people see for this hub (the brand, sign-in page, tab title, install name, notifications). An admin\'s setting in the app wins; unset: "Harness".'),
  HARNESS_DATA: z.string().default('.harness').describe('The data folder: database, files, installed systems, logs.'),
}).add({
  HARNESS_URL: (e) => z.string().default(`http://localhost:${e.HARNESS_PORT}`).describe('The public URL, for pairing links and push. Defaults to this machine on `HARNESS_PORT`.'),
  HARNESS_DB_FILE: (e) => z.string().default(`${e.HARNESS_DATA}/hub.sqlite`).describe('The SQLite database file.'),
  HARNESS_FILES_DIR: (e) => z.string().default(`${e.HARNESS_DATA}/files`).describe('Where uploaded and stored files are kept.'),
  HARNESS_SYSTEMS_DIR: (e) => z.string().default(`${e.HARNESS_DATA}/systems`).describe('Where installed systems are unpacked.'),
  HARNESS_LOG_DIR: (e) => z.string().default(`${e.HARNESS_DATA}/logs`).describe('Where daily log files are written.'),
  HARNESS_KEYS_FILE: (e) => z.string().default(`${e.HARNESS_DATA}/keys.json`).describe('The secrets the hub makes for itself when they aren\'t given (JWT, encryption, files, VAPID keys).'),
});

/** The HTTP front: the built web app, uploads, docs, sockets and load shedding. */
export const httpEnv = env({
  HARNESS_WEB_DIST: z.string().default('').describe('The built web app the hub serves (`npm run build`). Empty: `packages/web/dist` beside the hub package.'),
  HARNESS_DOCS: z.boolean().default(false).describe('Serve the API docs (`/docs/swagger`, `/docs/redoc`, `/docs/asyncapi`).'),
  HARNESS_MAX_UPLOAD: z.number().int().min(1).default(100 * 1024 * 1024).describe('The largest upload, in bytes.'),
  HARNESS_PRESIGN_TTL: z.number().int().min(1_000).default(600_000).describe('How long a presigned upload or download URL stays valid.'),
  HARNESS_WS_HEARTBEAT: z.number().int().min(1_000).default(30_000).describe('The WebSocket ping interval; a connection that misses a pong is dropped.'),
  HARNESS_WS_TOKEN_MARGIN: z.number().int().min(0).default(10_000).describe('A browser socket is closed this long before its access token expires, so it reconnects with a fresh one.'),
  HARNESS_SHED_THRESHOLD: z.number().int().min(1).default(200).describe('Event-loop delay (running average) that counts as overloaded.'),
  HARNESS_SHED_SUSTAINED: z.number().int().min(0).default(1_000).describe('How long the loop must stay overloaded before requests are refused.'),
  HARNESS_SHED_RECOVER: z.number().int().min(0).default(2_000).describe('How long it must stay healthy before requests are accepted again.'),
  HARNESS_SHUTDOWN_TIMEOUT: z.number().int().min(1_000).default(30_000).describe('How long the hub waits for everything to stop on shutdown.'),
});

/** Sign-in and secrets. Secrets are generated and stored in the data folder when not given. */
export const authEnv = env({
  HARNESS_JWT_SECRET: z.string().min(32).optional().describe('Signs access and refresh tokens (at least 32 characters). Made and stored when not given.'),
  HARNESS_SECRET_KEY: z.string().min(32).optional().describe('Encrypts stored secrets such as provider keys (at least 32 characters). Made and stored when not given.'),
  HARNESS_ADMIN_EMAIL: z.email().optional().describe('The single admin account\'s email. Made on the first start.'),
  HARNESS_ADMIN_PASSWORD: z.string().min(8).optional().describe('The single admin account\'s password (at least 8 characters).'),
  HARNESS_ACCESS_TTL: z.number().int().min(60_000).default(900_000).describe('How long an access token lasts.'),
  HARNESS_REFRESH_TTL: z.number().int().min(3_600_000).default(30 * 86_400_000).describe('How long a refresh token lasts.'),
  HARNESS_SIGN_IN_LIMIT: z.number().int().min(1).default(10).describe('Most sign-in attempts from one address in a window.'),
  HARNESS_SIGN_IN_WINDOW: z.number().int().min(1_000).default(60_000).describe('The window sign-in attempts are counted over.'),
  HARNESS_PASSWORD_COST: z.number().int().min(10).max(20).default(15).describe('scrypt\'s cost as a power of two (15: 32 768 rounds).'),
  HARNESS_FILES_SECRET: z.string().min(32).optional().describe('Signs presigned file URLs.'),
});

/** Queues and timing. */
export const queueEnv = env({
  HARNESS_LLM_CONCURRENCY: z.number().int().min(1).default(4).describe('How many LLM calls run at once.'),
  HARNESS_RUN_CONCURRENCY: z.number().int().min(1).default(8).describe('Per system.'),
  HARNESS_TOOL_TIMEOUT: z.number().int().min(1_000).default(30_000).describe('A tool running longer than this stops blocking the agent, if a user is active in the session.'),
  HARNESS_ACTIVE_WINDOW: z.number().int().min(1_000).default(120_000).describe('How recently a user must have been active to count as present.'),
  HARNESS_DEFAULT_PRIORITY: z.enum(PRIORITIES).default('interactive').describe('The priority of work no rule gives one.'),
  HARNESS_TURN_COST: z.number().min(0).default(0.5).describe('The most one turn may spend, in dollars, unless a budget says otherwise.'),
  HARNESS_TURN_TIME: z.number().int().min(1_000).default(600_000).describe('The longest one turn may run, unless a budget says otherwise.'),
  HARNESS_BUDGET_MARGIN: z.number().min(1).default(1.25).describe('Reserve this much more than the estimate before an LLM call.'),
});

/** The system link. */
export const linkEnv = env({
  HARNESS_MAX_FRAME: z.number().int().min(16_384).default(262_144).describe('The largest frame a system link accepts, in bytes.'),
  HARNESS_MAX_CHUNK: z.number().int().min(16_384).default(131_072).describe('The largest chunk a stream is cut into on a system link, in bytes.'),
  HARNESS_HEARTBEAT: z.number().int().min(1_000).default(15_000).describe('How often a system link is pinged; a link that misses a pong is dropped.'),
  HARNESS_PAIRING_TIMEOUT: z.number().int().min(10_000).default(600_000).describe('How long a pairing request waits for an admin.'),
  HARNESS_PAIRING_GRANT_TTL: z.number().int().min(5_000).default(60_000).describe('How long a pairing token granted to an approved install run stays good.'),
  HARNESS_STOP_TIMEOUT: z.number().int().min(100).default(10_000).describe('How long an installed system has to stop before it is killed.'),
  HARNESS_RESTART_BACKOFF: z.number().int().min(100).default(2_000).describe('The first delay before an installed system that exited is started again.'),
  HARNESS_RESTARTS_PER_HOUR: z.number().int().min(1).default(10).describe('Most restarts of one installed system in an hour before it is left stopped.'),
  HARNESS_RESTART_BACKOFF_MAX: z.number().int().min(100).default(300_000).describe('The longest wait before an installed system that keeps crashing is started again.'),
  HARNESS_PROCESS_OUTPUT_TAIL: z.number().int().min(256).default(8_192).describe('How many characters of what an installed system printed are kept for the admin page when it exits.'),
});

/** Models, embeddings and the index. */
export const modelEnv = env({
  OPENROUTER_API_KEY: z.string().optional().describe('An OpenRouter key; configures the openrouter provider on first start.'),
  HARNESS_TRANSCRIBE_MODEL: z.string().default('').describe('The model voice input is transcribed with: a model with hearing from a configured provider (for example whisper-1 on OpenAI). Empty turns voice input off.'),
  HARNESS_DEFAULT_MODEL: z.string().default('openrouter/auto').describe('The model the chat agent uses until an admin picks one.'),
  HARNESS_EMBEDDER_DOCUMENT: z.string().default('embedder/document').describe('The embedder that embeds indexed text (documents): a qualified embedder name from a system.'),
  HARNESS_EMBEDDER_QUERY: z.string().default('embedder/query').describe('The embedder that embeds search text (queries), in the same vector space as the document embedder.'),
  HARNESS_EMBED_BATCH: z.number().int().min(1).default(32).describe('Most texts in one embed batch.'),
  HARNESS_SUGGESTIONS: z.number().int().min(0).default(6).describe('How many fns and context the composer suggests.'),
});

/** Logging. */
export const logEnv = env({
  HARNESS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info').describe('The lowest level that is logged.'),
  HARNESS_LOG_JSON: z.boolean().default(false).describe('Log JSON lines instead of readable text.'),
  HARNESS_LOG_FILES: z.boolean().default(true).describe('Also write logs to daily files in the log folder.'),
  HARNESS_LOG_KEEP: z.number().int().min(1).default(7).describe('How many daily log files to keep.'),
});

/** Web push (VAPID). Keys are generated and stored when not given. */
export const pushEnv = env({
  HARNESS_VAPID_PUBLIC: z.string().optional().describe('The web push public key. Made and stored when not given.'),
  HARNESS_VAPID_PRIVATE: z.string().optional().describe('The web push private key. Made and stored when not given.'),
  HARNESS_VAPID_SUBJECT: z.string().default('mailto:admin@localhost').describe('The contact web push services are given.'),
});

/** Every slice by name, so each module takes its own and an admin page can list them. Module slices live beside their module. */
export const HUB_ENV = { hubEnv, httpEnv, authEnv, queueEnv, linkEnv, modelEnv, logEnv, pushEnv, storeEnv, executionEnv, chatEnv, indexEnv, contextorEnv, resourcesEnv, mcpEnv, packagingEnv, queryEnv, connectionsEnv, fnsEnv, reviewEnv, dataEnv } as const;

/**
 * Every slice as one view (`mergeEnvs`): `parse` reports every bad value of every slice in one `EnvError`, `set`
 * reaches every slice, `describe` lists every tunable (the source of `.env.example`), and two slices declaring the
 * same key fail to compile.
 */
export const HUB_SETTINGS = mergeEnvs(hubEnv, httpEnv, authEnv, queueEnv, linkEnv, modelEnv, logEnv, pushEnv, storeEnv, executionEnv, chatEnv, indexEnv, contextorEnv, resourcesEnv, mcpEnv, packagingEnv, queryEnv, connectionsEnv, fnsEnv, reviewEnv, dataEnv);

/** The parsed hub settings, by slice, derived from the slices (never written by hand). */
export type HubSettings = { [K in keyof typeof HUB_ENV]: ReturnType<(typeof HUB_ENV)[K]['parse']> };

/** Every key of every slice in `HUB_ENV`. */
type SliceKeys = { [K in keyof HubSettings]: keyof HubSettings[K] }[keyof HubSettings];
/** The merged view covers exactly the slices of `HUB_ENV`: a slice added to one and not the other fails to compile. */
export type HubSettingsCoverSlices = Covers<[SliceKeys] extends [MergedKeys] ? ([MergedKeys] extends [SliceKeys] ? true : false) : false>;
type MergedKeys = keyof ReturnType<typeof HUB_SETTINGS.parse>;
type Covers<T extends true> = T;

/** Parse one slice per name, keeping each slice's own typed result. */
function parseEach<T extends Readonly<Record<string, { parse(): object }>>>(slices: T): { [K in keyof T]: ReturnType<T[K]['parse']> } {
  const parsed = Object.fromEntries(Object.entries(slices).map(([name, slice]) => [name, slice.parse()]));
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- one entry per slice, each its own parse()
  return parsed as { [K in keyof T]: ReturnType<T[K]['parse']> };
}

/**
 * Parse every slice. Values come from the environment, over anything given to `HUB_SETTINGS.set` (boot gives it the
 * `.env` file). Throws one aggregated `EnvError` listing every bad value of every slice.
 */
export function parseHubSettings(): HubSettings {
  HUB_SETTINGS.parse();
  return parseEach(HUB_ENV);
}
