/**
 * `@harness/sdk/server`: running a system. `serve(contract, impl, options)` connects to the hub (pairing the first
 * time), sends the manifest, and serves the implementation over the system link. The implementation is checked
 * against the contract at compile time.
 *
 * The runtime sits behind `SystemHost`, so tests and other transports can supply their own. The SDK lane implements
 * `LinkHost` (WebSocket link, pairing keys, outcome helpers, the forwarding aeye provider, MCP face).
 */
import type { Duration, QualifiedName } from '@harness/core';
import type { FnDef, FnTypes } from '../fn.ts';
import type { FnImpl } from '../impl.ts';
import type { AnyFnRef, FnRef } from '../refs.ts';
import type { ContractShape, SystemContract, SystemImpl } from '../system.ts';

/** How a system process connects. */
export interface ServeOptions {
  /** The hub's link URL: `ws://hub:4300/link`. */
  hub: string;
  /** The folder where the system keeps its key pair and outcome journal. */
  state: string;
  /** The system's version; defaults to its package version. */
  version?: string;
  /** A one-time pairing token, if an admin made one. Otherwise the system prints a pairing code. */
  pairingToken?: string;
  /** The folder of the built client assets, if the system has renderers. */
  client?: string;
  /** Also serve the system as an MCP server. */
  mcp?: { stdio: true } | { http: { port: number } };
  /** How long to wait for the hub before giving up on one connection attempt. */
  connectTimeout?: Duration;
}

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

/** Thrown by parts of the SDK runtime the SDK lane has not built yet. */
export class NotBuilt extends Error {
  override readonly name = 'NotBuilt';
}

/** The WebSocket link host. Its runtime belongs to the SDK lane. */
export class LinkHost implements SystemHost {
  start<N extends string, C extends ContractShape>(contract: SystemContract<N, C>): Promise<RunningSystem<N>> {
    return Promise.reject(new NotBuilt(`serve(${contract.name}): the link runtime is not built yet`));
  }
}

/**
 * Run a system: connect to the hub (pairing the first time), send the contract, and serve the implementation.
 * The implementation is checked against the contract at compile time.
 */
export function serve<N extends string, C extends ContractShape>(contract: SystemContract<N, C>, impl: SystemImpl<C>, options: ServeOptions, host: SystemHost = new LinkHost()): Promise<RunningSystem<N>> {
  return host.start(contract, impl, options);
}
