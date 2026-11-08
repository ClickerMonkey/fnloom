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
import { SYSTEM_ENV, sdkEnv } from './env.ts';
import { checkPackage, findPackageManifest } from './package.ts';

/** How a system process connects. */
export interface ServeOptions {
  /** The hub: its link URL (`ws://hub:4300/link`) or its own address (`http://hub:4300`), which becomes that link. */
  hub: string;
  /** The folder where the system keeps its key pair and outcome journal. */
  state: string;
  /**
   * The system's version. Defaults to its `system.json`'s, then to the version in the current folder's
   * `package.json`.
   */
  version?: string;
  /**
   * The folder holding the system's `system.json` (default: the current folder). When there is one, `serve` checks it
   * against the contract (the same name, a protocol this SDK speaks) before connecting, and takes its version.
   */
  package?: string;
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

/** Where the MCP face listens: stdin/stdout, or MCP Streamable HTTP on a port (any path; body limit `HARNESS_MCP_MAX_BODY`). */
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
 * The implementation is checked against the contract at compile time; its `system.json`, when it has one, is checked
 * against the contract and this process's instance here (a mismatch throws `PackageManifestError` before anything
 * connects).
 */
export async function serve<N extends string, C extends ContractShape>(contract: SystemContract<N, C>, impl: SystemImpl<C>, options: ServeOptions, host: SystemHost = new LinkHost()): Promise<RunningSystem<N>> {
  const manifest = await findPackageManifest(options.package ?? process.cwd());
  if (manifest === undefined) { return host.start(contract, impl, options); }
  checkPackage(contract, manifest, sdkEnv.parse()[SYSTEM_ENV.instance]);
  return host.start(contract, impl, { ...options, version: options.version ?? manifest.version });
}

export { LinkHost, SystemStopped, loggedHost, type LinkHostDeps, type LoggedHost } from './host.ts';
export { placeFolders, RESTART_CODE, sdkEnv, SYSTEM_ENV, systemFields, systemState, defaultStateFolder, type SdkEnv } from './env.ts';
export { contentHash, contentHasher, type ContentHasher } from './content.ts';
export { FileKeyStore, isPublicKey, KEY_FILE, makeKeyPair, MemoryKeyStore, signNonce, StoredKeyPair, verifyNonce } from './keys.ts';
export { FileJournal, MemoryJournal, type OutcomeJournal } from './journal.ts';
export { WsLinkTransport, type HubAccess, type HubLink, type LinkSocket, type LinkTransport } from './link.ts';
export {
  HarnessProvider, HubLlm, HubLlmError, HubModels, harnessAi, harnessAiOf, wireRequest, HUB_MODEL, type HarnessAi, type HarnessMetadata, type HarnessProviderConfig,
} from './llm.ts';
export {
  LlmWire, UNSENDABLE_CONTENT, messageFromWire, requestFromWire, isObjectSchema, descriptorsOf, applyDescriptors, usageToWire, usageFromWire, chunkToWire,
  chunkFromWire, responseToWire, type LlmWireOptions, type LlmDescriptors,
} from './llm-wire.ts';
export { NodeFiles, fileUri, uriInstance, mimeOf, type FilesFactory, type FilesScope } from './files.ts';
export { NodeProcess, type ProcessControl } from './process.ts';
export { StateConflict } from './state.ts';
export { McpFace, mcpToolNameOf, type McpLimits } from './mcp.ts';
export {
  LogPairingDisplay, TerminalPairingDisplay, PAIRING_QR_MODES, codeBanner, pairingDisplayFor, terminalQr,
  type PairingDisplay, type PairingShown, type PairingQrMode, type QrRenderer,
} from './pairing.ts';
export { LinkGap, InvalidValue } from './wire.ts';
export { readClientBundle, CLIENT_ENTRY, type ClientBundle } from './assets.ts';
export {
  PackageManifestError, parsePackageManifest, readPackageManifest, findPackageManifest, packageProblems, checkPackage, builtPackageManifest,
  packedPackageManifest, packageFileProblems, packageManifestText, type BuiltEntries,
} from './package.ts';
export {
  addressVerdict, followRedirects, isLocalName, isPrivateAddress, systemLookup, REDIRECT_STATUSES, type AddressRefusal, type AddressRules, type AddressVerdict,
  type FollowedResponse, type HostLookup, type RedirectOptions, type RedirectProblems,
} from './address.ts';
