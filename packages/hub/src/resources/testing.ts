/**
 * The resources module's test doubles: a content store over an in-memory SQLite file store, a raw reader serving a
 * map of system resources, model-made forms that count their calls, a context graph and an indexer that keep what
 * they were told, and `resourcesRig`, which puts the real services together over them. Tests only.
 */
import type { Presigner } from '@ayepi/files';
import {
  ActorId, linkTargetKey, ResourceStat, SessionId, SystemName, type ContextLink, type ContextRecord, type IndexedKind, type MadeFormKind, type QualifiedName,
  type ResourceLink, type ResourceUri,
} from '@harness/core';
import { FileContentStore } from '../api/files.ts';
import { memoryLog, RecordingBus, testStore } from '../testing.ts';
import type { ContextGraph } from '../contextor/index.ts';
import type { IndexItem, Indexer } from '../index/index.ts';
import { StoreContextLibrary } from './context.ts';
import { RegistryConverters } from './converters.ts';
import type { FetchedUrl, UrlFetcher } from './fetch.ts';
import { StoreFormService } from './forms.ts';
import type { Asking, FormModels, MadeForm, MadeFormInput } from './index.ts';
import { HubResourceLibrary } from './library.ts';
import type { RawReader, RawResource } from './raw.ts';
import { FormReader } from './reader.ts';
import { SqliteFiles } from './sqlite-files.ts';

/** A presigner that writes plain URLs naming the key. */
export const fakePresign: Presigner = {
  presignDownload: (key) => Promise.resolve(`https://files.test/${key}`),
  presignUpload: (key) => Promise.resolve(`https://files.test/upload/${key}`),
};

/** A content store over an in-memory SQLite file store. */
export function memoryContent(clock: () => number = () => 0): FileContentStore {
  return new FileContentStore({ files: new SqliteFiles({ file: ':memory:', busyTimeout: 1_000, clock }), presign: fakePresign, maxUpload: 50 * 1024 * 1024, presignTtl: 60_000, clock });
}

/** A system resource a `MapRawReader` serves. */
export interface Served {
  readonly stat: ResourceStat;
  readonly bytes?: Uint8Array;
  readonly text?: string;
  readonly links?: ResourceLink[];
}

/** A resource stat for tests. */
export function statOf(uri: string, fields: Partial<ResourceStat> = {}): ResourceStat {
  return ResourceStat.parse({ uri, name: uri.slice(uri.lastIndexOf('/') + 1), type: 'file', version: 'v1', ...fields });
}

/** A raw reader serving resources from a map, counting reads. */
export class MapRawReader implements RawReader {
  readonly served = new Map<string, Served>();
  readonly system = SystemName.parse('fs');
  reads = 0;

  serve(resource: Served): void {
    this.served.set(resource.stat.uri, resource);
  }

  read(uri: ResourceUri): Promise<RawResource> {
    this.reads += 1;
    const found = this.served.get(uri);
    if (found === undefined) { return Promise.reject(new Error(`nothing serves ${uri}`)); }
    return Promise.resolve({
      system: this.system, stat: found.stat, links: found.links ?? [],
      ...(found.bytes === undefined ? {} : { bytes: found.bytes }), ...(found.text === undefined ? {} : { text: found.text }),
    });
  }

  stat(uri: ResourceUri): Promise<ResourceStat | undefined> {
    return Promise.resolve(this.served.get(uri)?.stat);
  }
}

/** Model-made forms that answer with a fixed text per kind, counting calls (and waiting on `gate` when set). */
export class FakeFormModels implements FormModels {
  readonly calls: Array<{ kind: MadeFormKind; name: string; who: Asking }> = [];
  gate: Promise<void> | undefined;
  off = new Set<MadeFormKind>();

  model(kind: MadeFormKind): Promise<string | undefined> {
    return Promise.resolve(this.off.has(kind) || kind === 'thumbnail' ? undefined : 'test/vision');
  }

  async make(kind: MadeFormKind, input: MadeFormInput, who: Asking): Promise<MadeForm> {
    this.calls.push({ kind, name: input.name, who });
    if (this.off.has(kind)) { throw new Error(`no model is set for ${kind}`); }
    await this.gate;
    return { text: `${kind} of ${input.name}`, model: 'test/vision' };
  }
}

/** A context graph that keeps edges in memory. */
export class MemoryGraph implements ContextGraph {
  readonly edges = new Map<string, ContextLink>();
  readonly derived: QualifiedName[] = [];

  links(from: QualifiedName): Promise<ContextLink[]> {
    return Promise.resolve([...this.edges.values()].filter((edge) => edge.from === from));
  }

  backlinks(to: Parameters<ContextGraph['backlinks']>[0]): Promise<ContextLink[]> {
    const key = linkTargetKey(to);
    return Promise.resolve([...this.edges.values()].filter((edge) => edge.toKey === key));
  }

  neighbours(): Promise<ReadonlyMap<QualifiedName, number>> {
    return Promise.resolve(new Map());
  }

