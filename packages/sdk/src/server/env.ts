/**
 * The SDK runtime's tunables, as an `@ayepi/env` slice. Defaults live in the schema; a system process can override any
 * of them through its environment. Durations are milliseconds.
 */
import { join, resolve } from 'node:path';
import { env } from '@ayepi/env';
import { InstanceName, MAIN_INSTANCE } from '@harness/core';
import { z } from 'zod';
import { PAIRING_QR_MODES } from './pairing.ts';

/**
 * The variables that tell a system process where its hub is, where to keep its state, and whether the hub supervises
 * it. The hub's supervisor sets them for systems it installs; `npm run dev` sets them for the dev systems. One record,
 * so the names can't drift.
 */
export const SYSTEM_ENV = {
  hub: 'HARNESS_HUB',
  state: 'HARNESS_SYSTEM_STATE',
  /** Which copy of the system this process is (`main` when unset); a fleet's instances each have their own. */
  instance: 'HARNESS_INSTANCE',
  /** The instance's own data folder, outside the package, kept across upgrades and exported with its data. */
  data: 'HARNESS_SYSTEM_DATA',
  /** The instance's cache folder: rebuildable, never exported. */
  cache: 'HARNESS_SYSTEM_CACHE',
  name: 'HARNESS_SYSTEM_NAME',
  pairingToken: 'HARNESS_PAIRING_TOKEN',
  supervised: 'HARNESS_SUPERVISED',
  restartCode: 'HARNESS_RESTART_CODE',
} as const;

/** The exit code a supervised system exits with to ask the hub for a restart, unless the hub sets another. */
export const RESTART_CODE = 75;

/**
 * The instance's folders a hub that runs it names: data (`ctx.dataDir`, kept across upgrades and exported) and cache
 * (`ctx.cacheDir`, rebuildable, never exported). Unset, they are `data` and `cache` in the state folder
 * (`placeFolders`). One schema for both the SDK's slice and each system's (`systemFields`).
 */
const placeFields = {
  [SYSTEM_ENV.data]: z.string().min(1).optional(),
  [SYSTEM_ENV.cache]: z.string().min(1).optional(),
} as const;

/**
 * An instance's data and cache folders, as absolute paths: the ones the hub named, else `data` and `cache` in its
 * state folder. The SDK gives these to `ctx.dataDir` and `ctx.cacheDir`; a system that needs a folder before it
 * serves (to build its renderers into the cache) asks here, so the two never disagree.
 */
export function placeFolders(state: string, named: { readonly [SYSTEM_ENV.data]?: string | undefined; readonly [SYSTEM_ENV.cache]?: string | undefined }): { dataDir: string; cacheDir: string } {
  return {
    dataDir: resolve(named[SYSTEM_ENV.data] ?? join(state, 'data')),
    cacheDir: resolve(named[SYSTEM_ENV.cache] ?? join(state, 'cache')),
  };
}

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
  /** Which copy of the system this process is: `main` unless it is one of a fleet. */
  [SYSTEM_ENV.instance]: InstanceName.default(MAIN_INSTANCE),
  ...placeFields,
  /** Set by the hub when it starts an installed system: restarting means exiting, and the hub starts it again. */
  [SYSTEM_ENV.supervised]: z.boolean().default(false),
  /** The exit code that asks a supervising hub for a restart. */
  [SYSTEM_ENV.restartCode]: z.number().int().min(1).max(255).default(RESTART_CODE),
  /** When a waiting system prints its pairing link as a QR code: on a terminal (`auto`), `always`, or `never` (logged only). */
  HARNESS_PAIRING_QR: z.enum(PAIRING_QR_MODES).default('auto'),
  HARNESS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HARNESS_LOG_JSON: z.boolean().default(false),
});

/** The parsed SDK tunables. */
export type SdkEnv = ReturnType<typeof sdkEnv.parse>;

/**
 * The link fields of a system's env slice, for spreading into it, followed by its state folder in a group of its own
 * (`systemState`): `env({ ...systemFields(), FS_SHELL: … }).add(systemState('fs'))`. The hub defaults to this
 * machine's default port, the instance to `main`.
 */
export function systemFields() {
  return {
    /** The hub: its link URL, or its http(s) address (`http://127.0.0.1:4300`), which becomes `ws://…/link`. */
    [SYSTEM_ENV.hub]: z.string().default('ws://127.0.0.1:4300/link'),
    /** Which copy of the system this process is: `main` unless it is one of a fleet. */
    [SYSTEM_ENV.instance]: InstanceName.default(MAIN_INSTANCE),
    /** A one-time pairing token an admin made, if any. */
    [SYSTEM_ENV.pairingToken]: z.string().optional(),
    ...placeFields,
  } as const;
}

/** The state folder an instance gets when none is named: `.harness/systems/<name>` for `main`, else `/<instance>` in it. */
export function defaultStateFolder(name: string, instance: InstanceName): string {
  return instance === MAIN_INSTANCE ? `.harness/systems/${name}` : `.harness/systems/${name}/${instance}`;
}

/**
 * A system's state folder, where it keeps its key pair, outcome journal and anything else it stores: the one named
 * (the hub's supervisor and `npm run dev` always name one), else `defaultStateFolder`, so two instances started by
 * hand on one machine never share a key pair. A group of its own because it reads the instance (`systemFields`).
 */
export function systemState(name: string) {
  return {
    [SYSTEM_ENV.state]: (e: { readonly [SYSTEM_ENV.instance]: InstanceName }) => z.string().default(defaultStateFolder(name, e[SYSTEM_ENV.instance])),
  } as const;
}
