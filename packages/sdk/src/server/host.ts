/**
 * `LinkHost`: runs a system against a hub over the WebSocket link.
 *
 * On every connection the system says hello (name, its instance, this process start, its public key and its manifest
 * hash). A name the hub has never seen starts pairing: the system logs the code and link and waits for the hub's
 * `paired` call, then says hello again. A known name signs the hub's challenge. Once welcomed, it sends its manifest
 * if the hub's copy is stale (uploading its client renderers first), takes its config, and runs its lifecycle events:
 * `installed` on the first start, `upgraded` on a new version, `started` on every connect with a valid config. Until
 * a valid config is set it waits as `needs-config`.
 *
 * A dropped link reconnects with backoff; runs keep going, and their outcomes wait in the journal for the hub to ask
 * again. Stopping runs `stopping`, lets runs finish within the deadline, cancels the rest, and closes the link.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { updown, type UpDown } from '@ayepi/updown';
import type { Logger } from '@ayepi/log';
import {
  LINK_PROTOCOL, LinkLimits, SYSTEM_EVENT_TYPES, qualify, splitName,
  type ImportReport, type InstanceName, type LogLine, type PairingId, type QualifiedName, type StopReason, type Welcome,
} from '@harness/core';
import type { Log, SystemPlace } from '../ctx.ts';
import { wireType } from '../gin.ts';
import type { FnDef, FnTypes } from '../fn.ts';
import type { FnImpl } from '../impl.ts';
import type { AnyFnRef, FnRef } from '../refs.ts';
import { configTypeOf, type ConfigOf, type ContractShape, type SystemContract, type SystemImpl } from '../system.ts';
import { readClientBundle, uploadClientBundle, type ClientBundle } from './assets.ts';
import { HubContent, LocalContent } from './content.ts';
import { placeFolders, SYSTEM_ENV, sdkEnv, type SdkEnv } from './env.ts';
import { NodeFiles } from './files.ts';
import type { KeyStore, RunningStatus, RunningSystem, ServeOptions, SystemHost } from './index.ts';
import { FileJournal, type OutcomeJournal } from './journal.ts';
import { FileKeyStore } from './keys.ts';
import { hubClient, linkUrl, WsLinkTransport, type HubAccess, type HubLink, type LinkSocket, type LinkTransport } from './link.ts';
import { ScopedLog, systemLogger } from './log.ts';
import { ManifestState } from './manifest-state.ts';
import { McpFace } from './mcp.ts';
import { pairingDisplayFor, type PairingDisplay, type PairingShown } from './pairing.ts';
import { NodeProcess, type ProcessControl } from './process.ts';
import type { RunEnvironment } from './run.ts';
import { RunRegistry } from './runs.ts';
import { ConfigStore, SystemRuntime } from './runtime.ts';
import { implTable, runtimeFnImpl, SystemTable, type RuntimeLifecycle } from './table.ts';
import { Deferred, messageOf, withTimeout } from './wire.ts';

/** The system stopped; nothing more goes to the hub. */
export class SystemStopped extends Error {
  override readonly name = 'SystemStopped';
}

/** The seams `LinkHost` runs on. Every one has a real default; tests replace them. */
/** How long after a pairing request runs out the system asks for a new one (so the hub has marked it expired). */
const PAIRING_RENEW_AFTER = 1_000;

export interface LinkHostDeps {
  /** Opens the socket to the hub. Default: a real WebSocket with backoff and heartbeat. */
  readonly transport?: LinkTransport;
  /** The key store for a state folder. Default: `key.json` in it. */
  readonly keys?: (state: string) => KeyStore;
  /** The outcome journal for a state folder. Default: `journal.jsonl` in it. */
  readonly journal?: (state: string, size: number) => OutcomeJournal;
  readonly process?: ProcessControl;
  readonly now?: () => number;
  /** Stop on SIGINT / SIGTERM / SIGBREAK. Default true. */
  readonly signals?: boolean;
  /** The SDK tunables. Default: `sdkEnv`, read from the environment. */
  readonly env?: SdkEnv;
  /** The process logger. Default: console, plus the hub while connected. */
  readonly logger?: (sink: (line: LogLine) => void) => Logger;
  /** Shows a pending pairing. Default: a QR code on a terminal (`HARNESS_PAIRING_QR`), else a log line. */
  readonly pairing?: PairingDisplay;
  /** Makes the instance's data and cache folders before the system starts. Default: `mkdir -p` each. */
  readonly folders?: (dirs: readonly string[]) => Promise<void>;
}

