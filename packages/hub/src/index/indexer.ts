/**
 * Keeping the index current. Every item (a fn, context, type, section or message) is stored as text under the
 * document embedder's name, kept in the full-text index at once, and embedded when the document embedder is
 * connected; an item whose text hash hasn't changed is left alone. Items stored while no embedder was connected
 * (`vectorHash` behind `hash`) are embedded once one connects. The indexer follows the bus: a catalog change
 * re-indexes the systems it touched; a resource change re-sections that resource, by its root's index policy.
 * A context item is indexed whole and by its heading sections too (`contextSection`, `context-sections.ts`): its
 * sections follow it on every upsert (a section gone from its text is dropped) and are dropped with it; on start, an
 * item indexed before it had sections indexed (an older hub) gets them.
 * Resources are read through the router (their raw text) until the resources module gives an `IndexReader`
 * (`readWith`): then the hub's own resources are indexed too, every resource is cut in its primary form (markdown for
 * a web page, tables for a spreadsheet), and the reader hears each section diff (snapshot context goes stale).
 *
 * Store calls are synchronous SQLite work, so long loops (a backfill of thousands of items at startup) give way to
 * the event loop every `ROWS_PER_TURN` rows, and requests keep being answered meanwhile. Embedding goes a chunk at a
 * time, each chunk's vectors saved as it finishes: a failure keeps what was done, and a backfill is tried again
 * later (the wait doubling up to a most).
 *
 * Pictures (`images.ts`: image resources, and the images context items show) are indexed as `image` items while an
 * image space is set up (`Embedders.images`): their caption in the full-text index under the document embedder like
 * every item, their vector in the image space's table (the document embedder's own when the space is shared). An image
 * row counts as embedded when its `vectorHash` is its hash in the space in use (`imageVectorHash`), so a change of
 * space embeds every picture again there (the old space's image vectors are dropped). With no image space nothing about
 * images is indexed, as before.
 */
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Logger } from '@ayepi/log';
import {
  ResourceUri, SystemName, compositeKey, splitName, type ContextDecl, type EmbedInput, type FnDecl, type IndexEntry, type IndexedKind, type QualifiedName,
  type SectionDiff, type SectionKey, type SectionRow, type TypeRecord,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { allRows, rows as storedRows } from '../store/rows.ts';
import { messageOf } from '../catalog/scope.ts';
import { Serial } from '../catalog/serial.ts';
import { sha256Hex } from '../link/keys.ts';
import type { ResourceRouter } from '../link/index.ts';
import { underRoot } from '../link/resources.ts';
import type { HubStore } from '../store/index.ts';
import type { EmbedBatcher } from './batch.ts';
import { contextSectionItems } from './context-sections.ts';
import { contextImageItems, isPicture, resourceImageItem } from './images.ts';
import type { Embedder, Embedders, ImageSpace, IndexItem, IndexReader, Indexer, PrimaryText, VectorTiming } from './index.ts';
import type { Sectioning } from './sectioning.ts';

/** What the indexer needs. */
export interface IndexerOptions {
  readonly store: HubStore;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly clock: () => number;
  readonly catalog: Catalog;
  readonly embedders: Embedders;
  readonly batcher: EmbedBatcher;
  readonly router: ResourceRouter;
  readonly sectioning: Sectioning;
  /** The document embedder's name: every item is stored under it. */
  readonly document: QualifiedName;
  /** The most characters of an item that are indexed. */
  readonly maxText: number;
  /** The most resources one crawl of a root looks at. */
  readonly maxCrawl: number;
  /** Rows embedded and saved together (`HARNESS_INDEX_EMBED_BATCH`): one embedder call's worth per chunk at most. */
  readonly chunk: number;
  /** How long after a failed embedding a backfill is tried again, at first and at most (it doubles between). */
  readonly retry: { readonly first: number; readonly most: number };
  /** The most bytes of a picture that are embedded (`HARNESS_INDEX_IMAGE_MAX`); a larger one is left out. */
  readonly maxPicture?: number;
}

/** The most bytes of a picture embedded when the options don't say (`HARNESS_INDEX_IMAGE_MAX`'s default). */
export const MAX_PICTURE_BYTES = 5_000_000;

/** The kinds that are parts of a context item (`IndexEntry.parent`): found, kept current and dropped with it. */
const CONTEXT_PARTS = ['contextSection', 'image'] as const satisfies readonly IndexedKind[];

/** The `vectorHash` of an image row once embedded in a space: its hash there, so another space embeds it again. */
export function imageVectorHash(hash: string, space: QualifiedName): string {
  return sha256Hex(`${hash}\n${space}`);
}

/** An item's hash: its text's, and for a picture its source and version too (a new picture is embedded again). */
function itemHash(text: string, item: Pick<IndexItem, 'image'>): string {
  return sha256Hex(item.image === undefined ? text : `${text}\n${item.image.source}\n${item.image.version ?? ''}`);
}

/** How many rows a loop of store calls handles before it gives way to the event loop. */
const ROWS_PER_TURN = 100;

/** Give way to the event loop after every `ROWS_PER_TURN`th row (`index` counts from 0). */
async function breathe(index: number): Promise<void> {
  if (index % ROWS_PER_TURN === ROWS_PER_TURN - 1) { await nextTurn(); }
}

/** The kinds a system's contract contributes. */
/** Context items whose sections the start-up catch-up indexes together. */
const SECTION_CATCH_UP = 50;

const CONTRACT_KINDS = ['fn', 'context', 'type'] as const satisfies readonly IndexedKind[];

/** A fn's indexed text: what it is called, what it does, and its tags. */
export function fnText(name: string, decl: FnDecl): string {
  return [`${name}: ${decl.description}`, decl.instructions, decl.tags.length > 0 ? `Tags: ${decl.tags.join(', ')}` : undefined].filter((l) => l !== undefined).join('\n');
}

/** Context's indexed text: its description and content. */
export function contextText(name: string, decl: ContextDecl): string {
  return [`${name}: ${decl.description}`, decl.command === undefined ? undefined : `/${decl.command.name}`, decl.content].filter((l) => l !== undefined).join('\n');
}

/** A named type's indexed text. */
export function typeText(record: TypeRecord): string {
  return `${record.name} (${record.display.label}): ${record.description}`;
}

/** An index row with its vector forgotten (it is embedded again). */
function withoutVector({ vectorHash: _vectorHash, ...row }: IndexEntry): IndexEntry {
  return row;
}

/** The index key of a section. */
export function sectionIndexKey(uri: ResourceUri, key: SectionKey): string {
  return `${uri}#${key}`;
}

/** A section index key back to its resource and section (the part after the last `#`). */
export function parseSectionIndexKey(key: string): { uri: string; section: string } | { uri: string } {
  const at = key.lastIndexOf('#');
  return at < 0 ? { uri: key } : { uri: key.slice(0, at), section: key.slice(at + 1) };
}

/** Keeps the store's index current. */
export class StoreIndexer implements Indexer {
  readonly #options: IndexerOptions;
  readonly #serial = new Serial();
  /** Embedding, one call of `#embed` at a time. */
  readonly #embedding = new Serial();
  #reader: IndexReader | undefined;
  /** The backfill waiting to try again after a failed embedding, and how long the next wait is. */
  #retry: { timer: NodeJS.Timeout | undefined; wait: number };
  /** Whether the indexer follows the bus (only then are failed embeddings tried again on their own). */
  #following = false;
  /** The image space's table last in use (its embedder's name), so a move to another one moves the pictures. */
  #imageTable: QualifiedName | undefined;
  /** Whether an image space is in use now (pictures made while there was none are caught up when one comes). */
  #imagesLive = false;

  constructor(options: IndexerOptions) {
    this.#options = options;
    this.#retry = { timer: undefined, wait: options.retry.first };
  }

  /** Follow the bus and the embedders. Returns the function that stops following. */
  start(): () => void {
    const { bus, embedders, log } = this.#options;
    this.#following = true;
    const stops = [
      bus.subscribe('catalog.changed', ({ added, removed, fns }) => {
        const systems = new Set<string>([...added, ...removed].map((name) => splitName(name).system));
        for (const fn of fns) { systems.add(fn.system); }
        for (const system of systems) { this.#queue('index.reindex', () => this.reindexSystem(SystemName.parse(system))); }
      }),
      bus.subscribe('resources.changed', ({ changes }) => {
        for (const change of changes) {
          this.#queue('index.resource', () => (change.change === 'removed' ? this.#drop(change.uri) : this.#follow(change.uri)));
        }
      }),
      bus.subscribe('resources.roots', ({ roots }) => {
        for (const root of roots) { if (root.index === 'all') { this.#queue('index.crawl', () => this.crawl(root.uri)); } }
      }),
      embedders.onChange(() => {
        this.#followImages();
        if (embedders.active() !== undefined) { this.#queue('index.backfill', () => this.backfill()); }
      }),
    ];
    // embedders that connected before the indexer started are caught up too
    this.#followImages();
    if (embedders.active() !== undefined) { this.#queue('index.backfill', () => this.backfill()); }
    this.#queue('index.sections', () => this.catchUpSections());
    log.debug('index.started', {});
    return () => {
      for (const stop of stops) { stop(); }
      this.#following = false;
      clearTimeout(this.#retry.timer);
      this.#retry.timer = undefined;
    };
  }

  readWith(reader: IndexReader): () => void {
    this.#reader = reader;
    return () => { if (this.#reader === reader) { this.#reader = undefined; } };
  }

  /** The system serving a URI and its root's index policy: the reader's when there is one, else the router's. */
  #route(uri: ResourceUri): ReturnType<IndexReader['route']> {
    const reader = this.#reader?.route(uri);
    if (reader !== undefined) { return reader; }
    const route = this.#options.router.route(uri);
    return route === undefined ? undefined : { system: route.system, index: route.root.index };
  }

  /** A resource's text as it is cut: its primary form through the reader, else the router's raw text. */
  #text(uri: ResourceUri): Promise<PrimaryText> {
    return this.#reader === undefined ? this.#options.router.text(uri) : this.#reader.primary(uri);
  }

  /** Resolves once everything queued so far has run. */
  idle(): Promise<void> {
    return this.#serial.run(() => Promise.resolve());
  }

  async upsert(given: readonly IndexItem[], options: { readonly vectors?: VectorTiming } = {}): Promise<void> {
    const { store, clock, document, maxText, embedders } = this.#options;
    const pictures = embedders.images() !== undefined;
    const items = given.flatMap((item) => [item, ...contextSectionItems(item), ...(pictures ? contextImageItems(item) : [])]);
    await this.#dropOldParts(items);
    const rows: IndexEntry[] = [];
    for (const [index, item] of items.entries()) {
      await breathe(index);
      const text = item.text.slice(0, maxText);
      const hash = itemHash(text, item);
      const existing = await store.table('index').get({ embedder: document, kind: item.kind, key: item.key });
      if (existing?.hash === hash) { if (this.#waiting(existing)) { rows.push(existing); } continue; }
      rows.push(await store.table('index').put({
        kind: item.kind, key: item.key, text, hash, embedder: document, updatedAt: clock(),
        ...(item.system === undefined ? {} : { system: item.system }),
        ...(item.parent === undefined ? {} : { parent: item.parent }),
        ...(item.image === undefined ? {} : { image: item.image.source }),
        ...(existing?.vectorHash === undefined ? {} : { vectorHash: existing.vectorHash }),
      }));
    }
    if (rows.length === 0) { return; }
    await store.text.upsert(rows.map((r) => ({ kind: r.kind, key: r.key, text: r.text })));
    const embedding = this.#embed(rows.filter((r) => this.#waiting(r)));
    // `#embed` logs its own failures, so a background embedding never rejects
    if (options.vectors === 'background') { void embedding; return; }
    await embedding;
  }

  async remove(kind: IndexedKind, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) { return; }
    const { store, document, embedders } = this.#options;
    if (kind === 'context') {
      for (const part of CONTEXT_PARTS) {
        const parts = await allRows(store.table('index'), { where: { embedder: document, kind: part, parent: { in: keys } } });
        await this.remove(part, parts.map((row) => row.key));
      }
    }
    for (const [index, key] of keys.entries()) {
      await breathe(index);
      await store.table('index').remove({ embedder: document, kind, key });
    }
    await store.text.remove(kind, keys);
    await store.vectors.remove(document, kind, keys);
    // a picture's vector is in the image space's table when that is a second space (the last one in use while there is none)
    const table = embedders.images()?.embedder.name ?? this.#imageTable;
    if (kind === 'image' && table !== undefined && table !== document) { await store.vectors.remove(table, kind, keys); }
  }

  /**
   * Index the heading sections of every context item that has headings but none of its sections indexed yet (an item
   * indexed before sections were), read a page at a time; each item is asked of the database by its first section.
   */
  async catchUpSections(): Promise<void> {
    const { store, document } = this.#options;
    const missing: IndexItem[] = [];
    for await (const record of storedRows(store.table('context'))) {
      const item: IndexItem = { kind: 'context', key: record.name, text: contextText(record.name, record.decl), system: record.system };
      const first = contextSectionItems(item)[0];
      if (first !== undefined && (await store.table('index').get({ embedder: document, kind: 'contextSection', key: first.key })) === undefined) { missing.push(item); }
      if (missing.length >= SECTION_CATCH_UP) { await this.upsert(missing.splice(0), { vectors: 'background' }); }
    }
    if (missing.length > 0) { await this.upsert(missing, { vectors: 'background' }); }
  }

  /**
   * Index the pictures there are but aren't indexed yet, once an image space is set up: the images context items show,
   * and image resources indexed before (a resource indexed after is caught by `resource`). Read a page at a time; each
   * picture is asked of the database by its key.
   */
  async catchUpImages(): Promise<void> {
    const { store, document, embedders } = this.#options;
    if (embedders.images() === undefined) { return; }
    const missing: IndexItem[] = [];
    const add = async (item: IndexItem): Promise<void> => {
      if ((await store.table('index').get({ embedder: document, kind: 'image', key: item.key })) === undefined) { missing.push(item); }
      if (missing.length >= SECTION_CATCH_UP) { await this.upsert(missing.splice(0), { vectors: 'background' }); }
    };
    for await (const record of storedRows(store.table('context'))) {
      for (const item of contextImageItems({ kind: 'context', key: record.name, text: contextText(record.name, record.decl), system: record.system })) { await add(item); }
    }
    for await (const record of storedRows(store.table('resources'))) {
      if (record.indexedVersion !== undefined && isPicture(record.stat)) { await add(resourceImageItem(record.stat, record.system)); }
    }
    if (missing.length > 0) { await this.upsert(missing, { vectors: 'background' }); }
  }

  /**
   * Drop the parts (sections, pictures) a context item being upserted no longer has (found by their parent, in the
   * database).
   */
  async #dropOldParts(items: readonly IndexItem[]): Promise<void> {
    const { store, document } = this.#options;
    const contexts = items.filter((item) => item.kind === 'context').map((item) => item.key);
    if (contexts.length === 0) { return; }
    for (const part of CONTEXT_PARTS) {
      const kept = new Set(items.filter((item) => item.kind === part).map((item) => item.key));
      const parts = await allRows(store.table('index'), { where: { embedder: document, kind: part, parent: { in: contexts } } });
      await this.remove(part, parts.filter((row) => !kept.has(row.key)).map((row) => row.key));
    }
  }

  /**
   * The `vectorHash` a row has once embedded where it belongs now: its hash (text), or its hash in the image space in
   * use (a picture); undefined for a picture while there is no image space (it isn't embedded).
   */
  #target(row: Pick<IndexEntry, 'kind' | 'hash'>): string | undefined {
    if (row.kind !== 'image') { return row.hash; }
    const space = this.#options.embedders.images();
    return space === undefined ? undefined : imageVectorHash(row.hash, space.embedder.name);
  }

  /** Whether a row waits to be embedded (in the image space, for a picture). */
  #waiting(row: Pick<IndexEntry, 'kind' | 'hash' | 'vectorHash'>): boolean {
    const target = this.#target(row);
    return target !== undefined && row.vectorHash !== target;
  }

  /**
   * Follow the image space: when it moves to another table, the old one's picture vectors are dropped (rows keep their
   * captions) and the pictures are caught up and embedded in the new one. While there is none (its system went away,
   * or the setting is off) the vectors stay where they are: search finds pictures by their captions alone then, and the
   * same space coming back (its system reconnecting) needs nothing embedded again. `#imageTable` is the last space in use.
   */
  #followImages(): void {
    const table = this.#options.embedders.images()?.embedder.name;
    const wasLive = this.#imagesLive;
    this.#imagesLive = table !== undefined;
    // the same space still in use: nothing moved (the embedders changed for another reason)
    if (table === undefined || (wasLive && table === this.#imageTable)) { return; }
    const old = this.#imageTable;
    this.#imageTable = table;
    this.#queue('index.images', async () => {
      if (old !== undefined && old !== table) { await this.#dropImageVectors(old); }
      await this.catchUpImages();
      await this.backfill();
    });
  }

  /** Remove every picture's vector from a table (an image space no longer in use), read from the database a page at a time. */
  async #dropImageVectors(table: QualifiedName): Promise<void> {
    const { store, document, log } = this.#options;
    const keys: string[] = [];
    for await (const row of storedRows(store.table('index'), { where: { embedder: document, kind: 'image' } })) { keys.push(row.key); }
    await store.vectors.remove(table, 'image', keys);
    log.info('index.images.moved', { from: table, pictures: keys.length });
  }

  async reindexSystem(system: SystemName): Promise<void> {
    const { store, catalog, document } = this.#options;
    const items: IndexItem[] = [
      ...(await catalog.fns({ system })).map((fn): IndexItem => ({ kind: 'fn', key: fn.name, text: fnText(fn.name, fn.decl), system })),
      ...(await allRows(store.table('context'), { where: { system } })).map((c): IndexItem => ({ kind: 'context', key: c.name, text: contextText(c.name, c.decl), system })),
      ...(await allRows(store.table('types'), { where: { system } })).map((t): IndexItem => ({ kind: 'type', key: t.name, text: typeText(t), system })),
    ];
    await this.upsert(items);
    const current = new Set(items.map((i) => compositeKey(i.kind, i.key)));
    for (const kind of CONTRACT_KINDS) {
      const stale = (await allRows(store.table('index'), { where: { embedder: document, system, kind } })).filter((r) => !current.has(compositeKey(kind, r.key)));
      await this.remove(kind, stale.map((r) => r.key));
    }
  }

  async resource(uri: ResourceUri): Promise<SectionDiff | undefined> {
    const { store, sectioning, clock, log } = this.#options;
    const route = this.#route(uri);
    if (route === undefined || !await this.#offered(route.system, uri)) { return undefined; }
    const read = await this.#text(uri);
    const { stat, text, links } = read;
    const record = await store.table('resources').get(uri);
    if (record?.indexedVersion === stat.version) { return undefined; }
    const sectioner = await sectioning.choose(stat, route.system, read.form);
    const sections = await sectioning.cut(sectioner, uri, { text, stat, ...(read.form === undefined ? {} : { form: read.form }), ...(read.version === undefined ? {} : { version: read.version }) });
    const before = record?.indexedVersion === undefined ? [] : await allRows(store.table('sections'), { where: { uri, version: record.indexedVersion } });
    const old = new Map(before.map((row) => [row.key, row]));
    const rows: SectionRow[] = sections.map((s) => ({ ...s, uri, version: stat.version, hash: sha256Hex(text.slice(s.start, s.end)) }));
    const diff: SectionDiff = { uri, from: record?.indexedVersion ?? '', to: stat.version, added: [], changed: [], removed: [] };
    for (const row of rows) {
      const prior = old.get(row.key);
      if (prior === undefined) { diff.added.push(row.key); } else if (prior.hash !== row.hash) { diff.changed.push(row.key); }
      old.delete(row.key);
    }
    diff.removed.push(...old.keys());
    await store.tx(async (tx) => {
      for (const row of before) { await tx.table('sections').remove(row); }
      for (const row of rows) { await tx.table('sections').put(row); }
      // the resources module may have written the record's raw content and forms meanwhile: keep them
      const latest = await tx.table('resources').get(uri);
      await tx.table('resources').put({ ...latest, uri, system: route.system, stat, links, indexedVersion: stat.version, sectioner, seenAt: clock() });
    });
    await this.upsert(rows.filter((r) => diff.added.includes(r.key) || diff.changed.includes(r.key) || record?.indexedVersion === undefined).map((r) => ({
      kind: 'section', key: sectionIndexKey(uri, r.key), system: route.system,
      text: r.embedText ?? `${stat.name}${r.path.length > 0 ? ` > ${r.path.join(' > ')}` : ''}\n\n${text.slice(r.start, r.end)}`,
    })));
    // a picture is embedded in the image space too, captioned by its description when one was made
    if (isPicture(stat) && this.#options.embedders.images() !== undefined) { await this.upsert([resourceImageItem(stat, route.system, read.form === 'description' ? text : undefined)]); }
    await this.remove('section', diff.removed.map((key) => sectionIndexKey(uri, key)));
    log.info('index.resource', { uri, sectioner, form: read.form, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length });
    if (record?.indexedVersion !== undefined && (diff.changed.length > 0 || diff.removed.length > 0)) { await this.#reader?.sectioned(diff); }
    return diff;
  }

  /**
   * Embed everything stored while no embedder was connected, whose vector was dropped when the size changed, or (a
   * picture) not yet embedded in the image space in use.
   */
  async backfill(): Promise<void> {
    const { store, document, embedders } = this.#options;
    const active = embedders.active();
    if (active === undefined && embedders.images() === undefined) { return; }
    if (active !== undefined) { await this.#sized(active.document.dimensions); }
    const waiting = (await allRows(store.table('index'), { where: { embedder: document } })).filter((r) => this.#waiting(r));
    await this.#embed(waiting);
  }

  /**
   * Size the vector table by the document embedder's declared dimensions (the one source of the size). When they
   * changed, the old vectors were dropped: every item is marked unembedded, and a backfill embeds them again.
   */
  async #sized(dimensions: number): Promise<void> {
    const { store, document, log } = this.#options;
    if (!(await store.vectors.ensure(document, dimensions))) { return; }
    log.warn('index.vectors.resized', { embedder: document, dimensions });
    for (const [index, row] of (await allRows(store.table('index'), { where: { embedder: document } })).entries()) {
      await breathe(index);
      if (row.vectorHash !== undefined) { await store.table('index').put(withoutVector(row)); }
    }
    this.#queue('index.backfill', () => this.backfill());
  }

  /**
   * Embed rows, a bounded chunk at a time (`chunk`, `HARNESS_INDEX_EMBED_BATCH`): text with the document embedder, if
   * it is connected, and pictures with the image space's, if there is one. Each chunk's vectors are saved (and its rows
   * marked embedded) as it lands. Embedding runs one call of this at a time, so a catch-up and the upserts beside it
   * never flood the embedder, and a row embedded meanwhile is skipped. A row given a vector of the wrong size, or a
   * picture that can't be read, is left out. A failure keeps the chunks already saved, leaves the rest (the next
   * backfill starts from the first unsaved row), and backs off.
   */
  #embed(rows: readonly IndexEntry[]): Promise<void> {
    return this.#embedding.run(() => this.#embedNow(rows));
  }

  async #embedNow(rows: readonly IndexEntry[]): Promise<void> {
    const { embedders, log, document } = this.#options;
    const active = embedders.active();
    const space = embedders.images();
    const texts = active === undefined ? [] : rows.filter((row) => row.kind !== 'image');
    const pictures = space === undefined ? [] : rows.filter((row) => row.kind === 'image');
    if (texts.length + pictures.length === 0) { return; }
    const progress = { done: 0 };
    try {
      if (active !== undefined && texts.length > 0) {
        await this.#sized(active.document.dimensions);
        await this.#embedInto(texts, active.document, document, (row) => Promise.resolve(row.text), progress);
      }
      if (space !== undefined && pictures.length > 0) {
        await this.#sizedImages(space);
        await this.#embedInto(pictures, space.embedder, space.embedder.name, (row) => this.#picture(row), progress);
      }
      this.#retry.wait = this.#options.retry.first;
    } catch (error) {
      log.warn('index.embed.failed', { items: texts.length + pictures.length - progress.done, saved: progress.done, error: messageOf(error) });
      this.#tryAgainLater();
    }
  }

  /** Embed rows with one embedder into one vector table, a chunk at a time, each row's input read by `input`. */
  async #embedInto(
    rows: readonly IndexEntry[], embedder: Embedder, table: QualifiedName, input: (row: IndexEntry) => Promise<EmbedInput | undefined>, progress: { done: number },
  ): Promise<void> {
    const { store, batcher, log, chunk } = this.#options;
    const { name, dimensions } = embedder;
    for (let at = 0; at < rows.length; at += chunk) {
      const part = (await Promise.all(rows.slice(at, at + chunk).map((r) => store.table('index').get(r))))
        .filter((r): r is IndexEntry => r !== undefined && this.#waiting(r));
      const read = (await Promise.all(part.map(async (row) => ({ row, input: await input(row) }))))
        .filter((entry): entry is { row: IndexEntry; input: EmbedInput } => entry.input !== undefined);
      if (read.length > 0) {
        const vectors = await batcher.embed(name, read.map((entry) => entry.input), 'background');
        const good = read.flatMap(({ row }, i) => {
          const vector = vectors[i];
          if (vector?.length === dimensions) { return [{ row, vector }]; }
          log.warn('index.embed.bad-vector', { embedder: name, kind: row.kind, key: row.key, dimensions, got: vector?.length ?? 0 });
          return [];
        });
        await store.vectors.upsert(table, good.map(({ row, vector }) => ({ kind: row.kind, key: row.key, vector })));
        await store.tx(async (tx) => { for (const { row } of good) { await tx.table('index').update(row, { vectorHash: this.#target(row) }); } });
        await nextTurn();
      }
      progress.done += Math.min(chunk, rows.length - at);
    }
  }

  /**
   * Size the image space's table by its embedder's dimensions: the text space's sizing when it is shared, else its own
   * table, whose pictures are marked unembedded (and embedded again) when the size changed.
   */
  async #sizedImages(space: ImageSpace): Promise<void> {
    const { store, document, log } = this.#options;
    if (space.shared) { await this.#sized(space.embedder.dimensions); return; }
    if (!(await store.vectors.ensure(space.embedder.name, space.embedder.dimensions))) { return; }
    log.warn('index.vectors.resized', { embedder: space.embedder.name, dimensions: space.embedder.dimensions });
    for (const [index, row] of (await allRows(store.table('index'), { where: { embedder: document, kind: 'image' } })).entries()) {
      await breathe(index);
      if (row.vectorHash !== undefined) { await store.table('index').put(withoutVector(row)); }
    }
    this.#queue('index.backfill', () => this.backfill());
  }

  /**
   * A picture as the image space embeds it: an http(s) URL as it is, a resource's bytes (through the reader) as a data
   * URL; undefined (left out, with a warning) when it can't be read or is over `maxPicture`.
   */
  async #picture(row: IndexEntry): Promise<EmbedInput | undefined> {
    const { log, maxPicture = MAX_PICTURE_BYTES } = this.#options;
    const source = row.image;
    if (source === undefined) { return undefined; }
    if (/^https?:\/\//i.test(source)) { return { image: source }; }
    try {
      const uri = ResourceUri.safeParse(source);
      const picture = uri.success ? await this.#reader?.picture?.(uri.data) : undefined;
      if (picture === undefined) { log.warn('index.embed.no-picture', { key: row.key }); return undefined; }
      if (picture.bytes.length > maxPicture) { log.warn('index.embed.picture-too-large', { key: row.key, bytes: picture.bytes.length, most: maxPicture }); return undefined; }
      return { image: `data:${picture.mime};base64,${Buffer.from(picture.bytes).toString('base64')}`, mimeType: picture.mime };
    } catch (error) {
      log.warn('index.embed.no-picture', { key: row.key, error: messageOf(error) });
      return undefined;
    }
  }

  /** Backfill again after a wait, once (a wait already set stands); each failure doubles the next wait, up to the most. */
  #tryAgainLater(): void {
    if (!this.#following || this.#retry.timer !== undefined) { return; }
    const { wait } = this.#retry;
    this.#retry.wait = Math.min(this.#options.retry.most, wait * 2);
    this.#retry.timer = setTimeout(() => {
      this.#retry.timer = undefined;
      this.#queue('index.backfill', () => this.backfill());
    }, wait);
    this.#retry.timer.unref();
  }

  /**
   * Walk a root and index every resource whose version isn't the one indexed (a root that indexes everything, on
   * connect: files changed while the hub was away are caught up). Returns how many it indexed.
   */
  async crawl(root: ResourceUri): Promise<number> {
    const { router, store, log, maxCrawl } = this.#options;
    const folders: ResourceUri[] = [root];
    let seen = 0;
    let indexed = 0;
    while (folders.length > 0 && seen < maxCrawl) {
      const folder = folders.shift();
      if (folder === undefined) { break; }
      let cursor: string | undefined;
      do {
        const page = await router.list(folder, cursor);
        for (const stat of page.items) {
          seen += 1;
          if (stat.type === 'folder') { folders.push(stat.uri); continue; }
          if ((await store.table('resources').get(stat.uri))?.indexedVersion === stat.version) { continue; }
          try {
            if (await this.resource(stat.uri) !== undefined) { indexed += 1; }
          } catch (error) {
            log.warn('index.crawl.skipped', { uri: stat.uri, error: messageOf(error) });
          }
        }
        cursor = page.cursor;
      } while (cursor !== undefined && seen < maxCrawl);
    }
    log.info('index.crawled', { root, seen, indexed, capped: seen >= maxCrawl });
    return indexed;
  }

  /** A changed resource: re-section it when its root indexes everything, or it was indexed before (on read). */
  async #follow(uri: ResourceUri): Promise<void> {
    const route = this.#route(uri);
    if (route === undefined || route.index === 'none') { return; }
    if (route.index === 'on-read' && (await this.#options.store.table('resources').get(uri)) === undefined) { return; }
    await this.resource(uri);
  }

  /**
   * Whether a system's resource may be indexed (build 7): not while its system is installed and not yet live, nor
   * under a root an admin switched off (`itemSwitches` rows of section `roots`, named by the root's URI).
   */
  async #offered(system: SystemName, uri: ResourceUri): Promise<boolean> {
    const { store } = this.#options;
    if ((await store.table('systems').get(system))?.stage === 'installed') { return false; }
    const off = await allRows(store.table('itemSwitches'), { where: { system, section: 'roots' } });
    return !off.some((row) => underRoot(uri, row.name));
  }

  /** A removed resource: drop its sections and their index entries. */
  async #drop(uri: ResourceUri): Promise<void> {
    const { store } = this.#options;
    const record = await store.table('resources').get(uri);
    if (record === undefined) { return; }
    const rows = record.indexedVersion === undefined ? [] : await allRows(store.table('sections'), { where: { uri, version: record.indexedVersion } });
    for (const row of rows) { await store.table('sections').remove(row); }
    await this.remove('section', rows.map((r) => sectionIndexKey(uri, r.key)));
    await this.remove('image', [uri]);
    await store.table('resources').remove(uri);
  }

  #queue(key: string, task: () => Promise<unknown>): void {
    this.#serial.run(task).catch((error: unknown) => { this.#options.log.warn(`${key}.failed`, { error: messageOf(error) }); });
  }
}
