/**
 * Image embeddings in the index: a second vector space for pictures with its own embedder, one space when the text
 * embedder shares it with images, nothing at all for a text-only setup, and moving the pictures when the space
 * changes. Runs the real indexer, search and store; the embedders are fakes whose vectors follow the words in a text,
 * in an image's URL, or in an image's bytes.
 */
import {
  ActorId, ContextDecl, IMAGE_EMBEDDING_DEFAULT, QualifiedName, ResourceUri, SystemName, resolveImageSpace, type EmbedderAbilities, type EmbedInput, type ImageEmbedding,
  type ResourceStat,
} from '@harness/core';
import { provider, system } from '@harness/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openScope } from '../access/index.ts';
import { seesHit } from '../access/hits.ts';
import { FixtureCatalog } from '../chat/testing.ts';
import { manifestFor, vectors as vectorsContract } from '../catalog/fixtures.ts';
import { FakeSystem, linkRig, pairDirectly } from '../link/rig.ts';
import { StoreModelCallLog } from '../metrics/calls.ts';
import { OfferedProviders, offeredBy } from '../models/remote.ts';
import { SystemEmbedders } from './embedders.ts';
import { HybridSearch } from '../store/hybrid.ts';
import { RecordingBus, memoryLog, settle, testStore } from '../testing.ts';
import { EmbedBatcher } from './batch.ts';
import { ImageEmbeddingSettings } from './image-setting.ts';
import { contextImageItems, contextImageKey, isPicture } from './images.ts';
import type { Embedder, Embedders, ImageSpace, IndexItem, IndexReader } from './index.ts';
import { StoreIndexer, imageVectorHash } from './indexer.ts';
import { IndexSearch } from './search.ts';
import { Sectioning } from './sectioning.ts';
import type { ResourceRouter } from '../link/index.ts';

const q = (name: string) => QualifiedName.parse(name);
const DOCUMENT = q('vectors/document');
const QUERY = q('vectors/query');
const CLIP = q('pics/clip');
const SHOP = SystemName.parse('shop');

/** A system whose provider has one model that embeds pictures and text in one 4-number space. */
const picsContract = system('pics', { description: 'Pictures.' }).with({
  providers: {
    local: provider({
      description: 'A picture model.',
      models: [{ id: 'clip', capabilities: ['embedding', 'imageEmbedding', 'crossModalEmbedding'], contextWindow: 64, dimensions: 4, pricing: { input: 0, output: 0 }, caching: false }],
    }),
  },
});

/** The words a vector counts: cars, cats, and a constant; an own space has one more dimension, so its table is its own. */
function vectorOf(text: string, dimensions: number): number[] {
  const words = text.toLowerCase().split(/\W+/);
  const count = (...of: string[]) => words.filter((w) => of.includes(w)).length;
  return [count('car', 'cars'), count('cat', 'cats'), 0.1, ...Array<number>(dimensions - 3).fill(0)];
}

/** What a picture shows: its URL's words, or its bytes read as text (a data URL). */
function pictureWords(input: Exclude<EmbedInput, string>): string {
  return input.image.startsWith('data:') ? Buffer.from(input.image.slice(input.image.indexOf(',') + 1), 'base64').toString() : input.image;
}

class FakeEmbedder implements Embedder {
  readonly maxInput = 1_000;
  readonly inputs: EmbedInput[] = [];
  readonly name: QualifiedName;
  readonly dimensions: number;
  readonly abilities: EmbedderAbilities;
  constructor(name: QualifiedName, dimensions: number, abilities: EmbedderAbilities) { this.name = name; this.dimensions = dimensions; this.abilities = abilities; }
  embed(inputs: readonly EmbedInput[]): Promise<number[][]> {
    this.inputs.push(...inputs);
    return Promise.resolve(inputs.map((input) => vectorOf(typeof input === 'string' ? input : pictureWords(input), this.dimensions)));
  }
}

const TEXT_ONLY = { text: true, images: false, crossModal: false };
const BOTH = { text: true, images: true, crossModal: true };

