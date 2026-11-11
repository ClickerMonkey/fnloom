/**
 * Test rig for the api and boot modules: a quiet logger that keeps its records, a real in-memory SQLite store (the
 * data lane's `openSqliteStore`), fakes of the other modules' interfaces (each method answers only if the test gave
 * it, and says which one is missing otherwise), the real api services, and the web API plugins installed in an ayepi
 * server with a typed in-process caller. Tests only.
 */
import { openScope } from '../../access/index.ts';
import { client as apiClient, server, spec, type AnySpec, type ApiClient, type Server } from '@ayepi/core';
import type { LogRecord } from '@ayepi/log';
import { createPluginHost, type PluginHost } from '@ayepi/plugin';
import { hubWebSpec, type HubWebSpec, type Manifest, type ManifestSection, type SystemName, type Tokens } from '@harness/core';
import type { Catalog, CatalogEntry } from '../../catalog/index.ts';
import { MemoryEventBus } from '../../bus/memory.ts';
import { parseHubSettings, type HubSettings } from '../../boot/env.ts';
import type { HubKeys } from '../../boot/keys.ts';
import type { HubModules, HubServices, ModuleKey } from '../../boot/index.ts';
import { apiServices, type ApiServices } from '../../boot/services.ts';
import { openSqliteStore } from '../../store/sqlite.ts';
import { memoryLog, testStore } from '../../testing.ts';
import type { HubStore } from '../../store/index.ts';
import type { FileStore, FileInfo, FileObject, FileBody } from '@ayepi/files';
import { collect as collectBytes, toStream } from '@ayepi/files';
import type { PushSender } from '../push.ts';
import { webPlugins } from '../web/index.ts';


/**
 * A fake of an interface: the methods given, and for any other a method that throws naming itself. The one unchecked
 * step of the rig: a Proxy can't be typed as `T`, but every property it answers is either from `given` (a `Partial<T>`)
 * or a function that throws, which a test only reaches by calling a method it didn't fake.
 */
export function fake<T extends object>(name: string, given: Partial<T> = {}): T {
  const target: object = given;
  const proxy = new Proxy(target, {
    get(object, key) {
      if (typeof key === 'symbol' || key === 'then') { return undefined; }
      if (key in object) {
        const value: unknown = Reflect.get(object, key);
        return value;
      }
      return () => { throw new Error(`${name}.${key} is not faked in this test`); };
    },
  });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- see the doc comment
  return proxy as T;
}

/** What a test fakes, by module and service. */
export interface Fakes {
  catalog?: Partial<HubServices['catalog']>;
  link?: { [K in keyof HubServices['link']]?: Partial<HubServices['link'][K]> };
  execution?: { [K in keyof HubServices['execution']]?: Partial<HubServices['execution'][K]> };
  chat?: { [K in keyof HubServices['chat']]?: Partial<HubServices['chat'][K]> };
  index?: { [K in keyof HubServices['index']]?: Partial<HubServices['index'][K]> };
  contextor?: { [K in keyof HubServices['contextor']]?: Partial<HubServices['contextor'][K]> };
  resources?: { [K in keyof HubServices['resources']]?: Partial<HubServices['resources'][K]> };
  mcp?: { [K in keyof HubServices['mcp']]?: Partial<HubServices['mcp'][K]> };
  access?: Partial<HubServices['access']>;
  connections?: Partial<HubServices['connections']>;
  metrics?: { [K in keyof HubServices['metrics']]?: Partial<HubServices['metrics'][K]> };
  models?: { [K in keyof HubServices['models']]?: Partial<HubServices['models'][K]> };
  fns?: { [K in keyof HubServices['fns']]?: Partial<HubServices['fns'][K]> };
}

/** Every key of a service group, from a record that must name them all (so a new service can't be left unfaked). */
function keysOf<G extends object>(all: { readonly [K in keyof G & string]: true }): Array<keyof G & string> {
  return Object.keys(all).filter((key): key is keyof G & string => key in all);
}

/** Fakes for every service of a module group. */
function group<G extends object>(module: string, keys: ReadonlyArray<keyof G & string>, given: { [K in keyof G]?: Partial<G[K]> } = {}): G {
  const out = Object.fromEntries(keys.map((key) => [key, fake(`${module}.${key}`, given[key] ?? {})]));
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- every key of G gets a fake of its service above
  return out as G;
}

/** A `FileStore` in memory. */
export class MemoryFiles implements FileStore {
  readonly objects = new Map<string, { bytes: Uint8Array; info: FileInfo }>();

