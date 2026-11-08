/**
 * A test rig for the system side: everything `buildSystems` wires, over in-memory fakes, with a hub link server made
 * the way boot makes it (the link plugin installed on a server with the module's peers), and fake systems that
 * connect to it over an in-process socket and serve `systemLinkSpec`. Tests only.
 */
import { client, implement, server, spec, type ApiClient, type ClientWs, type Serves, type WsConn } from '@ayepi/core';
import { createPluginHost } from '@ayepi/plugin';
import {
  LINK_PROTOCOL, MAIN_INSTANCE, SystemName, systemLinkSpec,
  type ContentRef, type InstanceName, type SystemPackageManifest,
  type ConfigValue, type HelloReply, type KindDescription, type Manifest, type ResourceChange, type ResourceRead, type ResourceRoot, type Section,
  type StopReason, type SystemEvent, type Welcome,
} from '@harness/core';
import { ADMIN } from '../catalog/fixtures.ts';
import { RecordingBus, testStore, memoryLog, settle } from '../testing.ts';
import { buildSystems, type SystemsSettings } from './build.ts';
import { LINK_SPEC, type LinkEmbedding, type LinkSpec } from './handlers.ts';
import { makeKeyPair, signNonce, type StoredKeyPair } from './keys.ts';
import type { ProcessExit, ProcessLauncher, SystemCommand, SystemProcess } from './process.ts';
import { sha256 } from './package/index.ts';
import type { PackageContent } from './packages.ts';
import { JwtSystemTokens } from './tokens.ts';

/** The settings the rig builds with: small chunks so content is fetched in several, a minute to pair. */
export const RIG_SETTINGS: SystemsSettings = {
  hub: { HARNESS_URL: 'http://hub:4300/', HARNESS_SYSTEMS_DIR: '.harness-test/systems' },
  packaging: { HARNESS_PUBLIC_URL: undefined, HARNESS_PACKAGE_MAX: 10_000_000, HARNESS_NPM: 'npm' },
  link: {
    HARNESS_MAX_FRAME: 262_144, HARNESS_MAX_CHUNK: 1_024, HARNESS_HEARTBEAT: 15_000, HARNESS_PAIRING_TIMEOUT: 60_000, HARNESS_STOP_TIMEOUT: 1_000,
    HARNESS_RESTART_BACKOFF: 5, HARNESS_RESTARTS_PER_HOUR: 2,
  },
  model: { HARNESS_EMBEDDER_DOCUMENT: 'vectors/document', HARNESS_EMBEDDER_QUERY: 'vectors/query', HARNESS_EMBED_BATCH: 8 },
  index: { HARNESS_EMBED_WAIT: 1, HARNESS_EMBED_POLL: 2, HARNESS_EMBED_INTERACTIVE: 2, HARNESS_EMBED_BACKGROUND: 1, HARNESS_INDEX_MAX_TEXT: 500, HARNESS_SEARCH_OVERFETCH: 3, HARNESS_INDEX_CRAWL_MAX: 1_000 },
  search: { HARNESS_SEARCH_RRF_K: 60, HARNESS_SEARCH_DEPTH: 4 },
};

/** A launcher for rigs that never start processes. */
const noLauncher: ProcessLauncher = { launch: () => { throw new Error('the rig starts no processes'); } };

/** The system side over fakes, with a running hub link server. */
export async function linkRig(options: { embedding?: LinkEmbedding; publicUrl?: string } = {}) {
  const store = await testStore();
  const bus = new RecordingBus();
  const { log, records } = memoryLog();
  const time = { now: 1_000_000 };
  const clock = () => time.now;
  const embedding: LinkEmbedding = options.embedding ?? { embed: (texts) => Promise.resolve({ vectors: texts.map(() => [1, 0, 0]), cost: 0 }) };
  const content = new MemoryContent();
  const settings: SystemsSettings = options.publicUrl === undefined ? RIG_SETTINGS : { ...RIG_SETTINGS, packaging: { ...RIG_SETTINGS.packaging, HARNESS_PUBLIC_URL: options.publicUrl } };
  const systems = buildSystems({
    store, bus, log, clock, settings, embedding, launcher: noLauncher, content: () => content,
    tokens: new JwtSystemTokens({ secret: 's'.repeat(32), ttl: 60_000 }),
  });
  const app = server(spec({ endpoints: {} }), [], { peers: systems.connections.peers });
  await createPluginHost(app).install(systems.plugin);
  return { ...systems, links: systems.connections, store, bus, log, records, time, app, content };
}

export type LinkRig = Awaited<ReturnType<typeof linkRig>>;

