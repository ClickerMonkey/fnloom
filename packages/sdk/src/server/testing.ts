/**
 * `@harness/sdk/server/testing`: a hub in memory, for testing a system end to end without a network. `FakeHub` serves
 * the real `hubLinkSpec` with ayepi (peers included), so the system under test runs its real link, handshake, runtime
 * and wire checks; only the hub's own behaviour (child calls, handlers, LLM answers, settings) is scripted.
 *
 * ```ts
 * const hub = new FakeHub({ config: { roots: [] } });
 * const running = await serve(fs, impl, { hub: 'ws://hub/link', state: '' }, hub.host());
 * await running.ready();
 * const outcome = await hub.run('fs/read', { path: 'a.txt' });
 * ```
 */
import { randomUUID } from 'node:crypto';
import { implement, peers, reject, server, type Peer, type Peers, type Server, type WsConn, type WsState } from '@ayepi/core';
import {
  ContentRef, Json, MAIN_INSTANCE, hubLinkSpec, linkSession, linkTel, mintId, qualify, systemLinkSpec,
  type ConnectResult, type InstanceName, type ModelForward, type ModelForwardResult, type PairingInfo,
  type AutoPairGrant, type AutoPairProof, type ConfigValue, type HandlerAnswer, type HubLinkSpec, type ImportReport, type JsonObject, type LinkSession, type LlmForward,
  type LlmForwardChunk, type LogLine, type Manifest, type ManifestPatch, type OutcomeWire, type PairingId, type QualifiedName,
  type ResourceRead, type RunControl, type RunInfo, type RunRequest, type RunSettled, type StateOwner, type SystemLinkSpec, type TypeDefinitions, type UserInfo, ActorId, SystemName,
} from '@harness/core';
import type { z } from 'zod';
import type { SystemPlace } from '../ctx.ts';
import { contentHash } from './content.ts';
import { LinkHost, type LinkHostDeps } from './host.ts';
import { MemoryJournal } from './journal.ts';
import { MemoryKeyStore, verifyNonce } from './keys.ts';
import { systemLogger } from './log.ts';
import type { LinkSocket, LinkTransport } from './link.ts';
import type { ProcessControl } from './process.ts';

/** What a system sent to a hub endpoint, as the hub parsed it. Derived from `hubLinkSpec`, so it can't drift. */
export type HubBody<K extends keyof HubLinkSpec['endpoints']> = z.output<NonNullable<HubLinkSpec['endpoints'][K]['cfg']['body']>>;
/** What the hub sends to a system endpoint. Derived from `systemLinkSpec`. */
export type SystemBody<K extends keyof SystemLinkSpec['endpoints']> = SystemLinkSpec['endpoints'][K]['cfg'] extends { body: infer B extends z.ZodType } ? z.input<B> : never;

/**
 * Where a fake context says its system keeps things: the `main` instance and folders nothing creates. A test that
 * writes data makes its own temporary folder and spreads it over this.
 */
export const TEST_PLACE: SystemPlace = { instance: MAIN_INSTANCE, dataDir: '.harness-test/data', cacheDir: '.harness-test/cache' };

/** The person fake runs are for. */
export const TEST_USER: UserInfo = {
  id: ActorId.parse('act_tester'),
  name: 'Tess Tester',
  email: 'tess@example.com',
  role: 'admin',
  groups: [],
  timeZone: 'UTC',
  locale: 'en',
};

/** A frame's call id and whether it ends that call, for the drop bookkeeping a real ws transport does. */
function frameOf(raw: string): { id?: string; call: boolean; terminal: boolean } {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) { return { call: false, terminal: false }; }
  const id = 'id' in parsed && typeof parsed.id === 'string' ? parsed.id : undefined;
  return { ...(id === undefined ? {} : { id }), call: 'type' in parsed, terminal: '$status' in parsed || ('end' in parsed && parsed.end === true) };
}

