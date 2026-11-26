/**
 * The resources module's test doubles: a content store over an in-memory SQLite file store, a raw reader serving a
 * map of system resources, model-made forms that count their calls, a context graph and an indexer that keep what
 * they were told, and `resourcesRig`, which puts the real services together over them. Tests only.
 */
import { deflateSync } from 'node:zlib';
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

  /** Questions asked about images (`hub/image_read`); refused like the real one while descriptions are off. */
  readonly asked: Array<{ question: string; name: string; who: Asking }> = [];

  ask(question: string, input: MadeFormInput, who: Asking): Promise<MadeForm> {
    this.asked.push({ question, name: input.name, who });
    if (this.off.has('description')) { return Promise.reject(new Error('no image model is set up')); }
    return Promise.resolve({ text: `answer about ${input.name}: ${question}`, model: 'test/vision' });
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

/** One page of a made pdf: a bitmap (grey or RGB samples, optionally with a soft mask), a JPEG's bytes, or text. */
export type MadePage =
  | { readonly kind: 'bitmap'; readonly width: number; readonly height: number; readonly channels: 1 | 3; readonly samples: Uint8Array; readonly alpha?: Uint8Array }
  | { readonly kind: 'jpeg'; readonly width: number; readonly height: number; readonly bytes: Uint8Array }
  | { readonly kind: 'text'; readonly text: string };

/**
 * A small real pdf: a catalog, a page tree and one page per entry, each picture as an image object (Flate or DCT) or
 * a line of text in Helvetica, with a correct xref table so pdf readers take it as it is. Tests only.
 */
export function madePdf(pages: readonly MadePage[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (chunk: Uint8Array | string): void => {
    const data = typeof chunk === 'string' ? new Uint8Array(Buffer.from(chunk, 'latin1')) : chunk;
    parts.push(data);
    size += data.length;
  };
  const object = (number: number, dict: string, stream?: Uint8Array): void => {
    offsets[number] = size;
    push(`${number} 0 obj\n${dict}\n`);
    if (stream !== undefined) { push('stream\n'); push(stream); push('\nendstream\n'); }
    push('endobj\n');
  };
  push('%PDF-1.4\n%âãÏÓ\n');
  const font = 3;
  let next = 4;
  const kids: number[] = [];
  const bodies: Array<() => void> = [];
  for (const page of pages) {
    const pageNumber = next++;
    const contents = next++;
    kids.push(pageNumber);
    if (page.kind === 'text') {
      const text = `BT /F1 18 Tf 72 720 Td (${page.text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
      bodies.push(() => {
        object(pageNumber, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents} 0 R >>`);
        object(contents, `<< /Length ${text.length} >>`, new Uint8Array(Buffer.from(text, 'latin1')));
      });
      continue;
    }
    const image = next++;
    const mask = page.kind === 'bitmap' && page.alpha !== undefined ? next++ : undefined;
    const draw = `q 612 0 0 792 0 0 cm /Im1 Do Q`;
    bodies.push(() => {
      object(pageNumber, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${image} 0 R >> >> /Contents ${contents} 0 R >>`);
      object(contents, `<< /Length ${draw.length} >>`, new Uint8Array(Buffer.from(draw, 'latin1')));
      if (page.kind === 'jpeg') {
        object(image, `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>`, page.bytes);
        return;
      }
      const packed = new Uint8Array(deflateSync(page.samples));
      const space = page.channels === 3 ? '/DeviceRGB' : '/DeviceGray';
      object(image, `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace ${space} /BitsPerComponent 8${mask === undefined ? '' : ` /SMask ${mask} 0 R`} /Filter /FlateDecode /Length ${packed.length} >>`, packed);
      if (mask !== undefined && page.alpha !== undefined) {
        const alpha = new Uint8Array(deflateSync(page.alpha));
        object(mask, `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${alpha.length} >>`, alpha);
      }
    });
  }
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  object(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const body of bodies) { body(); }
  const xref = size;
  const count = next;
  const rows = Array.from({ length: count }, (_, i) => (i === 0 ? '0000000000 65535 f \n' : `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`));
  push(`xref\n0 ${count}\n${rows.join('')}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}