/** What a fake system answers, set per test. */
export interface FakeBehaviour {
  describe: (kind: string, payload: unknown) => { problems: string[]; description?: KindDescription };
  roots: ResourceRoot[];
  read: (uri: string) => ResourceRead;
  content: (offset: number, length: number) => string;
  sections: Section[];
  embed: (texts: string[]) => number[][];
  /** Applying a pushed config (what a real system does in `configured`). */
  configure: (config: ConfigValue) => void;
}

/** A system connecting to the rig's hub over an in-process socket. */
export class FakeSystem {
  readonly keys: StoredKeyPair;
  readonly name: SystemName;
  /** The instance it says it is. */
  instance: InstanceName = MAIN_INSTANCE;
  /** This process start: change it to look like a restart. */
  boot = 'b-1';
  version = '1.0.0';
  manifest: Manifest;
  readonly sdk: ApiClient<LinkSpec>;
  readonly behaviour: FakeBehaviour = {
    describe: () => ({ problems: ['no kinds here'] }),
    roots: [],
    read: (uri) => ({ stat: { uri: ResourceUriOf(uri), name: uri, type: 'file', version: 'v1' }, text: { inline: '' } }),
    content: () => '',
    sections: [],
    embed: (texts) => texts.map(() => [0, 1, 0]),
    configure: () => undefined,
  };
  readonly paired: string[] = [];
  readonly configured: Array<ConfigValue & { previous?: unknown }> = [];
  readonly events: SystemEvent[] = [];
  readonly stops: StopReason[] = [];
  /** How many times the hub asked it to get ready for an export. */
  exports = 0;
  /** The data folder it says it uses when asked for an export. */
  dataDir = '';
  readonly watched: string[][] = [];
  conn: WsConn | null = null;
  /** The hub's server: only its socket side is used. */
  readonly #app: Serves;
  #deliver: (frame: string) => void = () => undefined;
  readonly #states = new Set<(state: 'closed' | 'connecting' | 'open') => void>();
  #host = 'hub';