  async put(key: string, body: FileBody, opts?: { contentType?: string }): Promise<FileInfo> {
    const bytes = await collectBytes(toStream(body));
    const info: FileInfo = { key, size: bytes.length, modifiedAt: Date.now(), ...(opts?.contentType === undefined ? {} : { contentType: opts.contentType }) };
    this.objects.set(key, { bytes, info });
    return info;
  }

  get(key: string): Promise<FileObject | undefined> {
    const found = this.objects.get(key);
    if (found === undefined) { return Promise.resolve(undefined); }
    return Promise.resolve({
      info: found.info,
      stream: () => toStream(found.bytes),
      bytes: () => Promise.resolve(found.bytes),
      text: () => Promise.resolve(new TextDecoder().decode(found.bytes)),
    });
  }

  head(key: string): Promise<FileInfo | undefined> {
    return Promise.resolve(this.objects.get(key)?.info);
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.delete(key));
  }

  list(prefix: string): Promise<{ files: FileInfo[] }> {
    return Promise.resolve({ files: [...this.objects.values()].filter((o) => o.info.key.startsWith(prefix)).map((o) => o.info) });
  }
}

/** Keys for tests (no real VAPID keys needed: the push sender is faked). */
export const TEST_KEYS: HubKeys = {
  jwtSecret: 'test-jwt-secret-test-jwt-secret-0123456789',
  secretKey: 'test-secret-key-test-secret-key-0123456789',
  filesSecret: 'test-files-secret-test-files-secret-012345',
  vapid: { publicKey: 'test-public-key', privateKey: 'test-private-key' },
};

/** A push sender that records what it was asked to send and answers with the given status per endpoint. */
export function recordingPush(status: (endpoint: string) => number = () => 201): PushSender & { sent: Array<{ endpoint: string; payload: string }> } {
  const sent: Array<{ endpoint: string; payload: string }> = [];
  return {
    sent,
    send: (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload: typeof payload === 'string' ? payload : new TextDecoder().decode(payload) });
      const code = status(subscription.endpoint);
      return Promise.resolve({ status: code, ok: code >= 200 && code < 300, gone: code === 404 || code === 410, body: '' });
    },
  };
}

/** Settings for tests: the defaults, with a cheap password hash. */
export function testSettings(): HubSettings {
  const settings = parseHubSettings();
  // systems in tests go live as they pair, and what they do past their grants is only logged, unless a test says so
  return { ...settings, authEnv: { ...settings.authEnv, HARNESS_PASSWORD_COST: 10 }, reviewEnv: { ...settings.reviewEnv, HARNESS_REVIEW_SYSTEMS: false, HARNESS_GRANTS: 'log' } };
}

/** Every hub service: real base and api services, fakes for the other modules. */
export interface Rig {
  readonly hub: HubServices;
  readonly api: ApiServices;
  readonly bus: MemoryEventBus;
  readonly store: HubStore;
  readonly files: MemoryFiles;
  readonly records: LogRecord[];
  readonly push: ReturnType<typeof recordingPush>;
  now: number;
}

/** Make a rig. */
export async function rig(fakes: Fakes = {}, settings: HubSettings = testSettings()): Promise<Rig> {
  const { log, records } = memoryLog();
  const store = await testStore({ log });
  const bus = new MemoryEventBus((event, error) => { log.error('bus.listener.failed', { event }, error); });
  const files = new MemoryFiles();
  const push = recordingPush();
  const state = { now: 1_800_000_000_000 };
  const clock = (): number => state.now;
  const base = { settings, log, clock, bus, store };
  const api = apiServices(base, {
    keys: TEST_KEYS, files, pushSender: push,
    presign: { presignUpload: (key) => Promise.resolve(`/_files?put=${key}`), presignDownload: (key) => Promise.resolve(`/_files?get=${key}`) },
  });
  const hub: HubServices = {
    ...base,
    api,
    ...fakeServices(fakes),
  };
  return {
    hub, api, bus, store, files, records, push,
    get now() { return state.now; },
    set now(value: number) { state.now = value; },
  };
}

/** The web API served in-process from a rig, with the browser's typed client (over HTTP, into `app.fetch`). */
export interface WebRig {
  readonly app: Server<AnySpec>;
  readonly host: PluginHost;
  readonly client: ApiClient<HubWebSpec>;
  /** Make the admin and return its tokens. */
  admin(): Promise<Tokens>;
  /** Call options carrying a bearer token. */
  as(tokens: Tokens): { headers: { authorization: string } };
}

