/**
 * `@harness/sdk/server`: running a system. `serve(contract, impl, options)` connects to the hub (pairing the first
 * time), sends the manifest, and serves the implementation over the system link. The implementation is checked
 * against the contract at compile time.
 *
 * The runtime sits behind `SystemHost`; `LinkHost` is the real one (the WebSocket link, pairing keys, the outcome
 * journal, the forwarding aeye provider, the MCP face). Its seams (`LinkHostDeps`) let tests run all of it in memory.
 */
import type { AutoPairGrant, Duration, FnExamplesPatch, HostRefusal, ImportReport, PairingGrant, PairingGrantRequest, QualifiedName, TypeDecl } from '@harness/core';
import type { Fleets, FnSearch, InstanceConnects } from '../ctx.ts';
import type { FnDef, FnTypes } from '../fn.ts';
import type { FnImpl } from '../impl.ts';
import type { AnyFnRef, FnRef } from '../refs.ts';
import type { ContractShape, SystemContract, SystemImpl } from '../system.ts';
import type { FilesFactory } from './files.ts';
import type { HarnessAi } from './llm.ts';
import type { SystemPatch } from './table.ts';
import { join } from 'node:path';
import { CONTEXT_FOLDER } from './context-files.ts';
import { LinkHost } from './host.ts';
import type { RunningStatus } from './supervise.ts';
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
  /**
   * The system's context folder (markdown files with YAML headers, `context-files.ts`), sent as its context; `false`
   * for none. Default: `context/` beside its `system.json`, when there is one. A folder with problems stops the start;
   * with `HARNESS_CONTEXT_WATCH` its changes go to the hub live.
   */
  context?: string | false;
}

/** Where the MCP face listens: stdin/stdout, or MCP Streamable HTTP on a port (any path; body limit `HARNESS_MCP_MAX_BODY`). */
export type McpServe = { stdio: true } | { http: { port: number; host?: string } };


/** A running system. It searches the hub and lists its fleet (every paired instance) as the system itself. */
export interface RunningSystem<N extends string> extends FnSearch, Fleets, InstanceConnects {
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
  /** Remove a fn: one added at runtime, or one of the contract's (it is no longer declared or run until a patch adds it back). */
  remove(fn: AnyFnRef): Promise<void>;
  /**
   * Change any declarations while running, in core's shapes: add or replace entries by name in any section (context
   * by its stable key, settings, kind fns, …), remove entries (the contract's too), replace the providers, registries
   * or contributions lists, or say the resource roots changed. Checked here first; the hub keeps static and runtime
   * entries in the same records. While offline the change rides in the next manifest. Native fns go through `add`.
   */
  patch(change: SystemPatch): Promise<ImportReport>;
  /**
   * Add or replace (by `key`) and remove examples of one of this system's fns, by local name, in the hub's
   * `fnExamples` (the hub embeds and pages them). Waits for the hub.
   */
  examples(fn: string, change: { upsert?: FnExamplesPatch['upsert']; remove?: readonly string[] }): Promise<{ added: number; removed: number }>;
  /**
   * Ask the hub for a one-time pairing token bound to what an approved install run was approved for (`grantPairing`).
   * Refused unless `request.run` is this instance's running run whose approval's subject is `request.subject`.
   */
  grantPairing(request: PairingGrantRequest): Promise<PairingGrant>;
  /**
   * Report what this host's supervisor refused on the machine for an instance it hosts (`reportRefusal`): a host
   * outside its `grants.network`, a path outside its `grants.files`. Refused unless this instance hosts it.
   */
  reportRefusal(refusal: HostRefusal): Promise<void>;
  /** An `@aeye/ai` instance backed by the hub with its models listed; calls are the system's own, on its budget (`hubAi`). */
  ai(): Promise<HarnessAi>;
  /**
   * Add or replace types at runtime (a database's table types, each with its `instance`) and remove types added this
   * way, by local name. While offline they ride in the next manifest. Throws when the hub refuses one.
   */
  types(upsert: readonly TypeDecl[], remove: readonly string[]): Promise<void>;
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
  /** The auto-pair secret the hub granted, if any, to re-pair with when the hub doesn't know this key. */
  autoPair(): Promise<AutoPairGrant | undefined>;
  /** Keep the newest grant (each welcome may rotate it), or forget it (`undefined`) once the hub refused it. */
  saveAutoPair(grant: AutoPairGrant | undefined): Promise<void>;
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
  return host.start(contract, impl, {
    ...options, version: options.version ?? manifest.version, context: options.context ?? join(options.package ?? process.cwd(), CONTEXT_FOLDER),
  });
}

/**
 * aeye through the hub anywhere in a system's process (background jobs, timers, startup): an `@aeye/ai` instance
 * whose provider is the hub, with the hub's models and roles listed. Calls are attributed to the system and paid by
 * its own budget; inside a run use `ctx.ai()`, so the run pays.
 */