/**
 * A socket in memory between a system and the fake hub's ayepi server. Frames are delivered asynchronously. Like
 * ayepi's `wsTransport`, a drop settles every call still waiting with a `DISCONNECTED` reply.
 */
class MemorySocket implements LinkSocket {
  readonly #open = new Set<string>();
  #state: WsState = 'closed';
  readonly #app: Server<HubLinkSpec>;
  readonly #listeners = new Set<(state: WsState) => void>();
  readonly #onConnect: (conn: WsConn) => void;
  #deliver: (frame: string) => void = () => undefined;
  #conn: WsConn | undefined;
  #closed = false;

  constructor(app: Server<HubLinkSpec>, onConnect: (conn: WsConn) => void) {
    this.#app = app;
    this.#onConnect = onConnect;
  }

  get state(): WsState { return this.#state; }

  connect(): void {
    if (this.#closed || this.#state !== 'closed') { return; }
    this.#set('connecting');
    queueMicrotask(() => {
      const conn = this.#app.ws.open((frame) => {
        queueMicrotask(() => {
          if (this.#conn !== conn) { return; }
          const { id, terminal } = frameOf(frame);
          if (id !== undefined && terminal) { this.#open.delete(id); }
          this.#deliver(frame);
        });
      }, new Request('http://hub.test/link'));
      this.#conn = conn;
      this.#onConnect(conn);
      this.#set('open');
    });
  }

  send(frame: string): void {
    const conn = this.#conn;
    if (conn === undefined || this.#state !== 'open') { return; }
    const { id, call } = frameOf(frame);
    if (id !== undefined && call) { this.#open.add(id); }
    queueMicrotask(() => { void this.#app.ws.message(conn, frame); });
  }

  onMessage(cb: (frame: string) => void): void {
    this.#deliver = cb;
  }

  onState(listener: (state: WsState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  close(): void {
    this.#closed = true;
    this.drop();
  }

  /** The link drops: both sides see it close. Reconnects after `after` ms unless closed for good. */
  drop(after?: number): void {
    const conn = this.#conn;
    this.#conn = undefined;
    if (conn !== undefined) { this.#app.ws.close(conn); }
    this.#set('closed');
    const open = [...this.#open];
    this.#open.clear();
    for (const id of open) { this.#deliver(JSON.stringify({ id, $status: 0, $code: 'DISCONNECTED', $error: 'The link dropped.' })); }
    if (after !== undefined && !this.#closed) { setTimeout(() => { this.connect(); }, after); }
  }

  #set(state: WsState): void {
    if (this.#state === state) { return; }
    this.#state = state;
    for (const listener of [...this.#listeners]) { listener(state); }
  }
}

/** What the fake hub remembers about a connected system. */
interface Connected {
  readonly session: LinkSession;
  readonly peer: Peer<SystemLinkSpec>;
}

/** A process that records restarts and exits instead of doing them. */
export class FakeProcess implements ProcessControl {
  readonly restarts: number[] = [];
  readonly exits: number[] = [];

  restart(): Promise<never> {
    this.restarts.push(Date.now());
    return new Promise<never>(() => undefined);
  }

  exit(code: number): Promise<never> {
    this.exits.push(code);
    return new Promise<never>(() => undefined);
  }
}

/** How the fake hub behaves. */
export interface FakeHubOptions {
  /**
   * The config it holds for the system, as a plain value (absent fields are dropped, as JSON would). Absent: none yet
   * (the system waits as `needs-config`, unless it needs none).
   */
  config?: unknown;
  /** Ask for pairing the first time a name says hello (default false: every key is accepted). */
  pairing?: boolean;
  /** How long a pairing request lasts, in ms (default ten minutes). */
  pairingTtl?: number;
  /** The welcome's start info. */
  start?: { first: boolean; upgradedFrom?: string };
  maxChunk?: number;
  /** The instance name the welcome gives (an admin renamed it at approval); default: the one the system asked for. */
  instance?: InstanceName;
  /** An auto-pair grant every welcome carries. */
  autoPair?: AutoPairGrant;
  /** Refuse every hello that brings an auto-pair secret, as the hub does for an expired or revoked one. */
  refuseAutoPair?: boolean;
}

/** A hub in memory for testing systems. */
export class FakeHub {
  readonly systems: Peers<SystemLinkSpec> = peers(systemLinkSpec);
  readonly app: Server<HubLinkSpec>;
  readonly process = new FakeProcess();

  // ─── What systems sent ──────────────────────────────────────────────────────
  readonly hellos: Array<{ name: string; instance: InstanceName; boot: string; manifestHash: string; pairingToken?: string | undefined; autoPair?: AutoPairProof | undefined }> = [];
  readonly manifests: Manifest[] = [];
  readonly patches: ManifestPatch[] = [];
  readonly calls: Array<HubBody<'call'>> = [];
  readonly handled: Array<HubBody<'handle'>> = [];
  /** The names each `types` request asked for. */
  readonly typeRequests: Array<HubBody<'types'>['names']> = [];
  readonly controls: RunControl[] = [];
  readonly progress: Array<HubBody<'progress'>> = [];
  readonly allowed: Array<HubBody<'allow'>> = [];
  readonly undos: Array<HubBody<'undoWith'>> = [];
  readonly attachments: Array<HubBody<'attach'>> = [];
  readonly logs: LogLine[] = [];
  /** Refreshed (or expired) credentials systems handed back (`connectionUpdate`). */
  readonly connectionUpdates: Array<HubBody<'connectionUpdate'>> = [];
  /** Fns a run handed to its person (`shareFn`). */
  readonly shares: Array<HubBody<'shareFn'>> = [];
  readonly changes: Array<HubBody<'resourcesChanged'>['changes'][number]> = [];
  readonly forwards: LlmForward[] = [];
  readonly embeds: string[][] = [];
  /** Every non-chat model call forwarded (`model`). */
  readonly models: ModelForward[] = [];
  /** What waiting systems said for the pairing page (`pairingInfo`). */
  readonly pairingInfos: PairingInfo[] = [];

  // ─── What the hub holds ─────────────────────────────────────────────────────
  /** Paired keys by system name. */
  readonly keys = new Map<string, string>();
  /** Session state by owner (`run:<id>` / `delivery:<id>`). */
  readonly state = new Map<string, { values: JsonObject; version: number }>();
  /** Effective setting values by qualified name. */
  readonly settings = new Map<string, Json>();
  /** Content by hash. */
  readonly content = new Map<string, Uint8Array>();

  // ─── Scripted behaviour ─────────────────────────────────────────────────────
  /** Settles a child call. Default: done with `null`. */
  onCall: (call: FakeHub['calls'][number]) => Promise<RunSettled> = () => Promise.resolve({ status: 'done', result: null });
  /** Answers a run's handler. Default: refused. */
  onHandle: (call: FakeHub['handled'][number]) => Promise<HandlerAnswer> = () => Promise.resolve({ ok: false, error: { class: 'caller', message: 'no one answers handlers here' } });
  /** Answers `ctx.types.definitions` (the real hub sends the closure, dependencies first). Default: every name missing. */
  onTypes: (names: HubBody<'types'>['names']) => Promise<TypeDefinitions> = (names) => Promise.resolve({ types: [], missing: names });
  /** Streams an LLM answer. Default: the text `ok`. */
  onLlm: (forward: LlmForward) => AsyncIterable<LlmForwardChunk> = () => streamOf<LlmForwardChunk>([
    { type: 'chunk', chunk: { content: 'ok' } },
    { type: 'chunk', chunk: { finishReason: 'stop' } },
    { type: 'done', usage: { input: 1, output: 1 }, cost: 0, interaction: mintId('llmInteraction'), model: 'test/model' },
  ]);
  /** Reads a resource for `ctx.resources` (the real hub routes to the system that serves it). Default: not found. */
  onResource: (read: HubBody<'resource'>) => Promise<ResourceRead> = () => Promise.reject(reject(404, 'NOT_FOUND', 'The fake hub serves no resources.'));
  /**
   * Answers a non-chat model call: embeddings by text length, images and speech as stored content, a fixed
   * transcript. Each answer has a fresh `ModelCall` id and a small cost.
   */
  onModel: (forward: ModelForward) => Promise<ModelForwardResult> = (forward) => Promise.resolve(this.#modelAnswer(forward));
  /** Controls a child run. Default: accepted. */
  onControl: (control: RunControl) => Promise<{ accepted: boolean; reason?: string }> = () => Promise.resolve({ accepted: true });

  readonly #options: FakeHubOptions;
  readonly #sessions = new WeakMap<WsConn, LinkSession>();
  readonly #nonces = new WeakMap<WsConn, { name: string; nonce: string; publicKey: string; instance: InstanceName; boot: string }>();
  readonly #pending = new Map<string, { pairing: PairingId; conn: WsConn; publicKey: string }>();
  readonly #uploads = new Map<string, Uint8Array[]>();
  readonly #sockets: MemorySocket[] = [];
  #connected: Connected | undefined;
  #config: ConfigValue | undefined;

  constructor(options: FakeHubOptions = {}) {
    this.#options = options;
    this.#config = options.config === undefined ? undefined : { value: jsonOf(options.config), version: 1 };
    this.app = server(hubLinkSpec, [this.#implementation()], { peers: this.systems });
    this.systems.onClose((peer) => { if (this.#connected?.peer === peer) { this.#connected = undefined; } });
  }

  /** The transport a system under test connects with. */
  transport(): LinkTransport {
    return {
      open: () => {
        const socket = new MemorySocket(this.app, () => undefined);
        this.#sockets.push(socket);
        return socket;
      },
    };
  }

  /** A `LinkHost` wired to this hub, with in-memory keys and journal, no signals and a fake process. */
  host(deps: Partial<LinkHostDeps> = {}): LinkHost {
    const keys = new MemoryKeyStore();
    const journal = new MemoryJournal(100);
    return new LinkHost({
      transport: this.transport(),
      keys: () => keys,
      journal: () => journal,
      process: this.process,
      signals: false,
      logger: (sink) => systemLogger({ level: 'debug', json: false, sink, console: 'none' }),
      // the place's folders are named but never made: a test that writes data makes its own
      folders: () => Promise.resolve(),
      ...deps,
    });
  }

  /** The connected system's peer (its `systemLinkSpec`, to call directly). */
  peer(): Peer<SystemLinkSpec> {
    const connected = this.#connected;
    if (connected === undefined) { throw new Error('No system is connected to the fake hub.'); }
    return connected.peer;
  }

  /** Whether a system is connected and welcomed. */
  get connected(): boolean { return this.#connected !== undefined; }

  /** Wait until a system is connected and welcomed. */
  async whenConnected(timeout = 2_000): Promise<Peer<SystemLinkSpec>> {
    const until = Date.now() + timeout;
    while (this.#connected === undefined) {
      if (Date.now() > until) { throw new Error('No system connected to the fake hub in time.'); }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.#connected.peer;
  }

  /** Drop the link (both sides see it close); it reconnects after `after` ms. */
  drop(after = 10): void {
    this.#connected = undefined;
    for (const socket of this.#sockets) { socket.drop(after); }
  }

  /** Approve the pending pairing of a system: its key is remembered and it is told to say hello again. */
  async approve(name: string): Promise<void> {
    const pending = this.#pending.get(name);
    if (pending === undefined) { throw new Error(`${name} is not waiting for pairing.`); }
    this.#pending.delete(name);
    this.keys.set(name, pending.publicKey);
    await this.systems.of(pending.conn).call('paired', { pairing: pending.pairing });
  }

  /** Set (or change) the system's config and tell it. Absent fields are dropped, as JSON would. */
  async configure(value: unknown): Promise<void> {
    const previous = this.#config?.value;
    this.#config = { value: jsonOf(value), version: (this.#config?.version ?? 0) + 1 };
    if (this.#connected !== undefined) {
      await this.peer().call('configure', { ...this.#config, ...(previous === undefined ? {} : { previous }) });
    }
  }

  /** The current config version (0 when none is set). */
  get configVersion(): number { return this.#config?.version ?? 0; }

  /** A `RunInfo` for a run of `fn`. */
  runInfo(fn: QualifiedName, overrides: Partial<RunInfo> = {}): RunInfo {
    const now = Date.now();
    return {
      id: mintId('run'),
      fn,
      turn: mintId('turn'),
      session: mintId('session'),
      user: TEST_USER,
      time: { now, timeZone: 'UTC', local: new Date(now).toISOString() },
      system: { name: fn.slice(0, fn.indexOf('/')), instance: MAIN_INSTANCE, boot: 'test' },
      caller: TEST_USER.id,
      attempt: 1,
      priority: 'interactive',
      ...overrides,
    };
  }

  /** Build a run request for `fn` (`system/local`). */
  request(fn: QualifiedName, args: Json, extra: Partial<Omit<RunRequest, 'fn' | 'args'>> = {}): RunRequest {
    const local = fn.slice(fn.indexOf('/') + 1);
    return {
      run: extra.run ?? this.runInfo(fn),
      fn: local,
      kind: extra.kind ?? 'native',
      args,
      budget: { cost: 1, time: 60_000, limitedBy: 'turn' },
      handlers: [],
      deadline: Date.now() + 60_000,
      configVersion: this.configVersion,
      ...extra,
    };
  }

  /** Ask the connected system to get ready for a data export; resolves with where its data folder is. */
  exportData(timeout = 1_000): Promise<{ data: string }> {
    return this.peer().call('export', { timeout });
  }

  /** Begin connecting a person on a per-person system (`connectStart`): where to send them. */
  connectStart(body: SystemBody<'connectStart'>): Promise<{ url: string }> {
    return this.peer().call('connectStart', body);
  }

  /** Finish connecting a person (`connectFinish`) with what the redirect or form brought. */
  connectFinish(body: SystemBody<'connectFinish'>): Promise<ConnectResult> {
    return this.peer().call('connectFinish', body);
  }

  /** A person disconnected (`disconnect`). */
  disconnect(body: SystemBody<'disconnect'>): Promise<void> {
    return this.peer().call('disconnect', body);
  }

  /** Run a fn on the connected system and wait for its outcome. */
  run(fn: QualifiedName, args: Json, extra: Partial<Omit<RunRequest, 'fn' | 'args'>> = {}): Promise<OutcomeWire> {
    return this.peer().call('run', this.request(fn, args, extra));
  }

  /** Store content (as an upload would) and return its ref. */
  put(bytes: Uint8Array, mime: string): ContentRef {
    const hash = contentHash(bytes);
    this.content.set(hash, bytes);
    return ContentRef.parse({ hash, size: bytes.length, mime });
  }

  // ─── The hub's side of the link ─────────────────────────────────────────────

  #modelAnswer(forward: ModelForward): ModelForwardResult {
    const record = { call: mintId('modelCall'), cost: 0.001, model: `test/${forward.modality}` };
    switch (forward.modality) {
      case 'embed': return { modality: 'embed', vectors: forward.texts.map((t) => [t.length, 1]), ...record };
      case 'image': return { modality: 'image', images: Array.from({ length: forward.count ?? 1 }, () => this.put(new Uint8Array([137, 80, 78, 71]), 'image/png')), ...record };
      case 'transcribe': return { modality: 'transcribe', text: `heard ${forward.audio.size} bytes`, ...record };
      case 'speech': return { modality: 'speech', audio: this.put(new TextEncoder().encode(forward.text), `audio/${forward.format ?? 'mp3'}`), ...record };
    }
  }

  #session(conn: WsConn | undefined): LinkSession {
    const session = conn === undefined ? undefined : this.#sessions.get(conn);
    if (session === undefined) { throw reject(401, 'NOT_PAIRED', 'Finish the handshake first.'); }
    return session;
  }

  #owner(owner: StateOwner): string {
    return 'run' in owner ? `run:${owner.run}` : `delivery:${owner.delivery}`;
  }

  #implementation() {
    return implement(hubLinkSpec)
      // the real hub records request telemetry here; the fake passes every call through
      .middleware(linkTel, (io) => io.next({}))
      .middleware(linkSession, async (io) => io.next({ link: this.#session(io.ws?.conn) }))
      .handlers({
        hello: ({ data, conn }) => {
          if (conn === undefined) { throw reject(400, 'WS_ONLY', 'The link is WebSocket only.'); }
          this.hellos.push({ name: data.name, instance: data.instance, boot: data.boot, manifestHash: data.manifestHash, pairingToken: data.pairingToken, autoPair: data.autoPair });
          if (data.autoPair !== undefined && this.#options.refuseAutoPair === true) {
            throw reject(401, 'AUTO_PAIR_REFUSED', 'the auto-pair secret is unknown, expired or revoked');
          }
          const known = this.keys.get(data.name);
          if (known === undefined && this.#options.pairing === true && data.pairingToken === undefined) {
            const pairing = mintId('pairing');
            this.#pending.set(data.name, { pairing, conn, publicKey: data.publicKey });
            return { kind: 'pairing', pairing, code: 'ABCD-1234', url: 'http://hub.test/pair', expiresAt: Date.now() + (this.#options.pairingTtl ?? 600_000) };
          }
          if (known !== undefined && known !== data.publicKey) { throw reject(403, 'KEY_MISMATCH', 'A different key is paired with this name.'); }
          const nonce = randomUUID();
          this.#nonces.set(conn, { name: data.name, nonce, publicKey: data.publicKey, instance: data.instance, boot: data.boot });
          return { kind: 'challenge', nonce };
        },
        prove: ({ data, conn }) => {
          const asked = conn === undefined ? undefined : this.#nonces.get(conn);
          if (conn === undefined || asked === undefined || !verifyNonce(asked.publicKey, asked.nonce, data.signature)) {
            throw reject(401, 'BAD_SIGNATURE', 'The signature does not match.');
          }
          this.keys.set(asked.name, asked.publicKey);
          const session: LinkSession = { system: SystemName.parse(asked.name), instance: asked.instance, boot: asked.boot };
          this.#sessions.set(conn, session);
          const manifest = this.manifests.at(-1);
          const sendManifest = manifest === undefined || manifest.hash !== this.hellos.at(-1)?.manifestHash;
          queueMicrotask(() => { this.#connected = { session, peer: this.systems.of(conn) }; });
          return {
            instance: this.#options.instance ?? asked.instance,
            ...(this.#config === undefined ? {} : { config: this.#config }),
            start: this.#options.start ?? { first: this.manifests.length === 0 },
            token: 'test-token',
            sendManifest,
            limits: { maxFrame: 1_000_000, maxChunk: this.#options.maxChunk ?? 64_000, heartbeat: 1_000 },
            ...(this.#options.autoPair === undefined ? {} : { autoPair: this.#options.autoPair }),
          };
        },
        manifest: ({ data }) => {
          this.manifests.push(data);
          return emptyReport();
        },
        patch: ({ data, link }) => {
          this.patches.push(data);
          const manifest = this.manifests.at(-1);
          if (manifest !== undefined) {
            const removed = new Set(data.remove.fns ?? []);
            const upserted = data.upsert.fns ?? [];
            this.manifests.push({ ...manifest, hash: data.hash, fns: [...manifest.fns.filter((f) => !removed.has(f.name) && !upserted.some((u) => u.name === f.name)), ...upserted] });
          }
          return { ...emptyReport(), added: (data.upsert.fns ?? []).map((f) => qualify(link.system, f.name)) };
        },
        call: async ({ data }) => {
          this.calls.push(data);
          return this.onCall(data);
        },
        handle: async ({ data }) => {
          this.handled.push(data);
          return this.onHandle(data);
        },
        control: async ({ data }) => {
          this.controls.push(data);
          return this.onControl(data);
        },
        progress: ({ data }) => { this.progress.push(data); },
        allow: ({ data }) => { this.allowed.push(data); },
        undoWith: ({ data }) => { this.undos.push(data); },
        attach: ({ data }) => { this.attachments.push(data); },
        types: async ({ data }) => {
          this.typeRequests.push(data.names);
          return this.onTypes(data.names);
        },
        resourcesChanged: ({ data }) => { this.changes.push(...data.changes); },
        llm: ({ data }) => {
          this.forwards.push(data);
          return this.onLlm(data);
        },
        embed: ({ data }) => {
          this.embeds.push(data.texts);
          return { vectors: data.texts.map((t) => [t.length, 1]), cost: 0 };
        },
        resource: ({ data }) => this.onResource(data),
        content: ({ data }) => {
          const bytes = this.content.get(data.ref.hash);
          if (bytes === undefined) { throw reject(404, 'NOT_FOUND', 'No such content.'); }
          return { chunk: Buffer.from(bytes.subarray(data.offset, data.offset + data.length)).toString('base64') };
        },
        upload: ({ data }) => {
          const parts = this.#uploads.get(data.upload) ?? [];
          parts.push(new Uint8Array(Buffer.from(data.chunk, 'base64')));
          this.#uploads.set(data.upload, parts);
          if (!data.last) { return {}; }
          this.#uploads.delete(data.upload);
          const bytes = new Uint8Array(Buffer.concat(parts));
          return { ref: this.put(bytes, data.mime) };
        },
        setting: ({ data }) => {
          const value = this.settings.get(data.setting);
          return value === undefined ? {} : { value };
        },
        stateGet: ({ data }) => this.state.get(this.#owner(data.owner)) ?? { values: {}, version: 0 },
        stateSet: ({ data }) => {
          const key = this.#owner(data.owner);
          const current = this.state.get(key) ?? { values: {}, version: 0 };
          if (data.version !== undefined && data.version !== current.version) { return { conflict: true }; }
          const cleared = new Set(data.clear);
          const values: JsonObject = Object.fromEntries(Object.entries({ ...current.values, ...data.patch }).filter(([field]) => !cleared.has(field)));
          const next = { values, version: current.version + 1 };
          this.state.set(key, next);
          return { version: next.version };
        },
        log: ({ data }) => { this.logs.push(data); },
        connectionUpdate: ({ data }) => { this.connectionUpdates.push(data); },
        shareFn: ({ data }) => { this.shares.push(data); },
        model: async ({ data }) => {
          this.models.push(data);
          return this.onModel(data);
        },
        pairingInfo: ({ data }) => { this.pairingInfos.push(data); },
      });
  }
}

/** A plain value as JSON, the way it would cross the wire. */
function jsonOf(value: unknown): Json {
  return Json.parse(JSON.parse(JSON.stringify(value)));
}

/** Items as an async stream, one per tick (what a scripted `onLlm` returns). */
export async function* streamOf<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) { yield await Promise.resolve(item); }
}

function emptyReport(): ImportReport {
  return { added: [], updated: [], removed: [], refused: [] };
}
export { liveEnv, liveModels } from './live.ts';