class FakeEmbedders implements Embedders {
  readonly #listeners = new Set<() => void>();
  document: FakeEmbedder = new FakeEmbedder(DOCUMENT, 3, TEXT_ONLY);
  query: FakeEmbedder = new FakeEmbedder(QUERY, 3, TEXT_ONLY);
  clip: FakeEmbedder = new FakeEmbedder(CLIP, 4, BOTH);
  space: ImageSpace | undefined;
  get(name: QualifiedName): Embedder | undefined { return [this.document, this.query, this.clip].find((e) => e.name === name); }
  active(): { document: Embedder; query: Embedder } { return { document: this.document, query: this.query }; }
  images(): ImageSpace | undefined { return this.space; }
  onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => void this.#listeners.delete(listener); }
  /** Use an image space (none: no images) and tell the listeners. */
  use(space: ImageSpace | undefined): void { this.space = space; for (const listener of this.#listeners) { listener(); } }
  /** The text embedder shares its space with images (one space). */
  shared(): ImageSpace {
    this.document = new FakeEmbedder(DOCUMENT, 3, BOTH);
    this.query = new FakeEmbedder(QUERY, 3, BOTH);
    return { embedder: this.document, shared: true, crossModal: true };
  }
  /** A second space with its own embedder. */
  own(crossModal = true): ImageSpace {
    this.clip = new FakeEmbedder(CLIP, 4, { text: crossModal, images: true, crossModal });
    return { embedder: this.clip, shared: false, crossModal };
  }
}

/** Serves nothing: the tests index items and read pictures through the reader. */
const NO_RESOURCES: ResourceRouter = {
  roots: () => [], route: () => undefined, refresh: () => Promise.resolve(), stat: () => Promise.resolve(undefined), list: () => Promise.resolve({ items: [] }), changed: () => undefined,
  read: (uri) => Promise.reject(new Error(`no resource ${uri}`)), text: (uri) => Promise.reject(new Error(`no resource ${uri}`)),
  sections: (_sectioner, uri) => Promise.reject(new Error(`no resource ${uri}`)),
};

const CAR = ResourceUri.parse('hub://resources/pics/car.png');
const carStat = (version = 'v1'): ResourceStat => ({ uri: CAR, name: 'car.png', type: 'file', mime: 'image/png', format: 'image', version });

/** A context item whose text shows two pictures and links a page. */
const ALBUM: IndexItem = {
  kind: 'context', key: 'shop/album', system: SHOP,
  text: 'shop/album: Our pictures\n![a red car](https://pics.test/red-car.png)\n![the cat](https://pics.test/cat.jpg)\n[about us](https://shop.test/about)',
};

async function setup() {
  const store = await testStore();
  const { log, records } = memoryLog();
  const catalog = new FixtureCatalog();
  const embedders = new FakeEmbedders();
  const batcher = new EmbedBatcher({ embedders, log, size: 8, wait: 1, poll: 2, concurrency: { interactive: 2, background: 1 } });
  const indexer = new StoreIndexer({
    store, bus: new RecordingBus(), log, clock: () => 5, catalog, embedders, batcher, router: NO_RESOURCES, sectioning: new Sectioning({ store, catalog, router: NO_RESOURCES }),
    document: DOCUMENT, maxText: 500, maxCrawl: 10, chunk: 4, retry: { first: 20, most: 80 }, maxPicture: 1_000,
  });
  const pictures = new Map<string, string>([[CAR, 'a car parked']]);
  const reader: IndexReader = {
    route: (uri) => (uri.startsWith('hub://') ? { system: SHOP, index: 'all' } : undefined),
    primary: (uri) => Promise.resolve({ stat: uri === CAR ? carStat() : { uri, name: 'x', type: 'file', version: '1' }, links: [], text: '' }),
    sectioned: () => Promise.resolve(),
    picture: (uri) => {
      const words = pictures.get(uri);
      return Promise.resolve(words === undefined ? undefined : { bytes: new TextEncoder().encode(words), mime: 'image/png' });
    },
  };
  indexer.readWith(reader);
  const hybrid = new HybridSearch({ vectors: store.vectors, text: store.text }, { HARNESS_SEARCH_RRF_K: 60, HARNESS_SEARCH_DEPTH: 4 });
  const search = new IndexSearch({ store, hybrid, embedders, batcher, log, document: DOCUMENT, overfetch: 3, embedWait: 1_000 });
  return { store, log, records, embedders, batcher, indexer, search, pictures };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); });
