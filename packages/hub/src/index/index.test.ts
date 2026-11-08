import {
  ActorId, MAIN_INSTANCE, QualifiedName, ResourceUri, SectionKey, SectionRuleId, SessionId, SystemName,
  type Page, type ReadWant, type ResourceChange, type ResourceLink, type ResourceRead, type ResourceRoot, type ResourceStat, type Section, type SectionDiff, type Session,
} from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreCatalog } from '../catalog/catalog.ts';
import { manifestFor, shop, systemRow, vectors as vectorsContract } from '../catalog/fixtures.ts';
import { RecordingBus, testStore, memoryLog, settle } from '../testing.ts';
import type { ResourceRouter } from '../link/index.ts';
import { FakeSystem, linkRig, pairDirectly } from '../link/rig.ts';
import { HybridSearch } from '../store/hybrid.ts';
import { EmbedBatcher } from './batch.ts';
import { IndexEmbedding } from './embedding.ts';
import { StoreModelCallLog } from '../metrics/calls.ts';
import { SystemEmbedders } from './embedders.ts';
import type { Embedder, Embedders } from './index.ts';
import { StoreIndexer, sectionIndexKey } from './indexer.ts';
import { IndexSearch } from './search.ts';
import { Sectioning } from './sectioning.ts';
import { IndexSuggester } from './suggester.ts';

const q = (name: string) => QualifiedName.parse(name);
const DOCUMENT = q('vectors/document');
const QUERY = q('vectors/query');

/** Three dimensions: how much a text is about products, about cars, and a constant. */
function wordVector(text: string): number[] {
  const words = text.toLowerCase().split(/\W+/);
  const count = (...of: string[]) => words.filter((w) => of.includes(w)).length;
  return [count('product', 'products', 'sku', 'shop'), count('car', 'cars', 'engine'), 0.1];
}

class WordEmbedder implements Embedder {
  readonly maxInput = 1_000;
  calls = 0;
  failing = false;
  /** Never answer (an embedder busy with something else). */
  stuck = false;
  /** Fail only this call (counting from 1). */
  failOn: number | undefined;
  readonly name: QualifiedName;
  readonly dimensions: number;
  constructor(name: QualifiedName, dimensions = 3) { this.name = name; this.dimensions = dimensions; }
  embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += 1;
    const sized = (text: string): number[] => [...wordVector(text), ...Array<number>(this.dimensions - 3).fill(0)];
    if (this.stuck) { return new Promise(() => undefined); }
    return this.failing || this.calls === this.failOn ? Promise.reject(new Error('embedder down')) : Promise.resolve(texts.map(sized));
  }
}