/** A link host and the process log it serves with. */
export interface LoggedHost {
  readonly host: LinkHost;
  /** The system's process log, with `system` on every line. */
  readonly log: Log;
}

/**
 * A `LinkHost` and the process log it will use, made before `serve` so the parts a system builds ahead of it (HTTP
 * clients, watchers) log through the same `@ayepi/log` logger: structured, sanitized lines on the console at once,
 * and to the hub while connected. Pass `host` to `serve`.
 */
export function loggedHost(name: string, deps: Omit<LinkHostDeps, 'logger'> = {}, output: 'stdout' | 'stderr' = 'stdout'): LoggedHost {
  const env = deps.env ?? sdkEnv.parse();
  let toHub: (line: LogLine) => void = () => undefined;
  const logger = systemLogger({ level: env.HARNESS_LOG_LEVEL, json: env.HARNESS_LOG_JSON, sink: (line) => { toHub(line); }, console: output });
  const host = new LinkHost({ ...deps, env, logger: (sink) => { toHub = sink; return logger; } });
  return { host, log: new ScopedLog(logger, { system: name }) };
}

/** Runs systems over the WebSocket link. */
export class LinkHost implements SystemHost {
  readonly #deps: LinkHostDeps;

  constructor(deps: LinkHostDeps = {}) {
    this.#deps = deps;
  }

  async start<N extends string, C extends ContractShape>(contract: SystemContract<N, C>, impl: SystemImpl<C>, options: ServeOptions): Promise<RunningSystem<N>> {
    const system = new LinkedSystem<N, C>(contract, impl, options, this.#deps);
    await system.start();
    return system;
  }
}

/** The version in the `package.json` of the current folder, if there is one. */
async function packageVersion(): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Make folders (and their parents) that don't exist yet. */
async function makeFolders(dirs: readonly string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
}

/** One system, connected (or connecting) to the hub. */
class LinkedSystem<N extends string, C extends ContractShape> implements RunningSystem<N> {
  readonly name: N;
  readonly #contract: SystemContract<N, C>;
  readonly #options: ServeOptions;
  /** The hub's link URL, read off `options.hub` (which may be the hub's http(s) address). */
  readonly #link: string;
  readonly #deps: LinkHostDeps;
  readonly #env: SdkEnv;
  readonly #logger: Logger;
  readonly #log: ScopedLog;
  /** This process start, so the hub tells a restart from a reconnect. */
  readonly #boot = randomUUID();
  /** The instance this is: asked for from `HARNESS_INSTANCE`, then the name the hub's welcome gives it. */
  #instance: InstanceName;
  #pairingDisplay: PairingDisplay | undefined;
  readonly #stop = new AbortController();
  readonly #statusListeners = new Set<(status: RunningStatus) => void>();
  readonly #table: SystemTable;
  readonly #config: ConfigStore<ConfigOf<C>>;
  readonly #keys: KeyStore;
  readonly #journal: OutcomeJournal;
  readonly #process: ProcessControl;
  readonly #content: LocalContent;
  readonly #lifecycle: RuntimeLifecycle;
  #status: RunningStatus = 'connecting';
  #version = '0.0.0';
  #pairingToken: string | undefined;
  #manifest: ManifestState | undefined;
  #runs: RunRegistry | undefined;
  #runtime: SystemRuntime<C> | undefined;
  #socket: LinkSocket | undefined;
  #hub: HubLink | undefined;
  #bundle: ClientBundle | undefined;
  /** Limits from the SDK tunables until the hub's welcome sets its own. */
  #limits: LinkLimits;
  /** Resolves with the hub once the current connection is welcomed; replaced on every disconnect. */
  #welcomed = new Deferred<HubLink>();
  #ready = new Deferred<void>();
  #connection = 0;
  #pendingStart: Welcome['start'] | undefined;
  #stopping: Promise<void> | undefined;
  #lifecycleRunner: UpDown | undefined;
  #unreachable: ReturnType<typeof setTimeout> | undefined;
  /** Says hello again when the pending pairing request runs out. */
  #pairingRenewal: ReturnType<typeof setTimeout> | undefined;
  #mcp: McpFace | undefined;