  derive(record: ContextRecord): Promise<void> {
    this.derived.push(record.name);
    return Promise.resolve();
  }

  replaceResourceLinks(from: QualifiedName, links: ReadonlyArray<Pick<ContextLink, 'to' | 'relation' | 'weight'>>): Promise<void> {
    for (const [key, edge] of this.edges) { if (edge.from === from && edge.source === 'resource') { this.edges.delete(key); } }
    for (const link of links) { this.#put({ from, ...link, toKey: linkTargetKey(link.to), source: 'resource', updatedAt: 0 }); }
    return Promise.resolve();
  }

  learn(): Promise<void> {
    return Promise.resolve();
  }

  author(input: Parameters<ContextGraph['author']>[0]): Promise<ContextLink> {
    const edge: ContextLink = { from: input.from, to: input.to, toKey: linkTargetKey(input.to), relation: input.relation, weight: input.weight, source: 'authored', updatedAt: 0 };
    this.#put(edge);
    return Promise.resolve(edge);
  }

  remove(key: Pick<ContextLink, 'from' | 'toKey' | 'relation'>): Promise<boolean> {
    return Promise.resolve(this.edges.delete(`${key.from}|${key.toKey}|${key.relation}`));
  }

  #put(edge: ContextLink): void {
    this.edges.set(`${edge.from}|${edge.toKey}|${edge.relation}`, edge);
  }
}

/** An indexer that keeps what it was given. */
export class KeepingIndexer implements Pick<Indexer, 'upsert' | 'remove'> {
  readonly items = new Map<string, IndexItem>();

  upsert(items: readonly IndexItem[]): Promise<void> {
    for (const item of items) { this.items.set(`${item.kind}:${item.key}`, item); }
    return Promise.resolve();
  }

  remove(kind: IndexedKind, keys: readonly string[]): Promise<void> {
    for (const key of keys) { this.items.delete(`${kind}:${key}`); }
    return Promise.resolve();
  }
}

/** A URL fetcher answering from a map. */
export class MapFetcher implements UrlFetcher {
  readonly pages = new Map<string, FetchedUrl>();
  fetched: string[] = [];

  fetch(url: string): Promise<FetchedUrl> {
    this.fetched.push(url);
    const page = this.pages.get(url);
    return page === undefined ? Promise.reject(new Error(`404 ${url}`)) : Promise.resolve(page);
  }
}

/** The person tests ask as. */
export const ALICE = ActorId.parse('act_alice');
/** Another person. */
export const BOB = ActorId.parse('act_bob');
/** The hub's own actor. */
export const HUB_ACTOR = ActorId.parse('act_hub');
/** A session. */
export const SESSION = SessionId.parse('ses_one');

/** The resources module's real services over the test doubles. */
export async function resourcesRig(options: { pieceTokens?: number; maxRows?: number } = {}) {
  const store = await testStore();
  const { log, records } = memoryLog();
  const time = { now: Date.UTC(2026, 10, 7, 12) };
  const clock = () => time.now;
  const bus = new RecordingBus();
  const content = memoryContent(clock);
  const raw = new MapRawReader();
  const models = new FakeFormModels();
  const converters = new RegistryConverters({ maxRows: options.maxRows ?? 5_000 });
  const graph = new MemoryGraph();
  const indexer = new KeepingIndexer();
  const fetcher = new MapFetcher();
  const changed: string[] = [];
  const settings = {
    HARNESS_CONTENT_AT: 'files', HARNESS_IMPORT_MAX: 10 * 1024 * 1024, HARNESS_SNAPSHOT_MAX: 1024 * 1024 * 1024, HARNESS_TABLE_ROWS: options.maxRows ?? 5_000,
    HARNESS_DESCRIBE_ON_INDEX: false, HARNESS_FORM_CONCURRENCY: 2, HARNESS_READ_CHARS: 20_000, HARNESS_CONTEXT_PIECE_TOKENS: options.pieceTokens ?? 600, HARNESS_FETCH_TIMEOUT: 5_000,
    HARNESS_FETCH_REDIRECTS: 8, HARNESS_FETCH_PRIVATE: false,
  } as const;
  const forms = new StoreFormService({ store, content, raw, converters, models, log, clock, settings, onForms: (record) => { changed.push(record.uri); } });
  const reader = new FormReader({ store, content, forms, readChars: settings.HARNESS_READ_CHARS });
  const library = new HubResourceLibrary({ store, content, forms: () => forms, fetcher, converters, indexer: () => indexer, bus, log, clock, settings, hubActor: HUB_ACTOR });
  const contexts: QualifiedName[] = [];
  const context = new StoreContextLibrary({
    store, forms: () => forms, reader: () => reader, graph: () => graph, indexer: () => indexer, log, clock, settings, hubActor: HUB_ACTOR,
    onContext: (name) => { contexts.push(name); },
  });
  return { store, log, records, time, clock, bus, content, raw, models, converters, graph, indexer, fetcher, changed, contexts, settings, forms, reader, library, context };
}

/** UTF-8 bytes of a text. */
export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