afterEach(async () => { await ctx.batcher.stop(); await ctx.store.close(); });

/** The kinds and keys of the items nearest a vector in one table. */
async function nearest(table: QualifiedName, vector: number[]): Promise<string[]> {
  return (await ctx.store.vectors.nearest(table, vector, 10, { kinds: ['image'] })).map((hit) => hit.key);
}

describe('the pictures the index embeds', () => {
  it('finds a context item\'s http(s) image links (not its other links), keyed under the item', () => {
    const items = contextImageItems(ALBUM);
    expect(items).toEqual([
      { kind: 'image', key: contextImageKey('shop/album', 'https://pics.test/red-car.png'), parent: 'shop/album', text: 'shop/album: a red car', image: { source: 'https://pics.test/red-car.png' }, system: SHOP },
      { kind: 'image', key: contextImageKey('shop/album', 'https://pics.test/cat.jpg'), parent: 'shop/album', text: 'shop/album: the cat', image: { source: 'https://pics.test/cat.jpg' }, system: SHOP },
    ]);
    expect(contextImageItems({ ...ALBUM, kind: 'fn' })).toEqual([]);
  });

  it('takes images but not text drawn as one', () => {
    expect(isPicture({ format: 'image', mime: 'image/png' })).toBe(true);
    expect(isPicture({ format: undefined, mime: 'image/jpeg' })).toBe(true);
    expect(isPicture({ format: 'mermaid', mime: 'text/plain' })).toBe(false);
    expect(isPicture({ format: 'markdown', mime: 'text/markdown' })).toBe(false);
  });
});

describe('a text-only setup', () => {
  it('indexes and searches as before: no pictures, no image vectors', async () => {
    const { indexer, store, search, embedders } = ctx;
    await indexer.upsert([ALBUM]);
    expect(await store.table('index').find({ where: { kind: 'image' }, limit: 10 })).toMatchObject({ items: [] });
    expect(embedders.document.inputs.every((input) => typeof input === 'string')).toBe(true);
    expect(await nearest(DOCUMENT, [1, 0, 0.1])).toEqual([]);
    const hits = await search.search({ text: 'pictures', kinds: ['context', 'image'], limit: 5 });
    expect(hits.map((hit) => hit.key)).toEqual(['shop/album']);
    // a picture query finds nothing by meaning without an image space
    expect(await search.search({ text: '', kinds: ['context', 'image'], limit: 5, image: { image: 'https://q.test/car.png' } })).toEqual([]);
  });
});