class FakeEmbedders implements Embedders {
  readonly #map = new Map<string, Embedder>();
  readonly #listeners = new Set<() => void>();
  document = new WordEmbedder(DOCUMENT);
  query = new WordEmbedder(QUERY);
  get(name: QualifiedName): Embedder | undefined { return this.#map.get(name); }
  active(): { document: Embedder; query: Embedder } | undefined {
    const document = this.#map.get(DOCUMENT);
    const query = this.#map.get(QUERY);
    return document === undefined || query === undefined ? undefined : { document, query };
  }
  onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => void this.#listeners.delete(listener); }
  connect(): void { this.#map.set(DOCUMENT, this.document); this.#map.set(QUERY, this.query); for (const l of this.#listeners) { l(); } }
}

/** A router over one in-memory folder served by `shop`. */
class FakeRouter implements ResourceRouter {
  readonly files = new Map<string, { text: string; version: string; format?: string }>();
  readonly root: ResourceRoot = { uri: ResourceUri.parse('file:///docs'), name: 'docs', description: 'd', index: 'all', ignore: [], watch: true };
  sectionCalls = 0;
  roots() { return [{ system: SystemName.parse('shop'), instance: MAIN_INSTANCE, root: this.root }]; }
  route(uri: ResourceUri) { return uri.startsWith(`${this.root.uri}/`) ? { system: SystemName.parse('shop'), instance: MAIN_INSTANCE, root: this.root } : undefined; }
  refresh(): Promise<void> { return Promise.resolve(); }
  #stat(uri: ResourceUri): ResourceStat {
    const file = this.files.get(uri);
    if (file === undefined) { throw new Error(`no ${uri}`); }
    return { uri, name: uri.split('/').at(-1) ?? uri, type: 'file', version: file.version, ...(file.format === undefined ? {} : { format: file.format }) };
  }
  read(uri: ResourceUri, _want: readonly ReadWant[]): Promise<ResourceRead> { return Promise.resolve({ stat: this.#stat(uri), text: { inline: this.files.get(uri)?.text ?? '' } }); }
  text(uri: ResourceUri): Promise<{ stat: ResourceStat; text: string; links: ResourceLink[] }> {
    return Promise.resolve({ stat: this.#stat(uri), text: this.files.get(uri)?.text ?? '', links: [{ raw: './b.md', kind: 'link' }] });
  }
  stat(uri: ResourceUri): Promise<ResourceStat | undefined> { return Promise.resolve(this.#stat(uri)); }
  /** One level of a folder: its files, and its subfolders as folder entries. */
  list(folder: ResourceUri): Promise<Page<ResourceStat>> {
    const items = new Map<string, ResourceStat>();
    for (const uri of this.files.keys()) {
      if (!uri.startsWith(`${folder}/`)) { continue; }
      const [first = '', ...rest] = uri.slice(folder.length + 1).split('/');
      const child = ResourceUri.parse(`${folder}/${first}`);
      items.set(child, rest.length === 0 ? this.#stat(child) : { uri: child, name: first, type: 'folder', version: '0' });
    }
    return Promise.resolve({ items: [...items.values()] });
  }
  sections(_sectioner: QualifiedName, uri: ResourceUri, version: string): Promise<Section[]> {
    this.sectionCalls += 1;
    const text = this.files.get(uri)?.text ?? '';
    return Promise.resolve(text.split('\n').filter((l) => l !== '').map((line, i) => ({ key: SectionKey.parse(`row ${version} ${i}`), path: [line], title: line, start: 0, end: line.length })));
  }
  changed(): void {}
}

async function setup() {
  const store = await testStore();
  const bus = new RecordingBus();
  const { log, records } = memoryLog();
  const describer = { describe: () => Promise.resolve({ problems: ['no kinds'] }) };
  const catalog = new StoreCatalog({ store, bus, log, clock: () => 5, describer });
  const embedders = new FakeEmbedders();
  const batcher = new EmbedBatcher({ embedders, log, size: 8, wait: 1, poll: 2, concurrency: { interactive: 2, background: 1 } });
  const router = new FakeRouter();
  const sectioning = new Sectioning({ store, catalog, router });
  const indexer = new StoreIndexer({ store, bus, log, clock: () => 5, catalog, embedders, batcher, router, sectioning, document: DOCUMENT, maxText: 500, maxCrawl: 100, chunk: 4, retry: { first: 20, most: 80 } });
  const hybrid = new HybridSearch({ vectors: store.vectors, text: store.text }, { HARNESS_SEARCH_RRF_K: 60, HARNESS_SEARCH_DEPTH: 4 });
  const search = new IndexSearch({ store, hybrid, embedders, batcher, log, document: DOCUMENT, overfetch: 3, embedWait: 200 });
  const suggester = new IndexSuggester({ store, catalog, search });
  return { store, bus, log, records, catalog, embedders, batcher, router, sectioning, indexer, search, suggester };
}

let ctx: Awaited<ReturnType<typeof setup>>;

/** The items with a vector under the document embedder, found with a probe of `dimensions` numbers. */
async function vectorKeys(dimensions = 3): Promise<string[]> {
  const probe = [1, ...Array<number>(dimensions - 1).fill(0)];
  return (await ctx.store.vectors.nearest(DOCUMENT, probe, 100)).map((h) => `${h.kind}:${h.key}`).sort();
}
beforeEach(async () => { ctx = await setup(); });
afterEach(async () => { await ctx.batcher.stop(); });

describe('indexing', () => {
  it('stores text at once and embeds it once an embedder is connected', async () => {
    const { indexer, store, embedders } = ctx;
    await indexer.upsert([{ kind: 'fn', key: 'shop/get', text: 'Get a product by sku', system: SystemName.parse('shop') }]);
    const row = await store.table('index').get({ embedder: DOCUMENT, kind: 'fn', key: 'shop/get' });
    expect(row).toMatchObject({ text: 'Get a product by sku', embedder: DOCUMENT });
    expect(row?.vectorHash).toBeUndefined();
    expect(await vectorKeys()).toEqual([]);

    indexer.start();
    embedders.connect();
    await indexer.idle();
    expect((await store.table('index').get({ embedder: DOCUMENT, kind: 'fn', key: 'shop/get' }))?.vectorHash).toBe(row?.hash);
    expect(await vectorKeys()).toEqual(['fn:shop/get']);
    expect((await store.vectors.nearest(DOCUMENT, [2, 0, 0.1], 1))[0]?.score).toBeCloseTo(1);
  });

  it('sizes vectors by the embedder’s declared dimensions, and embeds everything again when they change', async () => {
    const { indexer, embedders } = ctx;
    indexer.start();
    embedders.connect();
    await indexer.upsert([{ kind: 'fn', key: 'shop/get', text: 'Get a product' }, { kind: 'fn', key: 'shop/list', text: 'List products' }]);
    await indexer.idle();
    expect(await vectorKeys(3)).toEqual(['fn:shop/get', 'fn:shop/list']);
    // the embedder system now declares 4 dimensions
    embedders.document = new WordEmbedder(DOCUMENT, 4);
    embedders.query = new WordEmbedder(QUERY, 4);
    embedders.connect();
    await indexer.idle();
    await indexer.idle();
    expect(await vectorKeys(4)).toEqual(['fn:shop/get', 'fn:shop/list']);
    await expect(vectorKeys(3)).rejects.toMatchObject({ code: 'bad-vector' });
    expect(ctx.records.some((r) => r.msg === 'index.vectors.resized')).toBe(true);
  });

  it('leaves unchanged text alone, and removes items everywhere', async () => {
    const { indexer, store, embedders } = ctx;
    embedders.connect();
    const item = { kind: 'context' as const, key: 'shop/guide', text: 'All about the shop' };
    await indexer.upsert([item]);
    await indexer.upsert([item]);
    expect(embedders.document.calls).toBe(1);
    await indexer.remove('context', ['shop/guide']);
    expect(await store.table('index').get({ embedder: DOCUMENT, kind: 'context', key: 'shop/guide' })).toBeUndefined();
    expect(await store.text.search({ text: 'shop', kinds: ['context'], limit: 5 })).toEqual([]);
    expect(await vectorKeys()).toEqual([]);
  });

  it('keeps going on words when embedding fails, and embeds later', async () => {
    const { indexer, embedders, records } = ctx;
    embedders.connect();
    embedders.document.failing = true;
    await indexer.upsert([{ kind: 'fn', key: 'shop/list', text: 'List products' }]);
    expect(records.some((r) => r.msg === 'index.embed.failed')).toBe(true);
    embedders.document.failing = false;
    await indexer.backfill();
    expect(await vectorKeys()).toEqual(['fn:shop/list']);
  });

  it('saves each chunk of a backfill as it is embedded, keeps them when a later chunk fails, and tries again on its own', async () => {
    const { indexer, embedders, records } = ctx;
    const items = Array.from({ length: 10 }, (_, i) => ({ kind: 'fn' as const, key: `shop/fn${i}`, text: `Fn ${i} lists products` }));
    await indexer.upsert(items);
    // the second chunk (of 4) fails once, while the indexer follows the embedders
    embedders.document.failOn = 2;
    const stop = indexer.start();
    embedders.connect();
    await expect.poll(() => records.find((r) => r.msg === 'index.embed.failed')).toMatchObject({ saved: 4, items: 6 });
    // the retry, a short wait later, embeds the rest
    await expect.poll(() => vectorKeys(), { timeout: 2_000 }).toHaveLength(10);
    stop();
  });

  it('gives way to the event loop while it stores thousands of items', async () => {
    const { indexer } = ctx;
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    await indexer.upsert(Array.from({ length: 3_000 }, (_, i) => ({ kind: 'fn' as const, key: `shop/fn${i}`, text: `Fn ${i}` })));
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });

  it('re-indexes what a system contributes when the catalog changes, dropping what is gone', async () => {
    const { indexer, catalog, store } = ctx;
    indexer.start();
    const manifest = await manifestFor(shop);
    await catalog.importManifest(manifest);
    await settle(5);
    await indexer.idle();
    const keys = (await store.table('index').find({ limit: 50 })).items.map((r) => `${r.kind}:${r.key}`).sort();
    expect(keys).toEqual(['context:shop/guide', 'fn:shop/Product.discount', 'fn:shop/get', 'fn:shop/list', 'type:shop/Product']);
    expect((await store.table('index').get({ embedder: DOCUMENT, kind: 'fn', key: 'shop/get' }))?.text).toBe('shop/get: Get a product by its sku.\nTags: read');

    await catalog.importManifest({ ...manifest, fns: manifest.fns.filter((f) => f.name !== 'list') });
    await settle(5);
    await indexer.idle();
    expect(await store.table('index').get({ embedder: DOCUMENT, kind: 'fn', key: 'shop/list' })).toBeUndefined();
  });
});

describe('resources', () => {
  const uri = ResourceUri.parse('file:///docs/guide.md');

  it('sections a resource, and reports what changed by key on a new version', async () => {
    const { indexer, router, store } = ctx;
    router.files.set(uri, { text: '# Intro\nhello\n# Usage\nrun\n', version: 'v1', format: 'markdown' });
    const first = await indexer.resource(uri);
    expect(first).toMatchObject({ from: '', to: 'v1', added: ['Intro', 'Usage'], changed: [], removed: [] });
    expect(await store.table('resources').get(uri)).toMatchObject({ indexedVersion: 'v1', sectioner: 'hub/headings', system: 'shop', links: [{ raw: './b.md' }] });
    expect((await store.table('index').get({ embedder: DOCUMENT, kind: 'section', key: sectionIndexKey(uri, first?.added[0] ?? never()) }))?.text).toBe('guide.md > Intro\n\n# Intro\nhello\n');

    expect(await indexer.resource(uri)).toBeUndefined();
    router.files.set(uri, { text: '# Intro\nhello there\n# Setup\nstep\n', version: 'v2', format: 'markdown' });
    expect(await indexer.resource(uri)).toMatchObject({ from: 'v1', to: 'v2', added: ['Setup'], changed: ['Intro'], removed: ['Usage'] });
    expect((await store.table('sections').find({ limit: 10 })).items.map((s) => `${s.version}:${s.key}`).sort()).toEqual(['v2:Intro', 'v2:Setup']);
    expect(await store.table('index').get({ embedder: DOCUMENT, kind: 'section', key: sectionIndexKey(uri, SectionKey.parse('Usage')) })).toBeUndefined();
  });

  it('uses a user’s rule over the defaults, and a system’s sectioner over its link', async () => {
    const { indexer, router, store, catalog } = ctx;
    await catalog.importManifest(await manifestFor(shop));
    const csv = ResourceUri.parse('file:///docs/rows.csv');
    router.files.set(csv, { text: 'a\nb\n', version: 'v1', format: 'csv' });
    await indexer.resource(csv);
    expect((await store.table('resources').get(csv))?.sectioner).toBe('shop/csv');
    expect(router.sectionCalls).toBe(1);

    router.files.set(uri, { text: 'one\n\ntwo\n', version: 'v1', format: 'markdown' });
    await store.table('sectionRules').put({ id: SectionRuleId.parse('srl_1'), match: { glob: '**/*.md' }, sectioner: q('hub/paragraphs'), setBy: ActorId.parse('act_admin') });
    expect((await indexer.resource(uri))?.added).toEqual(['one', 'two']);
  });

  it('crawls a root that indexes everything when its system offers it, catching up only what changed', async () => {
    const { indexer, router, store, bus } = ctx;
    indexer.start();
    const nested = ResourceUri.parse('file:///docs/deep/notes.md');
    router.files.set(uri, { text: '# A\nx\n', version: 'v1', format: 'markdown' });
    router.files.set(nested, { text: '# B\ny\n', version: 'v1', format: 'markdown' });
    bus.publish('resources.roots', { system: SystemName.parse('shop'), roots: [router.root] });
    await settle(5);
    await indexer.idle();
    expect((await store.table('resources').get(uri))?.indexedVersion).toBe('v1');
    expect((await store.table('resources').get(nested))?.indexedVersion).toBe('v1');

    router.files.set(nested, { text: '# B\nz\n', version: 'v2', format: 'markdown' });
    const sectioned = router.sectionCalls;
    expect(await indexer.crawl(router.root.uri)).toBe(1);
    expect((await store.table('resources').get(nested))?.indexedVersion).toBe('v2');
    expect(router.sectionCalls).toBe(sectioned);

    router.root.index = 'on-read';
    bus.publish('resources.roots', { system: SystemName.parse('shop'), roots: [router.root] });
    router.files.set(uri, { text: '# A\nnew\n', version: 'v3', format: 'markdown' });
    await settle(5);
    await indexer.idle();
    expect((await store.table('resources').get(uri))?.indexedVersion).toBe('v1');
  });

  it('follows changes by its root’s policy, and drops removed resources', async () => {
    const { indexer, router, store, bus } = ctx;
    indexer.start();
    router.files.set(uri, { text: '# A\nx\n', version: 'v1', format: 'markdown' });
    const change = (c: ResourceChange['change']) => { bus.publish('resources.changed', { system: SystemName.parse('shop'), changes: [{ uri, change: c }] }); };
    change('added');
    await settle(5);
    await indexer.idle();
    expect((await store.table('resources').get(uri))?.indexedVersion).toBe('v1');

    change('removed');
    await settle(5);
    await indexer.idle();
    expect(await store.table('resources').get(uri)).toBeUndefined();
    expect(await store.table('sections').count()).toBe(0);

    router.root.index = 'on-read';
    change('changed');
    await settle(5);
    await indexer.idle();
    expect(await store.table('resources').get(uri)).toBeUndefined();
    router.root.index = 'none';
    expect(await indexer.resource(ResourceUri.parse('file:///elsewhere/x.md'))).toBeUndefined();
  });
});

describe('search and suggestions', () => {
  const SESSION = SessionId.parse('ses_1');
  const sessionRow = (systems: Session['systems']): Session => ({
    id: SESSION, title: 't', owner: ActorId.parse('act_admin'), agent: q('hub/chat'), participants: [], systems, tools: [], context: [],
    status: 'idle', transcript: [], createdAt: 1, updatedAt: 1, archived: false,
  });

  async function indexed() {
    const { catalog, indexer, embedders, store } = ctx;
    embedders.connect();
    await catalog.importManifest(await manifestFor(shop));
    await catalog.importManifest(await manifestFor(vectorsContract));
    await store.table('systems').put(systemRow('shop', 'connected'));
    await catalog.refreshAvailability(SystemName.parse('shop'));
    await indexer.reindexSystem(SystemName.parse('shop'));
    await indexer.upsert([{ kind: 'fn', key: 'cars/drive', text: 'Drive a car with its engine', system: SystemName.parse('cars') }]);
  }

  it('finds by meaning and by words, filtered by system', async () => {
    await indexed();
    const hits = await ctx.search.search({ text: 'which products are in stock', kinds: ['fn'], limit: 3 });
    expect(hits[0]?.key).toMatch(/^shop\//);
    const cars = await ctx.search.search({ text: 'engine trouble', kinds: ['fn'], limit: 3, systems: [SystemName.parse('cars')] });
    expect(cars.map((h) => h.key)).toEqual(['cars/drive']);
    expect(await ctx.search.search({ text: 'engine', kinds: ['fn'], limit: 3, systems: [SystemName.parse('nobody')] })).toEqual([]);
  });

  it('searches by words alone while no embedder is connected, or when the query can’t be embedded', async () => {
    const { indexer } = ctx;
    await indexer.upsert([{ kind: 'fn', key: 'shop/get', text: 'Get a product by sku' }]);
    expect((await ctx.search.search({ text: 'product sku', kinds: ['fn'], limit: 5 })).map((h) => h.key)).toEqual(['shop/get']);
    ctx.embedders.connect();
    ctx.embedders.query.failing = true;
    expect((await ctx.search.search({ text: 'product', kinds: ['fn'], limit: 5 })).map((h) => h.key)).toEqual(['shop/get']);
  });

  it('stores words at once and vectors in the background when asked, so a write never waits on the embedder', async () => {
    const { indexer } = ctx;
    ctx.embedders.connect();
    ctx.embedders.document.stuck = true;
    await indexer.upsert([{ kind: 'context', key: 'memory/note', text: 'A product note' }], { vectors: 'background' });
    expect((await ctx.store.text.search({ text: 'product', kinds: ['context'], limit: 5 })).map((h) => h.key)).toEqual(['memory/note']);
    expect(await vectorKeys()).toEqual([]);
  });

  it('searches by words alone when the query’s embedding takes longer than its wait', async () => {
    const { indexer } = ctx;
    await indexer.upsert([{ kind: 'fn', key: 'shop/get', text: 'Get a product by sku' }]);
    ctx.embedders.connect();
    ctx.embedders.query.stuck = true;
    const started = Date.now();
    expect((await ctx.search.search({ text: 'product', kinds: ['fn'], limit: 5 })).map((h) => h.key)).toEqual(['shop/get']);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ctx.records.some((r) => r.msg === 'index.search.embed.slow')).toBe(true);
  });

  it('searches and suggests by words when an embedder connected before anything was embedded or sized', async () => {
    const { catalog, indexer, embedders, store, records } = ctx;
    await catalog.importManifest(await manifestFor(shop));
    await store.table('systems').put(systemRow('shop', 'connected'));
    await catalog.refreshAvailability(SystemName.parse('shop'));
    await indexer.reindexSystem(SystemName.parse('shop'));
    // the embedders are there and the query embeds fine, but no backfill has made the vector table yet
    embedders.connect();
    expect(await vectorKeys()).toEqual([]);
    const hits = await ctx.search.search({ text: 'product sku', kinds: ['fn'], limit: 3 });
    expect(hits.map((h) => h.key)).toContain('shop/get');
    expect(embedders.query.calls).toBe(1);
    await store.table('sessions').put(sessionRow([SystemName.parse('shop')]));
    expect((await ctx.suggester.suggest({ session: SESSION, text: 'get a product by its sku', limit: 4 })).map((s) => s.name)).toContain('shop/get');
    expect(records.some((r) => r.msg === 'index.search.vectors.failed')).toBe(false);
  });

  it('falls back to words when the vectors can’t be searched with the query', async () => {
    await indexed();
    ctx.embedders.query = new WordEmbedder(QUERY, 4);
    ctx.embedders.connect();
    expect((await ctx.search.search({ text: 'engine', kinds: ['fn'], limit: 3 })).map((h) => h.key)).toEqual(['cars/drive']);
    expect(ctx.records.find((r) => r.msg === 'index.search.vectors.failed')).toMatchObject({ embedder: DOCUMENT });
  });

  it('catches up embedders that connected before the indexer started', async () => {
    const { indexer, embedders } = ctx;
    await indexer.upsert([{ kind: 'fn', key: 'shop/get', text: 'Get a product by sku' }]);
    embedders.connect();
    indexer.start();
    await indexer.idle();
    expect(await vectorKeys()).toEqual(['fn:shop/get']);
  });

  it('suggests available fns and context of the session’s systems', async () => {
    await indexed();
    const session = SESSION;
    await ctx.store.table('sessions').put(sessionRow([SystemName.parse('shop')]));
    const suggestions = await ctx.suggester.suggest({ session, text: 'find a product by its sku', limit: 4 });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.name.startsWith('shop/'))).toBe(true);
    expect(suggestions.find((s) => s.name === 'shop/get')).toMatchObject({ kind: 'fn', description: 'Get a product by its sku.' });
    expect((await ctx.suggester.suggest({ session, text: 'engine', limit: 4 })).some((s) => s.name.startsWith('cars/'))).toBe(false);
    expect(await ctx.suggester.suggest({ session: SessionId.parse('ses_none'), text: 'x', limit: 4 })).toEqual([]);
    expect(await ctx.suggester.suggest({ session, text: '  ', limit: 4 })).toEqual([]);

    await ctx.store.table('systems').update(SystemName.parse('shop'), { status: 'disconnected' });
    await ctx.catalog.refreshAvailability(SystemName.parse('shop'));
    expect(await ctx.suggester.suggest({ session, text: 'find a product by its sku', limit: 4 })).toEqual([]);
  });
});

describe('embed lanes', () => {
  it('embeds for a person while background batches are still running or waiting', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class SlowCrawl extends WordEmbedder {
      override async embed(texts: readonly string[]): Promise<number[][]> {
        if (texts.includes('crawl')) { await gate; }
        return super.embed(texts);
      }
    }
    const embedders = new FakeEmbedders();
    embedders.document = new SlowCrawl(DOCUMENT);
    embedders.connect();
    const batcher = new EmbedBatcher({ embedders, log: ctx.log, size: 1, wait: 1, poll: 2, concurrency: { interactive: 1, background: 1 } });
    try {
      const done: string[] = [];
      const crawl = batcher.embed(DOCUMENT, ['crawl'], 'background').then(() => { done.push('crawl'); });
      await settle(10);
      const next = batcher.embed(DOCUMENT, ['next'], 'background').then(() => { done.push('next'); });
      expect(await batcher.embed(DOCUMENT, ['a product'], 'interactive')).toEqual([[1, 0, 0.1]]);
      expect(done).toEqual([]);
      release();
      await Promise.all([crawl, next]);
      expect(done).toEqual(['crawl', 'next']);
    } finally {
      await batcher.stop();
    }
  });
});

describe('embedders from systems', () => {
  it('follows embedder systems as they connect, and embeds for systems that ask', async () => {
    const rig = await linkRig();
    const calls = new StoreModelCallLog({ store: rig.store, clock: () => rig.time.now, log: rig.log });
    const embedders = new SystemEmbedders({ catalog: rig.catalog, links: rig.links, bus: rig.bus, log: rig.log, clock: () => rig.time.now, document: DOCUMENT, query: QUERY, batch: 2, calls: () => calls });
    let changes = 0;
    embedders.onChange(() => { changes += 1; });
    expect(embedders.active()).toBeUndefined();
    const system = new FakeSystem(rig.app, 'vectors', await manifestFor(vectorsContract));
    system.behaviour.embed = (texts) => texts.map((t) => [t.length, 0, 0]);
    await pairDirectly(rig, system);
    await system.start();
    await embedders.refresh();
    expect(embedders.active()?.document.name).toBe(DOCUMENT);
    expect(changes).toBeGreaterThan(0);
    expect(await embedders.get(DOCUMENT)?.embed(['a', 'bb', 'ccc'])).toEqual([[1, 0, 0], [2, 0, 0], [3, 0, 0]]);
    // each embed call is a model call of the index's own work, in two batches but one record
    expect((await calls.list({ modality: 'embed' })).items).toMatchObject([
      { modality: 'embed', provider: 'vectors', model: DOCUMENT.split('/')[1], purpose: 'index', status: 'done', units: { modality: 'embed', texts: 3, characters: 6, dimensions: 3 } },
    ]);

    const batcher = new EmbedBatcher({ embedders, log: rig.log, size: 4, wait: 1, poll: 2, concurrency: { interactive: 1, background: 1 } });
    const answer = new IndexEmbedding({ embedders, batcher, catalog: rig.catalog });
    expect(await answer.embed(['abcd'])).toEqual({ vectors: [[4, 0, 0]], cost: 0 });

    system.behaviour.embed = (texts) => texts.map(() => [1]);
    await expect(embedders.get(DOCUMENT)?.embed(['x'])).rejects.toThrow('returned a vector of 1 numbers, not 3');
    expect((await calls.list({ modality: 'embed', status: 'failed' })).items).toHaveLength(1);

    system.drop();
    await settle(5);
    await embedders.refresh();
    expect(embedders.active()).toBeUndefined();
    await expect(answer.embed(['x'])).rejects.toThrow('no embedder is connected');
    await batcher.stop();
    await rig.stop();
  });
});

function never(): never {
  throw new Error('expected a value');
}

describe('reading through the resources module', () => {
  it('indexes hub resources in their primary form, keeps the record\'s forms, and tells the reader what changed', async () => {
    const { indexer, store } = ctx;
    const uri = ResourceUri.parse('hub://resources/web/site.dev/page');
    const hub = SystemName.parse('hub');
    const page = { text: '# One\nfirst\n# Two\nsecond\n', version: 'h1' };
    const stat = (): ResourceStat => ({ uri, name: 'page', type: 'page', format: 'html', version: page.version });
    const diffs: SectionDiff[] = [];
    const stop = indexer.readWith({
      route: (at) => (at.startsWith('hub://') ? { system: hub, index: 'all' } : undefined),
      primary: () => Promise.resolve({ stat: stat(), links: [], text: page.text, form: 'markdown' }),
      sectioned: (diff) => { diffs.push(diff); return Promise.resolve(); },
    });
    const raw = { hash: 'a'.repeat(64), size: 10, mime: 'text/html' };
    await store.table('resources').put({ uri, system: hub, stat: stat(), links: [], raw, forms: ['markdown'], primary: 'markdown', seenAt: 1 });
    const first = await indexer.resource(uri);
    expect(first?.added).toEqual(['One', 'Two']);
    const record = await store.table('resources').get(uri);
    expect(record).toMatchObject({ raw, forms: ['markdown'], primary: 'markdown', sectioner: 'hub/headings', indexedVersion: 'h1' });
    const rows = await store.table('sections').find({ where: { uri }, limit: 10 });
    expect(rows.items.map((row) => row.form)).toEqual(['markdown', 'markdown']);
    expect(diffs).toEqual([]);
    page.text = '# One\nfirst, changed\n# Two\nsecond\n';
    page.version = 'h2';
    await indexer.resource(uri);
    expect(diffs.map((diff) => [diff.changed, diff.removed])).toEqual([[['One'], []]]);
    stop();
    expect(await indexer.resource(uri)).toBeUndefined();
  });
});
