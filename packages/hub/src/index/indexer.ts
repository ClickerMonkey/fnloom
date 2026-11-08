/**
 * Keeping the index current. Every item (a fn, context, type, section or message) is stored as text under the
 * document embedder's name, kept in the full-text index at once, and embedded when the document embedder is
 * connected; an item whose text hash hasn't changed is left alone. Items stored while no embedder was connected
 * (`vectorHash` behind `hash`) are embedded once one connects. The indexer follows the bus: a catalog change
 * re-indexes the systems it touched; a resource change re-sections that resource, by its root's index policy.
 * Resources are read through the router (their raw text) until the resources module gives an `IndexReader`
 * (`readWith`): then the hub's own resources are indexed too, every resource is cut in its primary form (markdown for
 * a web page, tables for a spreadsheet), and the reader hears each section diff (snapshot context goes stale).
 */
import type { Logger } from '@ayepi/log';
import {
  SystemName, compositeKey, splitName, type ContextDecl, type FnDecl, type IndexEntry, type IndexedKind, type QualifiedName, type ResourceUri, type SectionDiff,
  type SectionKey, type SectionRow, type TypeRecord,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { allRows } from '../catalog/rows.ts';
import { messageOf } from '../catalog/scope.ts';
import { Serial } from '../catalog/serial.ts';
import { sha256Hex } from '../link/keys.ts';
import type { ResourceRouter } from '../link/index.ts';
import type { HubStore } from '../store/index.ts';
import type { EmbedBatcher } from './batch.ts';
import type { Embedders, IndexItem, IndexReader, Indexer, PrimaryText } from './index.ts';
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
}

