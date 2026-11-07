/**
 * The SDK runtime's tunables, as an `@ayepi/env` slice. Defaults live in the schema; a system process can override any
 * of them through its environment. Durations are milliseconds.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/**
 * The variables that tell a system process where its hub is, where to keep its state, and whether the hub supervises
 * it. The hub's supervisor sets them for systems it installs; `npm run dev` sets them for the dev systems. One record,
 * so the names can't drift.
 */
export const SYSTEM_ENV = {
  hub: 'HARNESS_HUB',
  state: 'HARNESS_SYSTEM_STATE',
  name: 'HARNESS_SYSTEM_NAME',
  pairingToken: 'HARNESS_PAIRING_TOKEN',
  supervised: 'HARNESS_SUPERVISED',
  restartCode: 'HARNESS_RESTART_CODE',
} as const;

/** The exit code a supervised system exits with to ask the hub for a restart, unless the hub sets another. */
export const RESTART_CODE = 75;

export const sdkEnv = env({
  /** How often the link pings the hub; a missed pong reconnects. */
  HARNESS_LINK_HEARTBEAT: z.number().int().min(1_000).default(15_000),
  /** How long to wait for a pong before reconnecting. */
  HARNESS_LINK_HEARTBEAT_TIMEOUT: z.number().int().min(500).default(10_000),
  /** First reconnect delay; it doubles up to the max. */
  HARNESS_LINK_BACKOFF: z.number().int().min(10).default(500),
  HARNESS_LINK_BACKOFF_MAX: z.number().int().min(100).default(30_000),
  /** Largest frame and chunk assumed until the hub's welcome sets its own limits. */
  HARNESS_LINK_MAX_FRAME: z.number().int().min(1_024).default(1_000_000),
  HARNESS_LINK_MAX_CHUNK: z.number().int().min(1_024).default(256_000),
  /** How long without a connection before the system logs that the hub is unreachable; `ServeOptions.connectTimeout` overrides it. */
  HARNESS_CONNECT_TIMEOUT: z.number().int().min(100).default(10_000),
  /** How long a call through the MCP face may run. */
  HARNESS_MCP_TIMEOUT: z.number().int().min(1_000).default(600_000),
  /** The largest request body the MCP face accepts over HTTP, in bytes. */
  HARNESS_MCP_MAX_BODY: z.number().int().min(1_024).default(1_048_576),
  /** Outcomes kept in the journal, so a run the hub sends again after a reconnect isn't run twice. */
  HARNESS_JOURNAL_SIZE: z.number().int().min(10).default(2_000),
  /** Tries for a session state update when other writes keep getting in first. */
  HARNESS_STATE_RETRIES: z.number().int().min(1).default(8),
  /** Config versions kept, so a run keeps the value it started with. */
  HARNESS_CONFIG_VERSIONS: z.number().int().min(1).default(8),
  /** Largest resource text sent inline; longer text is served by content ref. */
  HARNESS_INLINE_TEXT: z.number().int().min(1_024).default(256_000),
  /** Bytes of content kept for the hub to fetch by ref. */
  HARNESS_CONTENT_CACHE: z.number().int().min(1_024).default(64_000_000),
  /** Set by the hub when it starts an installed system: restarting means exiting, and the hub starts it again. */
  [SYSTEM_ENV.supervised]: z.boolean().default(false),
  /** The exit code that asks a supervising hub for a restart. */
  [SYSTEM_ENV.restartCode]: z.number().int().min(1).max(255).default(RESTART_CODE),
  HARNESS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HARNESS_LOG_JSON: z.boolean().default(false),
});

/** The parsed SDK tunables. */
export type SdkEnv = ReturnType<typeof sdkEnv.parse>;

/**
 * The link fields of a system's env slice, for spreading into it: `env({ ...systemFields('fs'), FS_SHELL: … })`.
 * State defaults to `.harness/systems/<name>`, the hub to this machine's default port.
 */
export function systemFields(name: string) {
  return {
    /** The hub's link URL. */
    [SYSTEM_ENV.hub]: z.string().default('ws://127.0.0.1:4300/link'),
    /** Where the system keeps its key pair, outcome journal and anything else it stores. */
    [SYSTEM_ENV.state]: z.string().default(`.harness/systems/${name}`),
    /** A one-time pairing token an admin made, if any. */
    [SYSTEM_ENV.pairingToken]: z.string().optional(),
  } as const;
}
