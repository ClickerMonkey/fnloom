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
  ContentRef, Json, MAIN_INSTANCE, hubLinkSpec, proposalSubjectOf, splitName, linkSession, linkTel, mintId, qualify, systemLinkSpec,
  type ConnectResult, type DecideAnswer, type KindEstimateAnswer, type FleetInstance, type HubModelInfo, type PreviewAnswer, type ProposedRun, type InstanceName, type ModelForward, type ModelForwardResult, type PairingInfo, type AdminNotice,
  type AutoPairGrant, type ConfigValue, type Hello, type HandlerAnswer, type HubLinkSpec, type ImportReport, type JsonObject, type KindFnShape, type LinkSession, type LlmForward,
  type LlmForwardChunk, type LogLine, type Manifest, type ManifestPatch, type OutcomeWire, type PairingId, type QualifiedName,
  type PairingGrant, type PairingGrantRequest, type ResourceRead, type ResourceHit, type MentionResourceSearch, type FlagsAnswer, type ClaimsAnswer, type MentionOption as WireMentionOption, type RunControl, type Section, type RunInfo, type RunRequest, type RunSettled, type StateOwner, type SystemLinkSpec, type TypeDefinitions, type UserInfo, ActorId, SystemName,
} from '@harness/core';
import type { z } from 'zod';
import { g, parseValue } from '../gin.ts';
import type { AdminNotices, AiSource, Decisions, Fleets, FnSearch, InstanceConnects, Proposals, SystemPlace } from '../ctx.ts';
import { fakeHubAi, streamOf } from './fake-models.ts';
import { FakeHubFns } from './fake-hub-fns.ts';
import { FakeHubWidgets } from './fake-hub-widgets.ts';
import { FakeRecords, type StoredTypeDecl } from './fake-records.ts';
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

/**
 * `ctx.propose`, `ctx.decide` and `ctx.ai` for a hand-made test context that has no hub: proposing fails (the test
 * didn't expect it), the decision model is off, and `ctx.ai()` is an aeye `AI` over `FakeModelLink` answering `ok`.
 * Spread it in beside `TEST_PLACE`; `FakeHub` serves the real ones.
 */