export function hubAi(system: Pick<RunningSystem<string>, 'ai'>): Promise<HarnessAi> {
  return system.ai();
}

export type { SystemPatch } from './table.ts';
export {
  CONTEXT_FOLDER, ContextFolderError, contextChange, contextProblem, formatContextProblem, parseContextFile, positionOf, readContextFolder, watchContextFolder, type ContextWatchOptions,
  type ContextFile, type ContextFolder, type ContextWatchEvents,
} from './context-files.ts';
export { checkContextFolder, contextFolderLinks, type CheckedContext, type KnownNames } from './context-check.ts';
export { LinkHost, SystemStopped, loggedHost, type LinkHostDeps, type LoggedHost } from './host.ts';
export { placeFolders, RESTART_CODE, sdkEnv, SYSTEM_ENV, systemFields, systemState, defaultStateFolder, type SdkEnv } from './env.ts';
export { contentHash, contentHasher, type ContentHasher } from './content.ts';
export { AUTO_PAIR_FILE, FileKeyStore, isPublicKey, KEY_FILE, makeKeyPair, MemoryKeyStore, signNonce, StoredKeyPair, verifyNonce } from './keys.ts';
export { FileJournal, MemoryJournal, type OutcomeJournal } from './journal.ts';
export { WsLinkTransport, type HubAccess, type HubLink, type LinkSocket, type LinkTransport } from './link.ts';
export {
  HarnessProvider, HubLlm, HubLlmError, HubModelLink, HubModels, aeyeModelOf, harnessAi, harnessAiOf, hubAiOf, hubModelId, roleModelId, wireRequest, HUB_MODEL,
  type HarnessAi, type HarnessMetadata, type HarnessProviderConfig, type ModelLink,
} from './llm.ts';
export {
  LlmWire, UNSENDABLE_CONTENT, messageFromWire, requestFromWire, isObjectSchema, descriptorsOf, applyDescriptors, usageToWire, usageFromWire, chunkToWire,
  chunkFromWire, responseToWire, type LlmWireOptions, type LlmDescriptors,
} from './llm-wire.ts';
export { ProviderServer, providerErrorKind, type ProviderServerParts } from './providers.ts';
export { NodeFiles, fileUri, uriInstance, mimeOf, type FilesFactory, type FilesScope } from './files.ts';
export { NodeProcess, type ProcessControl } from './process.ts';
export {
  AccessDeniedReader, BASIC_ENV, CrashPolicy, RunningStatus, SHARED_ENV, STATUS_LOG, NodeStarter, permissionArgs, scrubbedEnv, statusOfLine,
  type AccessDenied, type CrashPolicyOptions, type ExitDecision, type NodeStarterOptions, type ProcessCommand, type ProcessExit, type ProcessGrants, type ProcessStarter, type SupervisedProcess,
} from './supervise.ts';
export { AllowlistProxy, hostAllowed, proxyEnv, type AllowlistProxyOptions, type ProxyRefusal } from './proxy.ts';
export { StateConflict } from './state.ts';
export { McpFace, mcpToolNameOf, type McpLimits } from './mcp.ts';
export {
  LogPairingDisplay, TerminalPairingDisplay, PAIRING_QR_MODES, codeBanner, pairingDisplayFor, terminalQr,
  type PairingDisplay, type PairingShown, type PairingQrMode, type QrRenderer,
} from './pairing.ts';
export { LinkGap, InvalidValue } from './wire.ts';
export { resultBlock, type ResultBlockOptions } from './results.ts';
export { readClientBundle, CLIENT_ENTRY, type ClientBundle } from './assets.ts';
export {
  PackageManifestError, parsePackageManifest, readPackageManifest, findPackageManifest, packageProblems, checkPackage, builtPackageManifest,
  packedPackageManifest, packageFileProblems, packageManifestText, type BuiltEntries,
} from './package.ts';
export {
  addressVerdict, followRedirects, isLocalName, isPrivateAddress, systemLookup, REDIRECT_STATUSES, type AddressRefusal, type AddressRules, type AddressVerdict,
  type FollowedResponse, type HostLookup, type RedirectOptions, type RedirectProblems,
} from './address.ts';
export { rendererFolder, type RendererPlace } from './renderers.ts';
export {
  AUTHORING_STAGES, AuthoringError, AuthoringSession, Disclosure, authoredFn, authoringAgent, authoringEnv, authoringTool,
  type AuthoredFn, type AuthoringAgent, type AuthoringAgentInput, type AuthoringStage, type AuthoringTool, type AuthoringToolInput, type DraftCheck, type ToolStage, type SkippableStage,
} from '../authoring.ts';