describe('a second image space', () => {
  it('embeds pictures with its own model into its own table, and searches it by picture or by text', async () => {
    const { indexer, store, search, embedders } = ctx;
    embedders.use(embedders.own());
    await indexer.upsert([ALBUM]);
    const rows = (await store.table('index').find({ where: { kind: 'image' }, limit: 10 })).items;
    expect(rows).toHaveLength(2);
    for (const row of rows) { expect(row.vectorHash).toBe(imageVectorHash(row.hash, CLIP)); }
    // pictures go to the image model as pictures (URLs), the text to the text model
    expect(embedders.clip.inputs).toEqual([{ image: 'https://pics.test/red-car.png' }, { image: 'https://pics.test/cat.jpg' }]);
    expect(embedders.document.inputs.every((input) => typeof input === 'string')).toBe(true);
    // the vectors are in the image space's table, none in the text space's
    const car = contextImageKey('shop/album', 'https://pics.test/red-car.png');
    expect((await nearest(CLIP, [1, 0, 0.1, 0]))[0]).toBe(car);
    expect(await nearest(DOCUMENT, [1, 0, 0.1])).toEqual([]);

    // by a picture
    const byPicture = await search.search({ text: '', kinds: ['image'], limit: 5, image: { image: 'https://q.test/my-car.png' } });
    expect(byPicture[0]).toMatchObject({ kind: 'image', key: car, parent: 'shop/album', matched: 'meaning' });
    // by text, the image model embedding the query beside the pictures (it shares its space with text)
    const byText = await search.search({ text: 'cats', kinds: ['context', 'image'], limit: 5 });
    expect(byText.find((hit) => hit.kind === 'image')).toMatchObject({ key: contextImageKey('shop/album', 'https://pics.test/cat.jpg') });
    expect(embedders.clip.inputs).toContain('cats');
  });

  it('finds pictures by their captions alone when the image model doesn\'t read text', async () => {
    const { indexer, search, embedders } = ctx;
    embedders.use(embedders.own(false));
    await indexer.upsert([ALBUM]);
    const hits = await search.search({ text: 'cat', kinds: ['image'], limit: 5 });
    expect(hits.map((hit) => [hit.key, hit.matched])).toEqual([[contextImageKey('shop/album', 'https://pics.test/cat.jpg'), 'words']]);
    expect(embedders.clip.inputs.every((input) => typeof input !== 'string')).toBe(true);
  });

  it('embeds an image resource from its bytes, as a data URL, and drops it with the resource', async () => {
    const { indexer, store, embedders, search } = ctx;
    embedders.use(embedders.own());
    await store.table('resources').put({ uri: CAR, system: SHOP, stat: carStat(), links: [], seenAt: 1 });
    await indexer.resource(CAR);
    expect(embedders.clip.inputs).toEqual([{ image: `data:image/png;base64,${Buffer.from('a car parked').toString('base64')}`, mimeType: 'image/png' }]);
    expect(await nearest(CLIP, [1, 0, 0.1, 0])).toEqual([CAR]);
    expect((await search.search({ text: '', kinds: ['image'], limit: 5, image: { image: 'https://q.test/car.png' } }))[0]?.key).toBe(CAR);
    await indexer.remove('image', [CAR]);
    expect(await nearest(CLIP, [1, 0, 0.1, 0])).toEqual([]);
  });

  it('leaves out a picture over the size cap, with a warning, and keeps its caption', async () => {
    const { indexer, store, embedders, pictures, records } = ctx;
    embedders.use(embedders.own());
    pictures.set(CAR, 'car '.repeat(400));
    await store.table('resources').put({ uri: CAR, system: SHOP, stat: carStat(), links: [], seenAt: 1 });
    await indexer.resource(CAR);
    expect(embedders.clip.inputs).toEqual([]);
    expect(await store.table('index').get({ embedder: DOCUMENT, kind: 'image', key: CAR })).toMatchObject({ text: 'car.png' });
    expect(records.some((record) => record.msg === 'index.embed.picture-too-large')).toBe(true);
  });
});

describe('a model that shares its space with text', () => {
  it('uses one space: pictures beside the text, found by text and by picture together', async () => {
    const { indexer, store, search, embedders } = ctx;
    embedders.use(embedders.shared());
    await indexer.upsert([ALBUM]);
    const car = contextImageKey('shop/album', 'https://pics.test/red-car.png');
    expect((await nearest(DOCUMENT, [1, 0, 0.1]))[0]).toBe(car);
    // no second table was made
    expect(await nearest(CLIP, [1, 0, 0.1, 0])).toEqual([]);
    const row = await store.table('index').get({ embedder: DOCUMENT, kind: 'image', key: car });
    expect(row?.vectorHash).toBe(imageVectorHash(row?.hash ?? '', DOCUMENT));
    const byText = await search.search({ text: 'red car', kinds: ['context', 'image'], limit: 5 });
    expect(byText[0]).toMatchObject({ kind: 'image', key: car });
    const byPicture = await search.search({ text: '', kinds: ['context', 'image'], limit: 5, image: { image: 'https://q.test/car.png' } });
    expect(byPicture[0]).toMatchObject({ kind: 'image', key: car, matched: 'meaning' });
  });
});