/** The kinds a system's contract contributes. */
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
  #reader: IndexReader | undefined;

  constructor(options: IndexerOptions) {
    this.#options = options;
  }

  /** Follow the bus and the embedders. Returns the function that stops following. */
  start(): () => void {
    const { bus, embedders, log } = this.#options;
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
      embedders.onChange(() => { if (embedders.active() !== undefined) { this.#queue('index.backfill', () => this.backfill()); } }),
    ];
    // embedders that connected before the indexer started are caught up too
    if (embedders.active() !== undefined) { this.#queue('index.backfill', () => this.backfill()); }
    log.debug('index.started', {});
    return () => { for (const stop of stops) { stop(); } };
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

  async upsert(items: readonly IndexItem[]): Promise<void> {
    const { store, clock, document, maxText } = this.#options;
    const rows: IndexEntry[] = [];
    for (const item of items) {
      const text = item.text.slice(0, maxText);
      const hash = sha256Hex(text);
      const existing = await store.table('index').get({ embedder: document, kind: item.kind, key: item.key });
      if (existing?.hash === hash) { if (existing.vectorHash !== hash) { rows.push(existing); } continue; }
      rows.push(await store.table('index').put({
        kind: item.kind, key: item.key, text, hash, embedder: document, updatedAt: clock(),
        ...(item.system === undefined ? {} : { system: item.system }),
        ...(existing?.vectorHash === undefined ? {} : { vectorHash: existing.vectorHash }),
      }));
    }
    if (rows.length === 0) { return; }
    await store.text.upsert(rows.map((r) => ({ kind: r.kind, key: r.key, text: r.text })));
    await this.#embed(rows.filter((r) => r.vectorHash !== r.hash));
  }

  async remove(kind: IndexedKind, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) { return; }
    const { store, document } = this.#options;
    for (const key of keys) { await store.table('index').remove({ embedder: document, kind, key }); }
    await store.text.remove(kind, keys);
    await store.vectors.remove(document, kind, keys);
  }

  async reindexSystem(system: SystemName): Promise<void> {
    const { store, catalog, document } = this.#options;
    const items: IndexItem[] = [
      ...(await catalog.fns({ system })).map((fn): IndexItem => ({ kind: 'fn', key: fn.name, text: fnText(fn.name, fn.decl), system })),
      ...(await allRows(store.table('context'), { system })).map((c): IndexItem => ({ kind: 'context', key: c.name, text: contextText(c.name, c.decl), system })),
      ...(await allRows(store.table('types'), { system })).map((t): IndexItem => ({ kind: 'type', key: t.name, text: typeText(t), system })),
    ];
    await this.upsert(items);
    const current = new Set(items.map((i) => compositeKey(i.kind, i.key)));
    for (const kind of CONTRACT_KINDS) {
      const stale = (await allRows(store.table('index'), { embedder: document, system, kind })).filter((r) => !current.has(compositeKey(kind, r.key)));
      await this.remove(kind, stale.map((r) => r.key));
    }
  }

  async resource(uri: ResourceUri): Promise<SectionDiff | undefined> {
    const { store, sectioning, clock, log } = this.#options;
    const route = this.#route(uri);
    if (route === undefined) { return undefined; }
    const read = await this.#text(uri);
    const { stat, text, links } = read;
    const record = await store.table('resources').get(uri);
    if (record?.indexedVersion === stat.version) { return undefined; }
    const sectioner = await sectioning.choose(stat, route.system, read.form);
    const sections = await sectioning.cut(sectioner, uri, { text, stat, ...(read.form === undefined ? {} : { form: read.form }), ...(read.version === undefined ? {} : { version: read.version }) });
    const before = record?.indexedVersion === undefined ? [] : await allRows(store.table('sections'), { uri, version: record.indexedVersion });
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
    await this.remove('section', diff.removed.map((key) => sectionIndexKey(uri, key)));
    log.info('index.resource', { uri, sectioner, form: read.form, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length });
    if (record?.indexedVersion !== undefined && (diff.changed.length > 0 || diff.removed.length > 0)) { await this.#reader?.sectioned(diff); }
    return diff;
  }

  /** Embed everything stored while no embedder was connected, or whose vector was dropped when the size changed. */
  async backfill(): Promise<void> {
    const { store, document, embedders } = this.#options;
    const active = embedders.active();
    if (active === undefined) { return; }
    await this.#sized(active.document.dimensions);
    const waiting = (await allRows(store.table('index'), { embedder: document })).filter((r) => r.vectorHash !== r.hash);
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
    for (const row of await allRows(store.table('index'), { embedder: document })) {
      if (row.vectorHash !== undefined) { await store.table('index').put(withoutVector(row)); }
    }
    this.#queue('index.backfill', () => this.backfill());
  }

  /** Embed rows with the document embedder, if it is connected; a failure leaves them for the next backfill. */
  async #embed(rows: readonly IndexEntry[]): Promise<void> {
    const { store, embedders, batcher, document, log } = this.#options;
    const active = embedders.active();
    if (active === undefined || rows.length === 0) { return; }
    try {
      await this.#sized(active.document.dimensions);
      const vectors = await batcher.embed(active.document.name, rows.map((r) => r.text), 'background');
      const entries = rows.map((r, i) => {
        const vector = vectors[i];
        if (vector?.length !== active.document.dimensions) { throw new Error(`${active.document.name} gave no ${active.document.dimensions}-number vector for ${r.kind} ${r.key}`); }
        return { kind: r.kind, key: r.key, vector };
      });
      await store.vectors.upsert(document, entries);
      for (const row of rows) { await store.table('index').update(row, { vectorHash: row.hash }); }
    } catch (error) {
      log.warn('index.embed.failed', { items: rows.length, error: messageOf(error) });
    }
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

  /** A removed resource: drop its sections and their index entries. */
  async #drop(uri: ResourceUri): Promise<void> {
    const { store } = this.#options;
    const record = await store.table('resources').get(uri);
    if (record === undefined) { return; }
    const rows = record.indexedVersion === undefined ? [] : await allRows(store.table('sections'), { uri, version: record.indexedVersion });
    for (const row of rows) { await store.table('sections').remove(row); }
    await this.remove('section', rows.map((r) => sectionIndexKey(uri, r.key)));
    await store.table('resources').remove(uri);
  }

  #queue(key: string, task: () => Promise<unknown>): void {
    this.#serial.run(task).catch((error: unknown) => { this.#options.log.warn(`${key}.failed`, { error: messageOf(error) }); });
  }
}