  constructor(app: Serves, name: string, manifest: Manifest, keys: StoredKeyPair = makeKeyPair()) {
    this.#app = app;
    this.name = SystemName.parse(name);
    this.manifest = manifest;
    this.keys = keys;
    const b = this.behaviour;
    const notHere = (): never => { throw new Error('not served in this test'); };
    const local = server(systemLinkSpec, [implement(systemLinkSpec).handlers({
      paired: ({ data }) => { this.paired.push(data.pairing); },
      check: ({ data }) => b.describe(data.kind, data.payload),
      roots: () => b.roots,
      read: ({ data }) => b.read(data.uri),
      stat: ({ data }) => ({ stat: b.read(data.uri).stat }),
      list: () => ({ items: [] }),
      sections: () => b.sections,
      content: ({ data }) => ({ chunk: b.content(data.offset, data.length) }),
      watch: ({ data }) => { this.watched.push(data.uris); },
      embed: ({ data }) => ({ vectors: b.embed(data.texts) }),
      event: ({ data }) => { this.events.push(data); },
      configure: ({ data }) => { this.configured.push(data); b.configure(data); },
      stop: ({ data }) => { this.stops.push(data.reason); },
      export: () => { this.exports += 1; return { data: this.dataDir }; },
      run: notHere, control: notHere, undo: notHere, handler: notHere, child: notHere, context: notHere, hook: notHere, mentions: notHere,
      mentionHover: notHere, mentionText: notHere, action: notHere, form: notHere, restart: notHere,
    })]);
    const ws: ClientWs = {
      send: (frame) => { if (this.conn !== null) { void this.#app.ws.message(this.conn, frame); } },
      onMessage: (cb) => { this.#deliver = cb; },
      onState: (cb) => { this.#states.add(cb); return () => void this.#states.delete(cb); },
    };
    this.sdk = client<LinkSpec>({ baseUrl: 'http://hub', manifest: LINK_SPEC, ws, serve: local, prefer: 'ws' });
  }

  /** The host it dials the hub at (what a pairing link is built from). */
  dialing(host: string): this {
    this.#host = host;
    return this;
  }

  /** Open the socket. */
  open(): void {
    const opened = this.#app.ws.open((frame) => { if (this.conn === opened) { this.#deliver(frame); } }, new Request(`http://${this.#host}/link`, { headers: { 'x-forwarded-for': '10.0.0.7' } }));
    this.conn = opened;
    for (const cb of this.#states) { cb('open'); }
  }

  /** Drop the socket; both sides see it close. */
  drop(): void {
    const conn = this.conn;
    this.conn = null;
    for (const cb of this.#states) { cb('connecting'); }
    if (conn !== null) { this.#app.ws.close(conn); }
  }

  hello(pairingToken?: string): Promise<HelloReply> {
    return this.sdk.call('hello', {
      protocol: LINK_PROTOCOL, name: this.name, version: this.version, instance: this.instance, boot: this.boot, publicKey: this.keys.publicKey,
      manifestHash: this.manifest.hash, ...(pairingToken === undefined ? {} : { pairingToken }),
    });
  }

  /** Say hello and, given a challenge, prove the key. Returns the welcome, or the pairing reply. */
  async connect(pairingToken?: string): Promise<Welcome | Extract<HelloReply, { kind: 'pairing' }>> {
    if (this.conn === null) { this.open(); }
    const reply = await this.hello(pairingToken);
    if (reply.kind === 'pairing') { return reply; }
    return this.sdk.call('prove', { signature: signNonce(this.keys.privateKey, reply.nonce) });
  }

  /** Connect and, when the welcome asks for it, send the manifest. */
  async start(): Promise<Welcome> {
    const welcome = await this.connect();
    if (!('limits' in welcome)) { throw new Error(`${this.name} is not paired`); }
    if (welcome.sendManifest) { await this.sdk.call('manifest', this.manifest); }
    await settle();
    return welcome;
  }

  resourcesChanged(changes: ResourceChange[]): Promise<void> {
    return this.sdk.call('resourcesChanged', { changes });
  }
}

/** A resource URI from a test string. */
function ResourceUriOf(uri: string): `${string}://${string}` {
  const at = uri.indexOf('://');
  if (at < 0) { throw new Error(`not a uri: ${uri}`); }
  return `${uri.slice(0, at)}://${uri.slice(at + 3)}`;
}

/** Pair a fake system directly (as an admin approving it would) so a test can start from a known instance. */
export async function pairDirectly(rig: LinkRig, system: FakeSystem): Promise<void> {
  await rig.pairing.pairInstalled({ system: system.name, instance: system.instance }, system.keys.publicKey, system.version, ADMIN);
}

/** Content kept in memory, by hash (the content store the rig's packages read zips from and write exports to). */
export class MemoryContent implements PackageContent {
  readonly #bytes = new Map<string, { bytes: Uint8Array; mime: string }>();

  put(bytes: Uint8Array, mime: string): Promise<ContentRef> {
    const hash = sha256(bytes);
    this.#bytes.set(hash, { bytes, mime });
    return Promise.resolve({ hash, size: bytes.length, mime });
  }

  open(hash: string): ReturnType<PackageContent['open']> {
    const found = this.#bytes.get(hash);
    if (found === undefined) { return Promise.resolve(undefined); }
    const stream = new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(found.bytes); controller.close(); } });
    return Promise.resolve({ stream, size: found.bytes.length, mime: found.mime });
  }

  /** The bytes under a ref. */
  bytes(ref: ContentRef): Uint8Array {
    const found = this.#bytes.get(ref.hash);
    if (found === undefined) { throw new Error(`no content ${ref.hash}`); }
    return found.bytes;
  }
}

/** A system.json for a test package. */
export function systemJson(name: string, version: string, extra: Partial<SystemPackageManifest> = {}): SystemPackageManifest {
  return {
    format: 1, name: SystemName.parse(name), version, description: `The ${name} system.`, protocol: LINK_PROTOCOL,
    server: { entry: 'server/main.ts', external: {} }, instances: 'one', ...extra,
  };
}

/** A process the test ends by hand. */
export class FakeProcess implements SystemProcess {
  readonly pid: number;
  readonly exited: Promise<ProcessExit>;
  killed = false;
  #end: (exit: ProcessExit) => void = () => undefined;

  readonly command: SystemCommand;

  constructor(command: SystemCommand, pid: number) {
    this.command = command;
    this.pid = pid;
    this.exited = new Promise((resolve) => { this.#end = resolve; });
  }

  exit(code: number, output = ''): void { this.#end({ code, output }); }
  kill(): void { this.killed = true; this.exit(143, 'killed'); }
}

/** Records what it launches; tests end the processes. */
export class FakeLauncher implements ProcessLauncher {
  readonly launched: FakeProcess[] = [];
  launch(command: SystemCommand): FakeProcess {
    const process = new FakeProcess(command, 100 + this.launched.length);
    this.launched.push(process);
    return process;
  }
  get last(): FakeProcess {
    const last = this.launched.at(-1);
    if (last === undefined) { throw new Error('nothing launched'); }
    return last;
  }
}