describe('a change of image space', () => {
  it('catches up the pictures indexed before, and moves them from one space to another', async () => {
    const { indexer, store, embedders } = ctx;
    const stop = indexer.start();
    try {
      await store.table('resources').put({ uri: CAR, system: SHOP, stat: carStat(), links: [], indexedVersion: 'v1', seenAt: 1 });
      await store.table('context').put({
        name: q('shop/album'), system: SHOP, origin: { type: 'memory', scope: { to: 'everyone' }, author: ActorId.parse('act_admin') }, stale: false, updatedAt: 0, mentions: { context: [], fns: [] },
        tokens: { full: 2, summary: 1 },
        decl: ContextDecl.parse({
          name: 'album', description: 'Our pictures', imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: [],
          content: '![a red car](https://pics.test/red-car.png)',
        }),
      });
      await indexer.upsert([ALBUM]);
      await indexer.idle();
      expect(await nearest(CLIP, [1, 0, 0.1, 0])).toEqual([]);

      // a second space: the album's pictures and the image resource indexed before are caught up there
      embedders.use(embedders.own());
      await indexer.idle();
      await settle(20);
      await indexer.idle();
      expect((await nearest(CLIP, [1, 0, 0.1, 0])).sort()).toEqual([CAR, contextImageKey('shop/album', 'https://pics.test/red-car.png')].sort());

      // the text space takes them: the second space is emptied and they are embedded again in one space
      embedders.use(embedders.shared());
      await indexer.idle();
      await settle(20);
      await indexer.idle();
      expect(await nearest(CLIP, [1, 0, 0.1, 0])).toEqual([]);
      expect((await nearest(DOCUMENT, [1, 0, 0.1])).slice(0, 2).sort()).toEqual([CAR, contextImageKey('shop/album', 'https://pics.test/red-car.png')].sort());
    } finally {
      stop();
    }
  });

  // regression: a second space's system going away dropped its vectors but left the rows marked embedded, so coming back
  // found nothing by a picture ever again
  it('keeps the pictures while the image model is away, and finds them again when it comes back, embedding nothing again', async () => {
    const { indexer, store, search, embedders } = ctx;
    const stop = indexer.start();
    try {
      const space = embedders.own();
      embedders.use(space);
      await indexer.upsert([ALBUM]);
      await indexer.idle();
      const embedded = embedders.clip.inputs.length;
      const car = contextImageKey('shop/album', 'https://pics.test/red-car.png');

      // the picture model's system goes away: pictures are found by their captions alone, their vectors kept
      embedders.use(undefined);
      await indexer.idle();
      expect(await nearest(CLIP, [1, 0, 0.1, 0])).toContain(car);
      const away = await search.search({ text: 'car', kinds: ['image'], limit: 5 });
      expect(away.map((hit) => [hit.key, hit.matched])).toEqual([[car, 'words']]);

      // it comes back: the same space, nothing embedded again, found by a picture
      embedders.use(space);
      await indexer.idle();
      await settle(20);
      await indexer.idle();
      expect(embedders.clip.inputs).toHaveLength(embedded);
      const back = await search.search({ text: '', kinds: ['image'], limit: 5, image: { image: 'https://q.test/my-car.png' } });
      expect(back[0]).toMatchObject({ key: car, matched: 'meaning' });

      // a picture removed while the model is away leaves the second space too
      embedders.use(undefined);
      await indexer.idle();
      await indexer.remove('context', ['shop/album']);
      expect(await nearest(CLIP, [1, 0, 0.1, 0])).toEqual([]);
      expect(await store.table('index').find({ where: { kind: 'image' }, limit: 10 })).toMatchObject({ items: [] });
    } finally {
      stop();
    }
  });

  it('searches pictures by their captions alone with no image space, not by vectors a former one left', async () => {
    const { indexer, search, embedders } = ctx;
    const stop = indexer.start();
    try {
      embedders.use(embedders.shared());
      await indexer.upsert([ALBUM]);
      await indexer.idle();
      embedders.use(undefined);
      await indexer.idle();
      const hits = await search.search({ text: 'red car', kinds: ['context', 'image'], limit: 5 });
      const picture = hits.find((hit) => hit.kind === 'image');
      expect(picture).toMatchObject({ key: contextImageKey('shop/album', 'https://pics.test/red-car.png'), matched: 'words' });
      expect(picture?.similarity).toBeUndefined();
    } finally {
      stop();
    }
  });

  it('drops a context item\'s pictures with it and when its text no longer shows them', async () => {
    const { indexer, store, embedders } = ctx;
    embedders.use(embedders.own());
    await indexer.upsert([ALBUM]);
    await indexer.upsert([{ ...ALBUM, text: 'shop/album: Our pictures\n![the cat](https://pics.test/cat.jpg)' }]);
    expect((await store.table('index').find({ where: { kind: 'image' }, limit: 10 })).items.map((row) => row.key)).toEqual([contextImageKey('shop/album', 'https://pics.test/cat.jpg')]);
    await indexer.remove('context', ['shop/album']);
    expect((await store.table('index').find({ where: { kind: 'image' }, limit: 10 })).items).toEqual([]);
    expect(await nearest(CLIP, [0, 1, 0.1, 0])).toEqual([]);
  });
});