  constructor(contract: SystemContract<N, C>, impl: SystemImpl<C>, options: ServeOptions, deps: LinkHostDeps) {
    this.name = contract.name;
    this.#contract = contract;
    this.#options = options;
    this.#link = linkUrl(options.hub);
    this.#deps = deps;
    this.#env = deps.env ?? sdkEnv.parse();
    this.#limits = LinkLimits.parse({ maxFrame: this.#env.HARNESS_LINK_MAX_FRAME, maxChunk: this.#env.HARNESS_LINK_MAX_CHUNK, heartbeat: this.#env.HARNESS_LINK_HEARTBEAT });
    this.#pairingToken = options.pairingToken;
    this.#instance = this.#env[SYSTEM_ENV.instance];
    const sink = (line: LogLine): void => {
      const hub = this.#now();
      if (hub !== undefined) { hub.call('log', line).catch(() => undefined); }
    };
    this.#logger = deps.logger?.(sink) ?? systemLogger({
      level: this.#env.HARNESS_LOG_LEVEL,
      json: this.#env.HARNESS_LOG_JSON,
      sink,
      console: options.mcp !== undefined && 'stdio' in options.mcp ? 'stderr' : 'stdout',
    });
    this.#log = new ScopedLog(this.#logger, { system: contract.name });
    const table = implTable(impl);
    this.#table = new SystemTable(contract, table);
    this.#lifecycle = table.lifecycle ?? {};
    this.#config = new ConfigStore(configTypeOf(contract.defs), this.#env.HARNESS_CONFIG_VERSIONS);
    this.#keys = deps.keys?.(options.state) ?? new FileKeyStore(options.state);
    this.#journal = deps.journal?.(options.state, this.#env.HARNESS_JOURNAL_SIZE) ?? new FileJournal(options.state, this.#env.HARNESS_JOURNAL_SIZE);
    this.#process = deps.process ?? new NodeProcess({ supervised: this.#env.HARNESS_SUPERVISED, restartCode: this.#env.HARNESS_RESTART_CODE });
    this.#content = new LocalContent(this.#env.HARNESS_CONTENT_CACHE);
  }

  get status(): RunningStatus { return this.#status; }

  onStatus(listener: (status: RunningStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => { this.#statusListeners.delete(listener); };
  }

  ready(): Promise<void> {
    return this.#ready.promise;
  }

  /** Connect, and keep connecting. Resolves once the first connection attempt has started. */
  async start(): Promise<void> {
    this.#version = this.#options.version ?? await packageVersion() ?? '0.0.0';
    const events = SYSTEM_EVENT_TYPES.filter((type) => this.#table.impl.events?.[type] !== undefined);
    if (this.#options.client !== undefined) { this.#bundle = await readClientBundle(this.#options.client); }
    this.#manifest = new ManifestState(this.#table, {
      version: this.#version,
      events,
      resources: this.#table.impl.resources !== undefined,
      ...(this.#bundle === undefined ? {} : { client: this.#bundle.assets }),
    });
    const hubAccess = this.#access;
    const content = new HubContent(hubAccess);
    const place = await this.#place();
    const runEnv: RunEnvironment = {
      system: this.name,
      hub: hubAccess,
      content,
      files: this.#options.files ?? NodeFiles.at(process.cwd()),
      fetch: this.#options.fetch ?? globalThis.fetch,
      log: this.#log,
      place,
      stateRetries: this.#env.HARNESS_STATE_RETRIES,
      now: this.#deps.now ?? Date.now,
      config: (version) => this.#config.at(version),
      currentConfig: () => this.#config.current?.version,
    };
    this.#runs = new RunRegistry(this.#table, this.#journal, runEnv);
    this.#runtime = new SystemRuntime<C>({
      table: this.#table,
      runs: this.#runs,
      env: runEnv,
      config: this.#config,
      content: this.#content,
      signal: this.#stop.signal,
      inlineText: this.#env.HARNESS_INLINE_TEXT,
      host: {
        paired: () => { void this.#handshake(this.#connection); },
        restart: (reason) => { void this.restart(reason); },
        stop: (reason, timeout) => this.#stopFromHub(reason, timeout),
        configured: (previous) => this.#configured(previous),
      },
    });
    const transport = this.#deps.transport ?? new WsLinkTransport({
      heartbeat: this.#env.HARNESS_LINK_HEARTBEAT,
      heartbeatTimeout: this.#env.HARNESS_LINK_HEARTBEAT_TIMEOUT,
      backoff: this.#env.HARNESS_LINK_BACKOFF,
      backoffMax: this.#env.HARNESS_LINK_BACKOFF_MAX,
    });
    const socket = transport.open(this.#link);
    this.#socket = socket;
    this.#hub = hubClient(this.#link, socket, this.#runtime.server());
    socket.onState((state) => { this.#onSocket(state); });
    this.#lifecycleRunner = updown({
      signals: this.#deps.signals === false ? false : ['SIGINT', 'SIGTERM', 'SIGBREAK'],
      exit: this.#deps.signals !== false,
      onError: (error, phase, component) => { this.#log.error('system.lifecycle-failed', { phase, component }, error); },
    }).register({ name: 'link', up: () => { socket.connect(); }, pre: () => this.stop() });
    await this.#lifecycleRunner.up();
    this.#watchReachable(socket.state);
    if (this.#options.mcp !== undefined) {
      this.#mcp = new McpFace(this.#table, runEnv, this.#version, { timeout: this.#env.HARNESS_MCP_TIMEOUT, maxBody: this.#env.HARNESS_MCP_MAX_BODY }, this.#runtime);
      await this.#mcp.serve(this.#options.mcp);
    }
  }

  add<const K extends string, T extends FnTypes & { kind: 'native' }>(name: K, def: FnDef<T>, impl: FnImpl<T>): Promise<FnRef<QualifiedName<N, K>, T['args'], T['result'], T['handlers']>>;
  add<const K extends string, T extends FnTypes>(name: K, def: FnDef<T>): Promise<FnRef<QualifiedName<N, K>, T['args'], T['result'], T['handlers']>>;
  async add<const K extends string, T extends FnTypes>(name: K, def: FnDef<T>, impl?: FnImpl<T>): Promise<FnRef<QualifiedName<N, K>, T['args'], T['result'], T['handlers']>> {
    if (def.kind === 'native' && impl === undefined) { throw new Error(`fn ${name} is native, so it needs an implementation.`); }
    this.#table.add(name, def, impl === undefined ? undefined : runtimeFnImpl(impl));
    const hub = this.#now();
    // while offline the fn rides in the next manifest (its hash includes it)
    if (hub !== undefined) {
      try {
        this.#checkReport(await hub.call('patch', await this.#manifestState().upsert(name, def)), qualify(this.name, name));
      } catch (error) {
        this.#table.remove(name);
        throw error;
      }
    }
    return { ref: 'fn', name: qualify(this.name, name), args: def.args, returns: def.returns, handlers: def.handlers };
  }

  async remove(fn: AnyFnRef): Promise<void> {
    const { system, local } = splitName(fn.name);
    if (system !== this.name || !this.#table.remove(local)) { throw new Error(`${fn.name} was not added at runtime by ${this.name}.`); }
    const hub = this.#now();
    if (hub !== undefined) { this.#checkReport(await hub.call('patch', await this.#manifestState().remove(local)), fn.name); }
  }

  async restart(reason: string): Promise<never> {
    this.#log.info('system.restarting', { reason });
    await this.#shutdown('restart', this.#stopTimeout());
    return this.#process.restart();
  }

  stop(): Promise<void> {
    return this.#shutdown('shutdown', this.#stopTimeout());
  }

  // ─── HubAccess ──────────────────────────────────────────────────────────────

  /** How the runtime's parts reach the hub: a welcomed link, waited for across reconnects. */
  readonly #access: HubAccess = {
    ready: (signal) => this.#hubWhenWelcomed(signal),
    now: () => this.#now(),
    limits: () => this.#limits,
  };

  #now(): HubLink | undefined {
    return this.#welcomed.settled && this.#socket?.state === 'open' ? this.#hub : undefined;
  }

  #hubWhenWelcomed(signal?: AbortSignal): Promise<HubLink> {
    if (this.#stop.signal.aborted) { return Promise.reject(new SystemStopped(`${this.name} has stopped.`)); }
    const signals = signal === undefined ? this.#stop.signal : AbortSignal.any([signal, this.#stop.signal]);
    const welcomed = this.#welcomed.promise;
    return new Promise((resolve, reject) => {
      const abort = (): void => { reject(signals.reason instanceof Error ? signals.reason : new SystemStopped(`${this.name} has stopped.`)); };
      if (signals.aborted) {
        abort();
        return;
      }
      signals.addEventListener('abort', abort, { once: true });
      welcomed.then((hub) => {
        signals.removeEventListener('abort', abort);
        resolve(hub);
      }, reject);
    });
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  #onSocket(state: 'open' | 'closed' | 'connecting'): void {
    if (this.#stop.signal.aborted) { return; }
    this.#watchReachable(state);
    if (state === 'open') {
      this.#connection += 1;
      void this.#handshake(this.#connection);
      return;
    }
    if (this.#welcomed.settled) { this.#welcomed = new Deferred<HubLink>(); }
    this.#setStatus(state === 'closed' ? 'disconnected' : 'connecting');
  }

  async #handshake(connection: number): Promise<void> {
    const hub = this.#hub;
    if (hub === undefined || connection !== this.#connection) { return; }
    try {
      this.#setStatus('connecting');
      const reply = await hub.call('hello', {
        protocol: LINK_PROTOCOL,
        name: this.#contract.name,
        version: this.#version,
        instance: this.#instance,
        boot: this.#boot,
        publicKey: await this.#keys.publicKey(),
        manifestHash: await this.#manifestState().hash(),
        ...(this.#pairingToken === undefined ? {} : { pairingToken: this.#pairingToken }),
      });
      if (connection !== this.#connection) { return; }
      if (reply.kind === 'pairing') {
        this.#setStatus('pairing');
        if (reply.code === undefined) {
          // a pairing token: the hub has approved it and will say so (`paired`); nothing for an admin to do
          this.#log.info('system.pairing.token', { pairing: reply.pairing });
        } else {
          await this.#showPairing(hub, reply.pairing, { system: this.name, instance: this.#instance, code: reply.code, url: reply.url, expiresAt: reply.expiresAt });
          this.#renewPairing(connection, reply.expiresAt);
        }
        return;
      }
      const welcome = await hub.call('prove', { signature: await this.#keys.sign(reply.nonce) });
      if (connection !== this.#connection) { return; }
      this.#pairingToken = undefined;
      await this.#welcome(hub, welcome);
    } catch (error) {
      if (connection === this.#connection && !this.#stop.signal.aborted) {
        this.#log.error('system.handshake-failed', { error: messageOf(error) });
      }
    }
  }

  async #welcome(hub: HubLink, welcome: Welcome): Promise<void> {
    this.#limits = welcome.limits;
    if (welcome.instance !== this.#instance) {
      this.#log.info('system.instance', { asked: this.#instance, instance: welcome.instance });
      this.#instance = welcome.instance;
    }
    if (welcome.config !== undefined) {
      try {
        this.#config.apply(welcome.config);
      } catch (error) {
        this.#log.error('system.config-invalid', { version: welcome.config.version, error: messageOf(error) });
      }
    }
    this.#welcomed.resolve(hub);
    if (welcome.sendManifest) {
      if (this.#bundle !== undefined) { await uploadClientBundle(this.#bundle, new HubContent(this.#access), this.#stop.signal); }
      const report = await hub.call('manifest', await this.#manifestState().current());
      for (const refused of report.refused) { this.#log.warn('system.import-refused', { name: refused.name, problems: refused.problems }); }
    }
    this.#pendingStart = welcome.start;
    await this.#startIfConfigured();
  }

  /** Run the start lifecycle once a valid config is in. */
  async #startIfConfigured(): Promise<void> {
    const start = this.#pendingStart;
    if (this.#config.current === undefined || start === undefined) {
      this.#setStatus('needs-config');
      return;
    }
    this.#pendingStart = undefined;
    const ctx = this.#systemCtx();
    if (start.first) { await this.#lifecycleEvent('installed', () => this.#lifecycle.installed?.(ctx)); }
    if (start.upgradedFrom !== undefined) {
      const from = start.upgradedFrom;
      await this.#lifecycleEvent('upgraded', () => this.#lifecycle.upgraded?.({ ...ctx, from }));
    }
    await this.#lifecycleEvent('started', () => this.#lifecycle.started?.(ctx));
    this.#setStatus('connected');
    this.#ready.resolve();
  }

  async #configured(previous: unknown): Promise<void> {
    if (this.#pendingStart !== undefined) {
      await this.#startIfConfigured();
      return;
    }
    const ctx = this.#systemCtx();
    await this.#lifecycleEvent('configured', () => this.#lifecycle.configured?.({ ...ctx, previous }));
  }

  // ─── Stopping ───────────────────────────────────────────────────────────────

  async #stopFromHub(reason: StopReason, timeout: number): Promise<void> {
    // reply first, then stop, so the hub hears the answer before the link closes
    setTimeout(() => {
      void (reason === 'restart'
        ? this.restart('the hub asked')
        : this.#shutdown(reason, timeout).then(() => this.#process.exit(0)));
    }, 0);
    return Promise.resolve();
  }

  #shutdown(reason: StopReason, timeout: number): Promise<void> {
    this.#stopping ??= this.#doShutdown(reason, timeout);
    return this.#stopping;
  }

  async #doShutdown(reason: StopReason, timeout: number): Promise<void> {
    const runs = this.#runs;
    if (this.#config.current !== undefined) {
      const ctx = this.#systemCtx();
      await this.#lifecycleEvent('stopping', () => withTimeout(this.#lifecycle.stopping?.({ ...ctx, reason, timeout }), timeout));
      if (reason === 'removed') { await this.#lifecycleEvent('uninstalled', () => withTimeout(this.#lifecycle.uninstalled?.(ctx), timeout)); }
    }
    if (runs !== undefined) {
      await withTimeout(runs.idle(), timeout);
      await runs.cancelAll();
      await withTimeout(runs.idle(), timeout);
    }
    this.#runtime?.unwatchAll();
    clearTimeout(this.#unreachable);
    await this.#mcp?.close();
    this.#stop.abort(new SystemStopped(`${this.name} has stopped.`));
    this.#socket?.close();
    this.#setStatus('stopped');
    await this.#logger.flush();
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Which instance this is and its folders, made if missing: the hub's (`HARNESS_SYSTEM_DATA` / `_CACHE`) for what it
   * installs, else `data` and `cache` in the state folder. `instance` reads the current name, which the welcome sets.
   */
  async #place(): Promise<SystemPlace> {
    const { dataDir, cacheDir } = placeFolders(this.#options.state, this.#env);
    await (this.#deps.folders ?? makeFolders)([dataDir, cacheDir]);
    const instance = (): InstanceName => this.#instance;
    return { get instance() { return instance(); }, dataDir, cacheDir };
  }

  /**
   * Tell the hub what the pairing page should show (description, instance, config type), then show the pairing to
   * the person who approves it. A hub that keeps no pairing info only loses the page's details.
   */
  async #showPairing(hub: HubLink, pairing: PairingId, shown: PairingShown): Promise<void> {
    try {
      await hub.call('pairingInfo', { pairing, description: this.#contract.description, instance: shown.instance, configType: wireType(this.#contract.defs.config) });
    } catch (error) {
      this.#log.warn('system.pairing-info-failed', { error: messageOf(error) });
    }
    this.#pairingDisplay ??= this.#deps.pairing ?? pairingDisplayFor(this.#env.HARNESS_PAIRING_QR, {
      log: this.#log,
      tty: process.stdout.isTTY,
      write: (text) => { process.stdout.write(`${text}\n`); },
    });
    await this.#pairingDisplay.show(shown);
  }

  /**
   * Once a pending pairing request runs out while this connection still waits on it, say hello again: the hub makes a
   * new request, so an instance left waiting shows a fresh link and code instead of one nobody can approve.
   */
  #renewPairing(connection: number, expiresAt: number): void {
    clearTimeout(this.#pairingRenewal);
    const wait = Math.max(0, expiresAt - (this.#deps.now ?? Date.now)()) + PAIRING_RENEW_AFTER;
    this.#pairingRenewal = setTimeout(() => {
      if (connection !== this.#connection || this.#status !== 'pairing' || this.#stop.signal.aborted) { return; }
      this.#log.info('system.pairing.renewed', { instance: this.#instance });
      void this.#handshake(connection);
    }, wait);
    this.#pairingRenewal.unref();
  }

  /** Log once when the hub stays unreachable for `connectTimeout`; the transport keeps retrying. */
  #watchReachable(state: 'open' | 'closed' | 'connecting'): void {
    if (state === 'open') {
      clearTimeout(this.#unreachable);
      this.#unreachable = undefined;
      return;
    }
    if (this.#unreachable !== undefined) { return; }
    const after = this.#options.connectTimeout ?? this.#env.HARNESS_CONNECT_TIMEOUT;
    this.#unreachable = setTimeout(() => {
      if (this.#socket?.state !== 'open' && !this.#stop.signal.aborted) { this.#log.warn('system.hub-unreachable', { hub: this.#link, after }); }
    }, after);
  }

  #systemCtx() {
    if (this.#runtime === undefined) { throw new Error('not started'); }
    return this.#runtime.systemCtx();
  }

  async #lifecycleEvent(event: string, run: () => Promise<unknown> | undefined): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.#log.error('system.lifecycle-failed', { event }, error);
    }
  }

  #checkReport(report: ImportReport, name: QualifiedName): void {
    const refused = report.refused.find((r) => r.name === name || r.name === splitName(name).local);
    if (refused !== undefined) { throw new Error(`The hub refused ${name}: ${refused.problems.join('; ')}`); }
  }

  #manifestState(): ManifestState {
    if (this.#manifest === undefined) { throw new Error('not started'); }
    return this.#manifest;
  }

  #stopTimeout(): number {
    return this.#limits.heartbeat * 2;
  }

  #setStatus(status: RunningStatus): void {
    if (this.#status === status || this.#status === 'stopped') { return; }
    this.#status = status;
    this.#log.info('system.status', { status });
    for (const listener of this.#statusListeners) { listener(status); }
  }
}