/** Install the web API plugins on an ayepi server over a rig's services. */
export async function webRig(r: Rig): Promise<WebRig> {
  const app = server(spec({ endpoints: {} }), []);
  const host = createPluginHost(app);
  for (const plugin of webPlugins(r.hub, { secret: TEST_KEYS.jwtSecret })) { await host.install(plugin); }
  const client = apiClient<HubWebSpec>({ baseUrl: 'http://hub', manifest: hubWebSpec, validate: hubWebSpec, fetchImpl: (req) => app.fetch(req) });
  return {
    app, host, client,
    admin: () => client.call('createAdmin', { email: 'admin@example.com', name: 'Admin', password: 'correct horse battery' }),
    as: (tokens) => ({ headers: { authorization: `Bearer ${tokens.access}` } }),
  };
}

/** Fakes of the modules other lanes build. */
export function fakeServices(fakes: Fakes = {}): Pick<HubServices, ModuleKey> {
  return {
    catalog: fake('catalog', fakes.catalog),
    link: group<HubServices['link']>('link', keysOf<HubServices['link']>({ connections: true, pairing: true, config: true, supervisor: true, admin: true, resources: true, tokens: true, output: true, packages: true, instances: true, autoPairs: true, lifecycle: true, grants: true }), {
      ...fakes.link,
      // nothing is switched off or waiting for review unless a test says so
      lifecycle: { off: () => Promise.resolve(new Set<string>()), offItems: () => Promise.resolve([]), stage: () => Promise.resolve('live'), ...fakes.link?.lifecycle },
    }),
    execution: group('execution', keysOf<HubServices['execution']>({ runs: true, agents: true, llm: true, limits: true, ledger: true, policies: true, handlers: true, providers: true }), fakes.execution),
    chat: group('chat', keysOf<HubServices['chat']>({
      sessions: true, turns: true, reply: true, enrich: true, state: true, deliveries: true, undo: true, mentions: true, presence: true, notifications: true, approvers: true, suggestions: true,
    }), fakes.chat),
    index: group('index', keysOf<HubServices['index']>({ embedders: true, indexer: true, search: true, suggest: true }), fakes.index),
    contextor: group('contextor', keysOf<HubServices['contextor']>({ planner: true, limits: true, tokens: true, graph: true, views: true, dynamic: true }), fakes.contextor),
    resources: group('resources', keysOf<HubServices['resources']>({ library: true, forms: true, reader: true, content: true, context: true }), fakes.resources),
    mcp: group('mcp', keysOf<HubServices['mcp']>({ registry: true, scopes: true, endpoints: true, tokens: true }), fakes.mcp),
    metrics: group('metrics', keysOf<HubServices['metrics']>({ calls: true, fns: true }), fakes.metrics),
    models: group('models', keysOf<HubServices['models']>({ roles: true, gateway: true }), fakes.models),
    access: fake<HubServices['access']>('access', { scope: (actor) => Promise.resolve(openScope(actor)), ...fakes.access }),
    connections: fake<HubServices['connections']>('connections', fakes.connections),
    fns: group('fns', keysOf<HubServices['fns']>({ search: true, examples: true, facts: true, gate: true, classifier: true, clientLogs: true }), fakes.fns),
  };
}

/** Module factories that build fakes (each service answers only what `fakes` gives), with an in-memory store. */
export function fakeModules(fakes: Fakes = {}): HubModules {
  const services = fakeServices(fakes);
  return {
    store: (options) => openSqliteStore({ ...options, file: ':memory:' }),
    catalog: () => ({ services: services.catalog }),
    link: () => ({ services: services.link }),
    execution: () => ({ services: services.execution }),
    chat: () => ({ services: services.chat }),
    index: () => ({ services: services.index }),
    contextor: () => ({ services: services.contextor }),
    resources: () => ({ services: services.resources }),
    mcp: () => ({ services: services.mcp }),
    metrics: () => ({ services: services.metrics }),
    models: () => ({ services: services.models }),
    access: () => ({ services: services.access }),
    connections: () => ({ services: services.connections }),
    fns: () => ({ services: services.fns }),
  };
}

/** A fake `Catalog.entries` answering from these entries per section. */
/** A manifest of a system with every section empty, plus the parts a test cares about (its client build, say). */
export function testManifest(name: SystemName, part: Partial<Manifest> = {}): Manifest {
  return {
    name, version: '1', description: '', hash: 'h', types: [], settings: [], attachments: [], kinds: [], fns: [], context: [], hooks: [],
    mentions: [], embedders: [], sectioners: [], actions: [], events: [], resources: false, config: { name: 'object', props: {} }, requires: [], ...part,
  };
}

export function entriesFrom(sections: { readonly [S in ManifestSection]?: ReadonlyArray<CatalogEntry<S>> }): Catalog['entries'] {
  return <S extends ManifestSection>(section: S, filter?: { system?: SystemName }) => {
    const entries: ReadonlyArray<CatalogEntry<S>> = sections[section] ?? [];
    return Promise.resolve(entries.filter((entry) => filter?.system === undefined || entry.system === filter.system));
  };
}