describe('the image space rule', () => {
  const doc = { name: DOCUMENT, ...TEXT_ONLY };
  const clip = { name: CLIP, ...BOTH };
  it('same as text: one space only when the text model shares it with images', () => {
    expect(resolveImageSpace(IMAGE_EMBEDDING_DEFAULT, doc, undefined)).toMatchObject({ space: 'none' });
    expect(resolveImageSpace(IMAGE_EMBEDDING_DEFAULT, { ...doc, ...BOTH }, undefined)).toEqual({ space: 'shared', embedder: DOCUMENT });
    expect(resolveImageSpace({ use: 'text' }, { ...doc, images: true, crossModal: false }, undefined)).toMatchObject({ space: 'none' });
  });
  it('a model: its own second space, or one space when it is the text model', () => {
    expect(resolveImageSpace({ use: 'model', embedder: CLIP }, doc, clip)).toEqual({ space: 'own', embedder: CLIP, crossModal: true });
    expect(resolveImageSpace({ use: 'model', embedder: CLIP }, doc, { ...clip, text: false, crossModal: false })).toEqual({ space: 'own', embedder: CLIP, crossModal: false });
    expect(resolveImageSpace({ use: 'model', embedder: DOCUMENT }, { ...doc, ...BOTH }, { ...doc, ...BOTH })).toEqual({ space: 'shared', embedder: DOCUMENT });
    expect(resolveImageSpace({ use: 'model', embedder: CLIP }, doc, undefined)).toMatchObject({ space: 'none', reason: `${CLIP} is not connected.` });
    expect(resolveImageSpace({ use: 'model', embedder: QUERY }, doc, { name: QUERY, ...TEXT_ONLY })).toMatchObject({ space: 'none' });
    expect(resolveImageSpace({ use: 'off' }, { ...doc, ...BOTH }, undefined)).toMatchObject({ space: 'none' });
  });
});

describe('the image embedding setting', () => {
  it('stores the choice, works the embedders out again, and shows the space in use', async () => {
    const { store } = ctx;
    let refreshed = 0;
    const state = { space: 'own' as const, embedder: CLIP, crossModal: true };
    const settings = new ImageEmbeddingSettings({
      store, clock: () => 9, document: DOCUMENT,
      embedders: () => ({ refresh: () => { refreshed += 1; return Promise.resolve(); }, imageState: () => state, imageOptions: () => [{ embedder: CLIP, name: 'clip', dimensions: 4, ...BOTH }] }),
    });
    expect(await settings.value()).toEqual(IMAGE_EMBEDDING_DEFAULT);
    expect((await settings.view()).setBy).toBeUndefined();
    const admin = ActorId.parse('act_admin');
    const view = await settings.set({ use: 'model', embedder: CLIP }, admin);
    expect(refreshed).toBe(1);
    expect(view).toEqual({
      value: { use: 'model', embedder: CLIP }, setBy: admin, updatedAt: 9, text: DOCUMENT, options: [{ embedder: CLIP, name: 'clip', dimensions: 4, ...BOTH }], state,
    });
    expect(await settings.value()).toEqual({ use: 'model', embedder: CLIP });
  });
});

