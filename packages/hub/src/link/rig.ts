/**
 * A test rig for the system side: everything `buildSystems` wires, over in-memory fakes, with a hub link server made
 * the way boot makes it (the link plugin installed on a server with the module's peers), and fake systems that
 * connect to it over an in-process socket and serve `systemLinkSpec`. Tests only.
 */
import { client, implement, server, spec, type ApiClient, type ClientWs, type Serves, type WsConn } from '@ayepi/core';
import { createPluginHost } from '@ayepi/plugin';
import {
  LINK_PROTOCOL, SystemName, systemLinkSpec,
  type ConfigValue, type HelloReply, type KindDescription, type Manifest, type ResourceChange, type ResourceRead, type ResourceRoot, type Section,
  type StopReason, type SystemEvent, type Welcome,
} from '@harness/core';
import { ADMIN } from '../catalog/fixtures.ts';
import { MemoryBus, MemoryStore, memoryLog, settle } from '../catalog/testing.ts';
import { buildSystems, type SystemsSettings } from './build.ts';
import { LINK_SPEC, type LinkEmbedding, type LinkSpec } from './handlers.ts';
import { makeKeyPair, signNonce, type StoredKeyPair } from './keys.ts';
import { NodeInstaller, type ProcessLauncher } from './process.ts';
import { JwtSystemTokens } from './tokens.ts';

/** The settings the rig builds with: small chunks so content is fetched in several, a minute to pair. */
export const RIG_SETTINGS: SystemsSettings = {
  hub: { HARNESS_URL: 'http://hub:4300/', HARNESS_SYSTEMS_DIR: '.harness-test/systems' },
  link: {
    HARNESS_MAX_FRAME: 262_144, HARNESS_MAX_CHUNK: 1_024, HARNESS_HEARTBEAT: 15_000, HARNESS_PAIRING_TIMEOUT: 60_000, HARNESS_STOP_TIMEOUT: 1_000,
    HARNESS_RESTART_BACKOFF: 5, HARNESS_RESTARTS_PER_HOUR: 2,
  },
  model: { HARNESS_EMBEDDER_DOCUMENT: 'vectors/document', HARNESS_EMBEDDER_QUERY: 'vectors/query', HARNESS_EMBED_BATCH: 8 },
  index: { HARNESS_EMBED_WAIT: 1, HARNESS_EMBED_POLL: 2, HARNESS_INDEX_MAX_TEXT: 500, HARNESS_SEARCH_OVERFETCH: 3 },
  search: { HARNESS_SEARCH_RRF_K: 60, HARNESS_SEARCH_DEPTH: 4 },
};

/** A launcher for rigs that never start processes. */
const noLauncher: ProcessLauncher = { launch: () => { throw new Error('the rig starts no processes'); } };

/** The system side over fakes, with a running hub link server. */
export async function linkRig(options: { embedding?: LinkEmbedding } = {}) {
  const store = new MemoryStore();
  const bus = new MemoryBus();
  const { log, records } = memoryLog();
  const time = { now: 1_000_000 };
  const clock = () => time.now;
  const embedding: LinkEmbedding = options.embedding ?? { embed: (texts) => Promise.resolve({ vectors: texts.map(() => [1, 0, 0]), cost: 0 }) };
  const systems = buildSystems({
    store, bus, log, clock, settings: RIG_SETTINGS, embedding, launcher: noLauncher, installer: new NodeInstaller(),
    tokens: new JwtSystemTokens({ secret: 's'.repeat(32), ttl: 60_000 }),
  });
  const app = server(spec({ endpoints: {} }), [], { peers: systems.connections.peers });
  await createPluginHost(app).install(systems.plugin);
  return { ...systems, links: systems.connections, store, bus, log, records, time, app };
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
}

/** A system connecting to the rig's hub over an in-process socket. */
export class FakeSystem {
  readonly keys: StoredKeyPair;
  readonly name: SystemName;
  instance = 'i-1';
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
  };
  readonly paired: string[] = [];
  readonly configured: Array<ConfigValue & { previous?: unknown }> = [];
  readonly events: SystemEvent[] = [];
  readonly stops: StopReason[] = [];
  readonly watched: string[][] = [];
  conn: WsConn | null = null;
  /** The hub's server: only its socket side is used. */
  readonly #app: Serves;
  #deliver: (frame: string) => void = () => undefined;
  readonly #states = new Set<(state: 'closed' | 'connecting' | 'open') => void>();

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
      configure: ({ data }) => { this.configured.push(data); },
      stop: ({ data }) => { this.stops.push(data.reason); },
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

  /** Open the socket. */
  open(): void {
    const opened = this.#app.ws.open((frame) => { if (this.conn === opened) { this.#deliver(frame); } }, new Request('http://hub/link', { headers: { 'x-forwarded-for': '10.0.0.7' } }));
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
      protocol: LINK_PROTOCOL, name: this.name, version: this.version, instance: this.instance, publicKey: this.keys.publicKey,
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

/** Pair a fake system directly (as an admin approving it would) so a test can start from a known name. */
export async function pairDirectly(rig: LinkRig, system: FakeSystem): Promise<void> {
  await rig.pairing.pairInstalled(system.name, system.keys.publicKey, ADMIN);
}