export const NO_ASKS: Proposals & Decisions & Fleets & FnSearch & AiSource & AdminNotices & InstanceConnects = {
  ai: () => fakeHubAi(),
  propose: () => Promise.reject(new Error('This test context proposes no runs; serve against FakeHub to record them.')),
  decide: () => Promise.resolve({ by: 'off' }),
  fleet: () => Promise.resolve([]),
  searchFns: () => Promise.resolve({ items: [] }),
  fnExamples: (query) => Promise.resolve({ fn: query.fn, items: [], total: 0 }),
  notifyAdmins: () => Promise.resolve(),
  instanceConnect: () => Promise.resolve(),
};

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
  /** Every hello it was sent, as sent. */
  readonly hellos: Hello[] = [];
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
  /** How the instance said people connect to it (`instanceConnect`), in order; it is said again on every welcome. */
  readonly instanceConnects: Array<HubBody<'instanceConnect'>> = [];
  /** Fns a run handed to its person (`shareFn`). */
  readonly shares: Array<HubBody<'shareFn'>> = [];
  /** Whether a run's person may use a fn of its system (`usableFns`); every fn by default. */
  usable: (run: HubBody<'usableFns'>['run'], fn: string) => boolean = () => true;
  readonly changes: Array<HubBody<'resourcesChanged'>['changes'][number]> = [];
  readonly forwards: LlmForward[] = [];
  /** Every non-chat model call forwarded (`model`). */
  readonly models: ModelForward[] = [];
  /** What waiting systems said for the pairing page (`pairingInfo`). */
  readonly pairingInfos: PairingInfo[] = [];
  /** What the system told the admins (`ctx.notifyAdmins`), in order. */
  readonly notices: AdminNotice[] = [];
  /** What a host's supervisor refused for the systems it hosts (`reportRefusal`), in order. */
  readonly hostRefusals: HubBody<'reportRefusal'>[] = [];
  /**
   * Runs systems proposed (`propose`), with the run and approval the fake hub made; one per open `key` (outside a run a
   * settled key proposes afresh, as on the real hub). Settle one with `approveProposal` or `declineProposal`.
   */
  readonly proposals: Array<HubBody<'propose'> & ProposedRun> = [];
  /** The approvals settled by `approveProposal` and `declineProposal`. */
  readonly #settledProposals = new Set<string>();
  /** The person each run the fake hub started acts for, by run id (whose run a `for` proposal may name). */
  readonly #runActors = new Map<string, ActorId>();
  /** What systems asked the decision model (`decide`). */
  readonly decisions: Array<HubBody<'decide'>> = [];
  /** Example changes systems sent (`examples`). */
  readonly exampleChanges: Array<HubBody<'examples'>> = [];
  /** Pairing tokens approved install runs asked for (`grantPairing`), with the grant the fake hub made. */
  readonly pairingGrants: Array<PairingGrantRequest & PairingGrant> = [];

  // ─── What the hub holds ─────────────────────────────────────────────────────
  /** Paired keys by system name. */
  readonly keys = new Map<string, string>();
  /** Session state by owner (`run:<id>` / `delivery:<id>`). */
  readonly state = new Map<string, { values: JsonObject; version: number }>();
  /** Effective setting values by qualified name. */
  readonly settings = new Map<string, Json>();
  /** Content by hash. */
  readonly content = new Map<string, Uint8Array>();
  /** A resource's outline by URI (`resourceSections`); a URI not here has no sections. */
  readonly sections = new Map<string, Section[]>();

  // ─── Scripted behaviour ─────────────────────────────────────────────────────
  /** The hub's kept fns (`hub/fns_save`, `hub/fns_get`, `searchFns`, `fnExamples`), in memory. */
  readonly fns = new FakeHubFns();
  /**
   * The data system in memory (`ctx.data`): records of the stored types the system declared, or of another system's
   * types put in `storedTypes`, answered like the hub does, as `TEST_USER`. Read them back with `data.of(type)`.
   */
  readonly data: FakeRecords = new FakeRecords((name) => this.#storedType(name), () => TEST_USER.id);
  /** Other systems' stored types the data system knows, by qualified name. */
  readonly storedTypes = new Map<QualifiedName, StoredTypeDecl>();
  /** Resource searches a mention provider made (`ctx.resources.search` in `search`), in order. */
  readonly mentionSearches: MentionResourceSearch[] = [];
  /** Answers a mention provider's resource search (default: no hits). */
  onMentionResources: (search: MentionResourceSearch) => Promise<ResourceHit[]> = () => Promise.resolve([]);
  /** The hub's widget fns (`hub/read_table`, `hub/visuals`, `hub/row_actions`), in memory. */
  readonly widgets = new FakeHubWidgets();
  /**
   * Settles a child call. Default: `hub/fns_save` and `hub/fns_get` by `fns`, the widget fns by `widgets`, anything else
   * done with `null`.
   */
  onCall: (call: FakeHub['calls'][number]) => Promise<RunSettled> = (call) => Promise.resolve(this.fns.settle(call) ?? this.widgets.settle(call) ?? { status: 'done', result: null });
  /** Answers a run's handler. Default: refused. */
  onHandle: (call: FakeHub['handled'][number]) => Promise<HandlerAnswer> = () => Promise.resolve({ ok: false, error: { class: 'caller', message: 'no one answers handlers here' } });
  /** Answers `ctx.types.definitions` (the real hub sends the closure, dependencies first). Default: every name missing. */
  onTypes: (names: HubBody<'types'>['names']) => Promise<TypeDefinitions> = (names) => Promise.resolve({ types: [], missing: names });
  /** Answers a kind check's look-up of another system's fn (link `fnShape`). Default: not known. */
  onFnShape: (name: HubBody<'fnShape'>['name']) => Promise<{ fn?: KindFnShape }> = () => Promise.resolve({});
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
  /** Answers `ctx.decide`. Default: `off` (no decision model), so the system goes by its scores. */
  onDecide: (request: HubBody<'decide'>) => Promise<DecideAnswer> = () => Promise.resolve({ by: 'off' });
  /** Answers `models` (`ctx.ai()` lists them). Default: none, so calls go to `hub/auto`. */
  onModels: () => Promise<HubModelInfo[]> = () => Promise.resolve([]);
  /** Answers `ctx.fleet`. Default: no instances listed. */
  onFleet: () => Promise<FleetInstance[]> = () => Promise.resolve([]);
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
      // a test's contracts are fixtures: the real ones are checked for examples by their own tests
      requireExamples: false,
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

  /** Ask the connected system what a run would do (`preview`), as the hub does before an approval. */
  preview(body: SystemBody<'preview'>): Promise<PreviewAnswer> {
    return this.peer().call('preview', body);
  }

  /** The declaration of a stored type: the system's own (its latest manifest) or one put in `storedTypes`. */
  #storedType(name: QualifiedName): StoredTypeDecl | undefined {
    const other = this.storedTypes.get(name);
    if (other !== undefined) { return other; }
    for (const manifest of [...this.manifests].reverse()) {
      const decl = manifest.types.find((type) => qualify(manifest.name, type.name) === name);
      if (decl !== undefined) { return decl.records === undefined ? undefined : { ...decl, records: decl.records }; }
    }
    return undefined;
  }

  /** Ask the connected system which sensitive files a run would touch (`flags`), as the hub does before a run. */
  flags(body: SystemBody<'flags'>): Promise<FlagsAnswer> {
    return this.peer().call('flags', body);
  }

  /** Ask the connected system what an agent's call would operate on (`claims`), as the hub does before the call starts. */
  claims(body: SystemBody<'claims'>): Promise<ClaimsAnswer> {
    return this.peer().call('claims', body);
  }

  /**
   * Ask the connected system for `@` options (`mentions`) as `TEST_USER`, with a fresh mention request, so its provider
   * may search resources (`ctx.resources.search`, answered by `onMentionResources` and kept in `mentionSearches`).
   */
  mentions(provider: string, query: string): Promise<WireMentionOption[]> {
    const now = Date.now();
    return this.peer().call('mentions', {
      provider, query, user: TEST_USER, actor: TEST_USER.id, session: mintId('session'), request: mintId('mentionRequest'),
      time: { now, timeZone: 'UTC', local: new Date(now).toISOString() },
    });
  }

  /** Ask the connected system what a fn of one of its kinds costs (`estimate`), as the hub does for `FnFacts.cost`. */
  estimate(body: SystemBody<'estimate'>): Promise<KindEstimateAnswer> {
    return this.peer().call('estimate', body);
  }

  /** Run a fn on the connected system and wait for its outcome. */
  run(fn: QualifiedName, args: Json, extra: Partial<Omit<RunRequest, 'fn' | 'args'>> = {}): Promise<OutcomeWire> {
    const request = this.request(fn, args, extra);
    this.#runActors.set(request.run.id, request.run.user.id);
    return this.peer().call('run', request);
  }

  /** How the instance last said people connect to it (`instanceConnect`); `undefined` when it never said. */
  get instanceConnect(): HubBody<'instanceConnect'> | undefined {
    return this.instanceConnects.at(-1);
  }

  /** An open proposal by its key, approval id or run id. */
  openProposal(which: string): HubBody<'propose'> & ProposedRun {
    const proposal = this.proposals.findLast((p) => p.key === which || p.approval === which || p.run === which);
    if (proposal === undefined) { throw new Error(`No run was proposed as ${which}.`); }
    if (this.#settledProposals.has(proposal.approval)) { throw new Error(`The proposal ${which} is settled already.`); }
    return proposal;
  }

  /**
   * Approve a proposed run (by its key, approval id or run id) as its approver would: `answer` (required when the
   * proposal has an `ask`) is set at `args[ask.into]`, the run goes ahead on the system with `approved`, and the
   * system hears it settle through the `run` event (`done`, or how it ended). Resolves with the run's outcome.
   */
  async approveProposal(which: string, options: { readonly answer?: Json; readonly by?: ActorId } = {}): Promise<OutcomeWire> {
    const proposal = this.openProposal(which);
    const args = argsWithAnswer(proposal, options.answer);
    if (proposal.ask !== undefined) { this.#checkAnswer(proposal.ask, options.answer); }
    const by = options.by ?? proposal.for ?? TEST_USER.id;
    this.#settledProposals.add(proposal.approval);
    const fn = qualify(this.#systemName(), proposal.fn);
    const outcome = await this.run(fn, args, { run: this.runInfo(fn, { id: proposal.run, caller: by }), approved: { by, preview: proposal.preview } });
    await this.peer().call('event', { type: 'run', run: proposal.run, fn, update: { type: 'status', status: outcome.status } });
    return outcome;
  }

  /**
   * Decline a proposed run as its approver would: it settles `cancelled`, and the system hears it through the `run`
   * event, with the hub's words for it ("Declined by …: reason") as the status text.
   */
  async declineProposal(which: string, reason = ''): Promise<void> {
    const proposal = this.openProposal(which);
    this.#settledProposals.add(proposal.approval);
    const words = `Declined by ${TEST_USER.name}${reason === '' ? ' (no reason given).' : `: ${reason}`}`;
    await this.peer().call('event', {
      type: 'run', run: proposal.run, fn: qualify(this.#systemName(), proposal.fn),
      update: { type: 'status', status: 'cancelled', text: { phase: 'failed', one: words, many: words } },
    });
  }

  /**
   * Whether a person owns what a `for` proposal's key names (`proposalKeyFor`), as the hub checks it: a record of one
   * of the system's stored types they own, or a run of the system that acts for them.
   */
  #owns(person: ActorId, key: string): boolean {
    const subject = proposalSubjectOf(key);
    if (subject === undefined) { return false; }
    if ('run' in subject) { return this.#runActors.get(subject.run) === person; }
    const record = this.data.records.get(subject.record);
    return record !== undefined && record.owner === person && splitName(record.type).system === this.#systemName();
  }

  /** Check an approver's answer against the proposal's `ask.type` (which may name the system's own types), as the hub does. */
  #checkAnswer(ask: NonNullable<HubBody<'propose'>['ask']>, answer: unknown): void {
    const scope = g.scope();
    const manifest = this.manifests.at(-1);
    if (manifest !== undefined) {
      for (const decl of manifest.types) { scope.bind(qualify(manifest.name, decl.name), scope.parse(decl.def)); }
    }
    try {
      parseValue(scope.parse(ask.type), answer);
    } catch (error) {
      throw new Error(`The answer doesn't fit ${ask.into}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /** The connected system's name, from its hello. */
  #systemName(): string {
    const hello = this.hellos.at(-1);
    if (hello === undefined) { throw new Error('No system has said hello to the fake hub.'); }
    return hello.name;
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
      // every yes/no question is an even call; other questions are refused, so a test that needs them scripts its own hub
      case 'decide': return {
        modality: 'decide', ...record,
        answers: Object.fromEntries(Object.entries(forward.questions).map(([name, question]) => [name, question.type === 'predicate' ? { type: 'predicate', probability: 0.5 } : { type: 'refusal' }])),
      };
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
          this.hellos.push(data);
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
          // a patch that only says the roots changed leaves the manifest as it was
          const changes = Object.keys(data.upsert).length > 0 || Object.keys(data.remove).length > 0 || data.lists !== undefined;
          if (manifest !== undefined && changes) {
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
        fnShape: ({ data }) => this.onFnShape(data.name),
        resourcesChanged: ({ data }) => { this.changes.push(...data.changes); },
        llm: ({ data }) => {
          this.forwards.push(data);
          return this.onLlm(data);
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
        instanceConnect: ({ data }) => { this.instanceConnects.push(data); },
        shareFn: ({ data }) => { this.shares.push(data); },
        usableFns: ({ data }) => ({ fns: data.fns.filter((fn) => this.usable(data.run, fn)) }),
        propose: ({ data }) => {
          if (data.parent === undefined && data.for !== undefined && !this.#owns(data.for, data.key)) {
            throw reject(403, 'NOT_YOURS', `${this.#systemName()} can only ask ${data.for} about a session or run of theirs: the key must start with its id.`);
          }
          const known = this.proposals.find((p) => p.key === data.key && (p.parent !== undefined || !this.#settledProposals.has(p.approval)));
          if (known !== undefined) { return { run: known.run, approval: known.approval }; }
          const made = { run: mintId('run'), approval: mintId('approval') };
          this.proposals.push({ ...data, ...made });
          return made;
        },
        decide: async ({ data }) => {
          this.decisions.push(data);
          return await this.onDecide(data);
        },
        fleet: () => this.onFleet(),
        searchFns: ({ data }) => Promise.resolve(this.fns.search(data)),
        fnExamples: ({ data }) => Promise.resolve(this.fns.examples(data)),
        examples: ({ data }) => {
          this.exampleChanges.push(data);
          return { added: data.upsert.length, removed: data.remove.length };
        },
        models: () => this.onModels(),
        resourceSections: ({ data }) => this.sections.get(data.uri) ?? [],
        grantPairing: ({ data }) => {
          const grant: PairingGrant = { token: `pair-${randomUUID()}`, expiresAt: Date.now() + PAIRING_GRANT_MS };
          this.pairingGrants.push({ ...data, ...grant });
          return grant;
        },
        model: async ({ data }) => {
          this.models.push(data);
          return this.onModel(data);
        },
        pairingInfo: ({ data }) => { this.pairingInfos.push(data); },
        notifyAdmins: ({ data }) => { this.notices.push(data); },
        reportRefusal: ({ data }) => { this.hostRefusals.push(data); },
        mentionResources: async ({ data }) => {
          this.mentionSearches.push(data);
          return { hits: await this.onMentionResources(data) };
        },
        records: ({ data }) => this.data.find(data),
        record: ({ data }) => this.data.get(data),
        recordTable: ({ data }) => this.data.table(data),
        saveRecord: ({ data }) => this.data.save(data),
        removeRecord: ({ data }) => this.data.remove(data),
      });
  }
}

/** How long a fake pairing grant lasts, like the real hub's short-lived grant. */
const PAIRING_GRANT_MS = 10 * 60_000;

/** A plain value as JSON, the way it would cross the wire. */
function jsonOf(value: unknown): Json {
  return Json.parse(JSON.parse(JSON.stringify(value)));
}

/** A proposal's args with the approver's answer set at `args[ask.into]`, as the hub sets it before the run starts. */
function argsWithAnswer(proposal: HubBody<'propose'>, answer: Json | undefined): Json {
  if (proposal.ask === undefined) {
    if (answer !== undefined) { throw new Error(`The proposal ${proposal.key} asks nothing, so it takes no answer.`); }
    return proposal.args;
  }
  if (answer === undefined) { throw new Error(`The proposal ${proposal.key} asks for ${proposal.ask.into}; approve it with an answer.`); }
  const args = proposal.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) { throw new Error(`The proposal ${proposal.key} asks for an answer, but its args are not an object.`); }
  return { ...args, [proposal.ask.into]: answer };
}

function emptyReport(): ImportReport {
  return { added: [], updated: [], removed: [], refused: [] };
}
export { liveEnv, liveModels } from './live.ts';
export { FakeHubFns, type KeptFn } from './fake-hub-fns.ts';
export { FakeHubWidgets, HUB_WIDGET_FNS, type FakeTableSource } from './fake-hub-widgets.ts';
export { FakeModelLink, fakeHubAi, replyChunks, streamOf, type FakeModelOptions, type FakeReply } from './fake-models.ts';
