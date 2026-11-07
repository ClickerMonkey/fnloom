/**
 * `@harness/sdk/server`: running a system. `serve(contract, impl, options)` connects to the hub (pairing the first
 * time), sends the manifest, and serves the implementation over the system link. The implementation is checked
 * against the contract at compile time.
 *
 * The runtime sits behind `SystemHost`; `LinkHost` is the real one (the WebSocket link, pairing keys, the outcome
 * journal, the forwarding aeye provider, the MCP face). Its seams (`LinkHostDeps`) let tests run all of it in memory.
 */
import type { Duration, QualifiedName } from '@harness/core';
import type { FnDef, FnTypes } from '../fn.ts';
import type { FnImpl } from '../impl.ts';
import type { AnyFnRef, FnRef } from '../refs.ts';
import type { ContractShape, SystemContract, SystemImpl } from '../system.ts';
import type { FilesFactory } from './files.ts';
import { LinkHost } from './host.ts';

/** How a system process connects. */
export interface ServeOptions {
  /** The hub's link URL: `ws://hub:4300/link`. */
  hub: string;
  /** The folder where the system keeps its key pair and outcome journal. */
  state: string;
  /** The system's version; defaults to the version in the current folder's `package.json`. */
  version?: string;
  /** A one-time pairing token, if an admin made one. Otherwise the system logs a pairing code and link. */
  pairingToken?: string;
  /** The folder of the built client assets (`buildClient`'s output), if the system has renderers. */
  client?: string;
  /** Also serve the system's native fns as an MCP server. */
  mcp?: McpServe;
  /** After this long without a connection, the system logs that the hub is unreachable (it keeps retrying). Default 10 s. */
  connectTimeout?: Duration;
  /** The `ctx.files` each run gets. Default: the local disk, relative to the current folder. */
  files?: FilesFactory;
  /** The `ctx.fetch` each run gets. Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** Where the MCP face listens: stdin/stdout, or HTTP (JSON-RPC over POST) on a port. */
export type McpServe = { stdio: true } | { http: { port: number; host?: string } };

/** Where a running system is. */
export type RunningStatus = 'connecting' | 'pairing' | 'needs-config' | 'connected' | 'disconnected' | 'stopped';

/** A running system. */
export interface RunningSystem<N extends string> {
  readonly name: N;
  readonly status: RunningStatus;
  /** Calls `listener` on every status change; returns the unsubscribe. */
  onStatus(listener: (status: RunningStatus) => void): () => void;
  /** Resolves once connected, configured and the contract is imported. */
  ready(): Promise<void>;
  /** Add a native fn at runtime. Returns its ref. */
  add<const K extends string, T extends FnTypes & { kind: 'native' }>(name: K, def: FnDef<T>, impl: FnImpl<T>): Promise<FnRef<QualifiedName<N, K>, T['args'], T['result'], T['handlers']>>;
  /** Add a fn of some kind at runtime (no implementation: its kind runs it). */
  add<const K extends string, T extends FnTypes>(name: K, def: FnDef<T>): Promise<FnRef<QualifiedName<N, K>, T['args'], T['result'], T['handlers']>>;
  /** Remove a fn added at runtime. */
  remove(fn: AnyFnRef): Promise<void>;
  /** Restart the process. It reconnects and the hub imports what changed. */
  restart(reason: string): Promise<never>;
  stop(): Promise<void>;
}

/** Runs systems. `LinkHost` is the real one; tests pass their own. */
export interface SystemHost {
  start<N extends string, C extends ContractShape>(contract: SystemContract<N, C>, impl: SystemImpl<C>, options: ServeOptions): Promise<RunningSystem<N>>;
}

/** A system's signing key pair, kept in its state folder. */
export interface KeyStore {
  /** The public key (Ed25519, SPKI DER, base64), making the pair on first use. */
  publicKey(): Promise<string>;
  /** Sign a challenge nonce. */
  sign(nonce: string): Promise<string>;
}

/**
 * Run a system: connect to the hub (pairing the first time), send the contract, and serve the implementation.
 * The implementation is checked against the contract at compile time.
 */
export function serve<N extends string, C extends ContractShape>(contract: SystemContract<N, C>, impl: SystemImpl<C>, options: ServeOptions, host: SystemHost = new LinkHost()): Promise<RunningSystem<N>> {
  return host.start(contract, impl, options);
}

export { LinkHost, SystemStopped, type LinkHostDeps } from './host.ts';
export { errorFieldFilter } from './log.ts';
export { sdkEnv, SYSTEM_ENV, systemFields, type SdkEnv } from './env.ts';
export { FileKeyStore, MemoryKeyStore, verifyNonce } from './keys.ts';
export { FileJournal, MemoryJournal, type OutcomeJournal } from './journal.ts';
export { WsLinkTransport, type HubAccess, type HubLink, type LinkSocket, type LinkTransport } from './link.ts';
export {
  HarnessProvider, HubLlm, HubLlmError, harnessAi, harnessAiOf, wireRequest, HUB_MODEL, type HarnessAi, type HarnessMetadata, type HarnessProviderConfig,
} from './llm.ts';
export { NodeFiles, fileUri, mimeOf, type FilesFactory, type FilesScope } from './files.ts';
export { NodeProcess, type ProcessControl } from './process.ts';
export { StateConflict } from './state.ts';
export { McpFace } from './mcp.ts';
export { LinkGap, InvalidValue } from './wire.ts';
export { readClientBundle, CLIENT_ENTRY, type ClientBundle } from './assets.ts';