describe('embedders that embed pictures, from systems', () => {
  it('works out the image space from the setting and the providers offered, and embeds pictures over the link', async () => {
    const rig = await linkRig();
    const calls = new StoreModelCallLog({ store: rig.store, clock: () => rig.time.now, log: rig.log });
    let setting: ImageEmbedding = IMAGE_EMBEDDING_DEFAULT;
    const offered = new OfferedProviders({ link: rig.links, catalog: rig.catalog, bus: rig.bus, log: rig.log, offered: offeredBy(rig.lifecycle) });
    const embedders = new SystemEmbedders({
      offered, connections: rig.links, bus: rig.bus, log: rig.log, clock: () => rig.time.now, document: DOCUMENT, query: QUERY, batch: 2, calls: () => calls,
      imageSetting: () => Promise.resolve(setting),
    });
    const text = new FakeSystem(rig.app, 'vectors', await manifestFor(vectorsContract));
    const pics = new FakeSystem(rig.app, 'pics', await manifestFor(picsContract));
    const seen: string[][] = [];
    pics.behaviour.embed = (inputs) => { seen.push(inputs); return inputs.map(() => [1, 0, 0, 0]); };
    for (const system of [text, pics]) { await pairDirectly(rig, system); await system.start(); }
    await embedders.refresh();
    // same as text, with a text-only text model: no image space, as before
    expect(embedders.images()).toBeUndefined();
    expect(embedders.imageState()).toMatchObject({ space: 'none' });
    expect(embedders.imageOptions()).toEqual([{ embedder: CLIP, name: 'clip', dimensions: 4, text: true, images: true, crossModal: true }]);
    // a model of their own: a second space
    setting = { use: 'model', embedder: CLIP };
    await embedders.refresh();
    expect(embedders.images()).toMatchObject({ shared: false, crossModal: true, embedder: { name: CLIP, dimensions: 4 } });
    expect(await embedders.images()?.embedder.embed(['a car', { image: 'https://pics.test/car.png' }])).toEqual([[1, 0, 0, 0], [1, 0, 0, 0]]);
    expect(seen).toEqual([['a car', 'https://pics.test/car.png']]);
    expect((await calls.list({})).items.filter((c) => c.modality === 'embed')).toMatchObject([
      { provider: 'pics/local', model: 'clip', status: 'done', units: { modality: 'embed', texts: 1, characters: 5, images: 1, dimensions: 4 } },
    ]);
    // off: none again
    setting = { use: 'off' };
    await embedders.refresh();
    expect(embedders.images()).toBeUndefined();
    await rig.stop();
  });
});

describe('who sees a picture', () => {
  it('sees an image resource as its URI, and a context item\'s picture with the item', async () => {
    const hidden = ResourceUri.parse('hub://resources/pics/secret.png');
    const scope = { ...openScope(ActorId.parse('act_member')), seesUri: (uri: string) => uri !== hidden, seesContext: (item: { name: string }) => item.name !== 'shop/secret' };
    const lookups = { context: () => Promise.resolve(undefined), type: () => Promise.resolve(undefined) };
    expect(await seesHit(scope, lookups, { kind: 'image', key: CAR })).toBe(true);
    expect(await seesHit(scope, lookups, { kind: 'image', key: hidden })).toBe(false);
    // a context item's picture is seen as the item is
    expect(await seesHit(scope, lookups, { kind: 'image', key: contextImageKey('shop/album', 'https://pics.test/cat.jpg'), parent: 'shop/album' })).toBe(true);
    expect(await seesHit(scope, lookups, { kind: 'image', key: contextImageKey('shop/secret', 'https://pics.test/cat.jpg'), parent: 'shop/secret' })).toBe(false);
  });
});
