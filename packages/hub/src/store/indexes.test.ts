import type { IndexedKind } from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreError } from './errors.ts';
import { memoryLog } from '../testing.ts';
import { TEST_EMBEDDER, openTestStore, tempDir } from './fixtures.ts';
import { HybridSearch, fuseRanks } from './hybrid.ts';
import type { TextIndex, VectorIndex } from './index.ts';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { SqliteStore } from './sqlite.ts';
import { matchExpression } from './text.ts';
import { similarity, vectorTable } from './vectors.ts';

let store: SqliteStore;
beforeEach(async () => {
  store = await openTestStore();
});
afterEach(async () => {
  await store.close();
});

describe('text index', () => {
  beforeEach(async () => {
    await store.text.upsert([
      { kind: 'fn', key: 'fs/read', text: 'Read a text file from a folder' },
      { kind: 'fn', key: 'fs/write', text: 'Write text into a file' },
      { kind: 'fn', key: 'fs/bash', text: 'Run a shell command' },
      { kind: 'context', key: 'fs/guide', text: 'How to work with files here: read before editing' },
      { kind: 'message', key: 'msg_1', text: 'Café crème' },
    ]);
  });

  it('finds items by any word, best match first, within kinds', async () => {
    const hits = await store.text.search({ text: 'read file', kinds: ['fn'], limit: 10 });
    expect(hits.map((h) => h.key)).toEqual(['fs/read', 'fs/write']);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Infinity);
    const both = await store.text.search({ text: 'read', kinds: ['fn', 'context'], limit: 10 });
    expect(both.map((h) => h.kind).sort()).toEqual(['context', 'fn']);
  });

  it('stems words and folds diacritics', async () => {
    expect((await store.text.search({ text: 'reading files', kinds: ['fn'], limit: 1 }))[0]?.key).toBe('fs/read');
    expect((await store.text.search({ text: 'cafe', kinds: ['message'], limit: 1 }))[0]?.key).toBe('msg_1');
  });

  it('replaces an item’s text on upsert, and removes items', async () => {
    await store.text.upsert([{ kind: 'fn', key: 'fs/bash', text: 'Execute programs' }]);
    expect(await store.text.search({ text: 'shell', kinds: ['fn'], limit: 5 })).toEqual([]);
    expect((await store.text.search({ text: 'programs', kinds: ['fn'], limit: 5 })).map((h) => h.key)).toEqual(['fs/bash']);
    await store.text.remove('fn', ['fs/bash', 'missing']);
    expect(await store.text.search({ text: 'programs', kinds: ['fn'], limit: 5 })).toEqual([]);
    // the same key of another kind is untouched
    await store.text.upsert([{ kind: 'type', key: 'fs/read', text: 'Read type' }]);
    await store.text.remove('fn', ['fs/read']);
    expect((await store.text.search({ text: 'read', kinds: ['type', 'fn', 'context'], limit: 5 })).map((h) => `${h.kind}:${h.key}`).sort()).toEqual(['context:fs/guide', 'type:fs/read']);
  });

  it('treats query punctuation as plain text and returns nothing for no words or no kinds', async () => {
    expect(await store.text.search({ text: '"read" OR (NEAR file*', kinds: ['fn'], limit: 5 })).not.toEqual([]);
    expect(await store.text.search({ text: '   ?!', kinds: ['fn'], limit: 5 })).toEqual([]);
    expect(await store.text.search({ text: 'read', kinds: [], limit: 5 })).toEqual([]);
    expect(await store.text.search({ text: 'read', kinds: ['fn'], limit: 0 })).toEqual([]);
    expect(matchExpression('Read, READ file')).toBe('"read" OR "file"');
    await store.text.upsert([]);
    await store.text.remove('fn', []);
  });

  it('rolls back with its transaction', async () => {
    await expect(store.tx(async (tx) => {
      await tx.text.upsert([{ kind: 'fn', key: 'fs/zip', text: 'Compress an archive' }]);
      await tx.text.remove('fn', ['fs/read']);
      expect((await tx.text.search({ text: 'archive', kinds: ['fn'], limit: 5 })).map((h) => h.key)).toEqual(['fs/zip']);
      throw new Error('undo');
    })).rejects.toThrow('undo');
    expect(await store.text.search({ text: 'archive', kinds: ['fn'], limit: 5 })).toEqual([]);
    expect((await store.text.search({ text: 'folder', kinds: ['fn'], limit: 5 })).map((h) => h.key)).toEqual(['fs/read']);
  });
});

describe('vector index', () => {
  const kinds: IndexedKind[] = ['fn', 'context'];

  beforeEach(async () => {
    await store.vectors.upsert(TEST_EMBEDDER, [
      { kind: 'fn', key: 'x', vector: [1, 0, 0] },
      { kind: 'fn', key: 'xy', vector: [1, 1, 0] },
      { kind: 'context', key: 'y', vector: [0, 1, 0] },
      { kind: 'fn', key: 'minus-x', vector: [-1, 0, 0] },
    ]);
  });

  it('finds nearest by cosine similarity, filtered by kind', async () => {
    const hits = await store.vectors.nearest(TEST_EMBEDDER, [1, 0.1, 0], 10, kinds);
    expect(hits.map((h) => h.key)).toEqual(['x', 'xy', 'y', 'minus-x']);
    expect(hits[0]?.score).toBeCloseTo(0.995, 2);
    expect(hits.at(-1)?.score).toBe(0);
    expect((await store.vectors.nearest(TEST_EMBEDDER, [0, 1, 0], 10, ['context'])).map((h) => h.key)).toEqual(['y']);
    expect(await store.vectors.nearest(TEST_EMBEDDER, [0, 1, 0], 2)).toHaveLength(2);
    expect(await store.vectors.nearest(TEST_EMBEDDER, [0, 1, 0], 0)).toEqual([]);
    expect(await store.vectors.nearest(TEST_EMBEDDER, [0, 1, 0], 5, [])).toEqual([]);
  });

  it('keeps to a `within` list that names items with no vector yet', async () => {
    const within = [{ kind: 'fn' as const, key: 'x' }, { kind: 'context' as const, key: 'not-embedded' }, { kind: 'context' as const, key: 'y' }];
    expect((await store.vectors.nearest(TEST_EMBEDDER, [1, 0.1, 0], 10, kinds, within)).map((h) => h.key)).toEqual(['x', 'y']);
    expect(await store.vectors.nearest(TEST_EMBEDDER, [1, 0, 0], 10, kinds, [{ kind: 'fn', key: 'nothing' }])).toEqual([]);
  });

  // regression: sqlite-vec applies an id list after the KNN's k, so items past the k nearest of the whole table vanished
  it('finds the items of a `within` list however far they are from the nearest of the whole table', async () => {
    const far = await store.vectors.nearest(TEST_EMBEDDER, [1, 0.1, 0], 1, kinds, [{ kind: 'context', key: 'y' }, { kind: 'fn', key: 'minus-x' }]);
    expect(far.map((h) => h.key)).toEqual(['y']);
    expect(far[0]?.score).toBeCloseTo(0.1 / Math.hypot(1, 0.1), 5);
    expect((await store.vectors.nearest(TEST_EMBEDDER, [1, 0.1, 0], 2, ['fn'], [{ kind: 'context', key: 'y' }, { kind: 'fn', key: 'minus-x' }])).map((h) => h.key)).toEqual(['minus-x']);
  });

  it('keeps to keys with a prefix inside the search, so other keys never use up the limit', async () => {
    const crowd = Array.from({ length: 30 }, (_, i) => ({ kind: 'fn' as const, key: `x-other-${i}`, vector: [1, 0.01 * (i + 1), 0] }));
    await store.vectors.upsert(TEST_EMBEDDER, [...crowd, { kind: 'fn', key: 'mine-1', vector: [0, 1, 1] }]);
    expect((await store.vectors.nearest(TEST_EMBEDDER, [1, 0, 0], 2, kinds, undefined, 'mine-')).map((h) => h.key)).toEqual(['mine-1']);
    expect((await store.vectors.nearest(TEST_EMBEDDER, [1, 0, 0], 3, kinds, undefined, 'x')).map((h) => h.key)).toEqual(['x', 'x-other-0', 'x-other-1']);
  });

  it('replaces a vector on upsert and removes by kind and key', async () => {
    await store.vectors.upsert(TEST_EMBEDDER, [{ kind: 'fn', key: 'x', vector: [0, 0, 1] }]);
    expect((await store.vectors.nearest(TEST_EMBEDDER, [0, 0, 1], 1))[0]?.key).toBe('x');
    await store.vectors.upsert(TEST_EMBEDDER, [{ kind: 'context', key: 'x', vector: [0, 0, 1] }]);
    await store.vectors.remove(TEST_EMBEDDER, 'fn', ['x', 'xy']);
    const left = await store.vectors.nearest(TEST_EMBEDDER, [0, 0, 1], 10);
    expect(left.map((h) => `${h.kind}:${h.key}`).sort()).toEqual(['context:x', 'context:y', 'fn:minus-x']);
    await store.vectors.remove(TEST_EMBEDDER, 'fn', []);
    await store.vectors.upsert(TEST_EMBEDDER, []);
  });

  it('finds and removes nothing for an embedder with no table, and refuses to store for it or store wrong vectors', async () => {
    const code = (p: Promise<unknown>) => p.then(() => 'no error', (e: unknown) => (e instanceof StoreError ? e.code : 'another error'));
    expect(await store.vectors.nearest('embedder/other', [1, 0, 0], 1)).toEqual([]);
    expect(await code(store.vectors.upsert('embedder/other', [{ kind: 'fn', key: 'a', vector: [1, 0, 0] }]))).toBe('unknown-embedder');
    expect(await code(store.vectors.upsert(TEST_EMBEDDER, [{ kind: 'fn', key: 'a', vector: [1, 0] }]))).toBe('bad-vector');
    expect(await code(store.vectors.upsert(TEST_EMBEDDER, [{ kind: 'fn', key: 'a', vector: [1, Number.NaN, 0] }]))).toBe('bad-vector');
    expect(await code(store.vectors.remove('embedder/other', 'fn', ['a']))).toBe('no error');
    expect(() => SqliteStore.open({ file: ':memory:', dimensions: { a: 0 }, log: memoryLog().log })).not.toThrow();
    const bad = SqliteStore.open({ file: ':memory:', dimensions: { 'e/x': 1.5 }, log: memoryLog().log });
    await expect(bad.migrate()).rejects.toMatchObject({ code: 'bad-vector' });
    await bad.close();
  });

  it('rolls back with its transaction', async () => {
    await store.tx(async (tx) => {
      await tx.vectors.upsert(TEST_EMBEDDER, [{ kind: 'fn', key: 'z', vector: [0, 0, 1] }]);
      expect((await tx.vectors.nearest(TEST_EMBEDDER, [0, 0, 1], 1))[0]?.key).toBe('z');
      await tx.tx(() => Promise.reject(new Error('undo inner'))).catch(() => undefined);
    });
    await expect(store.tx(async (tx) => {
      await tx.vectors.remove(TEST_EMBEDDER, 'fn', ['z']);
      throw new Error('undo');
    })).rejects.toThrow('undo');
    expect((await store.vectors.nearest(TEST_EMBEDDER, [0, 0, 1], 1))[0]?.key).toBe('z');
  });

  it('rebuilds an embedder’s table empty when its dimensions change', async () => {
    const tmp = tempDir();
    try {
      const file = tmp.file('v.sqlite');
      const first = await openTestStore({ file });
      await first.vectors.upsert(TEST_EMBEDDER, [{ kind: 'fn', key: 'a', vector: [1, 2, 3] }]);
      await first.close();
      const same = await openTestStore({ file });
      expect(await same.vectors.nearest(TEST_EMBEDDER, [1, 2, 3], 1)).toHaveLength(1);
      await same.close();
      const { log, records } = memoryLog();
      const wider = SqliteStore.open({ file, dimensions: { [TEST_EMBEDDER]: 4 }, log });
      await wider.migrate();
      expect(records.find((r) => r.msg === 'store.vectors.rebuilt')).toMatchObject({ embedder: TEST_EMBEDDER, from: 3, to: 4 });
      expect(await wider.vectors.nearest(TEST_EMBEDDER, [1, 2, 3, 4], 5)).toEqual([]);
      await wider.close();
    } finally {
      tmp.dispose();
    }
  });

  it('relays a table made with the key as an auxiliary column, keeping its vectors', async () => {
    const tmp = tempDir();
    try {
      const file = tmp.file('relay.sqlite');
      const first = await openTestStore({ file });
      await first.close();
      const raw = new Database(file);
      sqliteVec.load(raw);
      const table = vectorTable(TEST_EMBEDDER);
      raw.exec(`drop table ${table}`);
      raw.exec(`create virtual table ${table} using vec0(id text primary key, embedding float[3] distance_metric=cosine, kind text, +key text)`);
      raw.prepare(`insert into ${table} (id, embedding, kind, key) values (?, ?, 'fn', ?)`).run('fn\u0000kept', new Uint8Array(Float32Array.from([1, 0, 0]).buffer), 'kept');
      raw.close();
      const { log, records } = memoryLog();
      const again = SqliteStore.open({ file, dimensions: { [TEST_EMBEDDER]: 3 }, log });
      await again.migrate();
      expect(records.find((r) => r.msg === 'store.vectors.relaid')).toMatchObject({ table });
      expect((await again.vectors.nearest(TEST_EMBEDDER, [1, 0, 0], 5, ['fn'], undefined, 'ke')).map((h) => h.key)).toEqual(['kept']);
      await again.close();
    } finally {
      tmp.dispose();
    }
  });

  it('remembers tables made by `ensure` when the store opens again', async () => {
    const tmp = tempDir();
    try {
      const file = tmp.file('remember.db');
      const first = SqliteStore.open({ file, log: memoryLog().log });
      await first.migrate();
      await first.vectors.ensure('embedder/later', 2);
      await first.vectors.upsert('embedder/later', [{ kind: 'fn', key: 'a', vector: [1, 0] }]);
      await first.close();
      const again = SqliteStore.open({ file, log: memoryLog().log });
      await again.migrate();
      expect((await again.vectors.nearest('embedder/later', [1, 0], 1)).map((h) => h.key)).toEqual(['a']);
      expect(await again.vectors.ensure('embedder/later', 2)).toBe(false);
      await again.close();
    } finally {
      tmp.dispose();
    }
  });

  it('makes an embedder’s table at its declared size when asked, and remakes it empty when the size changes', async () => {
    const later = 'embedder/later';
    expect(await store.vectors.nearest(later, [1, 0], 1)).toEqual([]);
    expect(await store.vectors.ensure(later, 2)).toBe(false);
    expect(await store.vectors.ensure(later, 2)).toBe(false);
    await store.vectors.upsert(later, [{ kind: 'fn', key: 'a', vector: [1, 0] }]);
    expect((await store.vectors.nearest(later, [1, 0], 1)).map((h) => h.key)).toEqual(['a']);
    // a transaction's store sees the same sizes
    await store.tx(async (tx) => { expect(await tx.vectors.nearest(later, [1, 0], 1)).toHaveLength(1); });
    expect(await store.vectors.ensure(later, 3)).toBe(true);
    expect(await store.vectors.nearest(later, [1, 0, 0], 1)).toEqual([]);
    await expect(store.vectors.upsert(later, [{ kind: 'fn', key: 'a', vector: [1, 0] }])).rejects.toMatchObject({ code: 'bad-vector' });
  });

  it('names tables readably and uniquely', () => {
    expect(vectorTable('embedder/gemma')).toMatch(/^_vec_embedder_gemma_[0-9a-f]{8}$/);
    expect(vectorTable('a-b/c')).not.toBe(vectorTable('a_b/c'));
    expect(similarity(0)).toBe(1);
    expect(similarity(1.5)).toBe(0);
    expect(similarity(-0.0001)).toBe(1);
  });
});

describe('hybrid search', () => {
  it('fuses ranks: items both lists rank well come first', () => {
    const fused = fuseRanks({
      vector: [{ kind: 'fn', key: 'a' }, { kind: 'fn', key: 'b' }, { kind: 'fn', key: 'c' }],
      text: [{ kind: 'fn', key: 'b' }, { kind: 'fn', key: 'c' }, { kind: 'fn', key: 'b' }, { kind: 'fn', key: 'd' }],
    }, 60);
    expect(fused.map((h) => h.key)).toEqual(['b', 'c', 'a', 'd']);
    // b is listed twice in text: it counts once, at its best rank
    expect(fused[0]?.ranks).toEqual({ vector: 2, text: 1 });
    // as a share of the best possible score, first in both lists (2 / 61)
    expect(fused[0]?.score).toBeCloseTo((1 / 62 + 1 / 61) / (2 / 61), 10);
    expect(fuseRanks({ only: [{ kind: 'fn', key: 'top' }] }, 60)[0]?.score).toBe(1);
    expect(fused.find((h) => h.key === 'd')?.ranks).toEqual({ text: 4 });
    expect(fuseRanks({ a: [] }, 60)).toEqual([]);
  });

  it('searches both indexes of a store and merges them', async () => {
    await store.text.upsert([
      { kind: 'fn', key: 'fs/read', text: 'read a file' },
      { kind: 'fn', key: 'fs/grep', text: 'search inside files' },
    ]);
    await store.vectors.upsert(TEST_EMBEDDER, [
      { kind: 'fn', key: 'fs/grep', vector: [1, 0, 0] },
      { kind: 'fn', key: 'fs/glob', vector: [0.9, 0.1, 0] },
    ]);
    const hits = await store.search.search({ text: 'files', kinds: ['fn'], limit: 3, vector: { embedder: TEST_EMBEDDER, values: [1, 0, 0] } });
    // fs/grep is the only item both indexes found
    expect(hits[0]).toMatchObject({ key: 'fs/grep', ranks: { vector: 1 } });
    expect(hits[0]?.ranks.text).toBeGreaterThan(0);
    expect(hits.map((h) => h.key).sort()).toEqual(['fs/glob', 'fs/grep', 'fs/read']);
    // each scores its similarity of meaning; fs/read has no vector, so nothing vouches for it
    expect(hits.find((h) => h.key === 'fs/grep')).toMatchObject({ score: 1, similarity: 1 });
    expect(hits.find((h) => h.key === 'fs/glob')?.similarity).toBeCloseTo(0.994, 3);
    expect(hits.find((h) => h.key === 'fs/read')).toMatchObject({ score: 0 });
    expect(hits.find((h) => h.key === 'fs/read')?.similarity).toBeUndefined();
    // words alone while no embedder is connected: the share of the best rank, with no similarity
    const words = await store.search.search({ text: 'read', kinds: ['fn'], limit: 3 });
    expect(words.map((h) => h.key)).toEqual(['fs/read']);
    expect(words[0]?.score).toBe(1);
    expect(words[0]?.similarity).toBeUndefined();
    expect(await store.search.search({ text: 'read', kinds: [], limit: 3 })).toEqual([]);
    expect(await store.search.search({ text: 'read', kinds: ['fn'], limit: 0 })).toEqual([]);
  });

  it('asks each index for limit × depth candidates', async () => {
    const asked: number[] = [];
    const vectors: VectorIndex = {
      ensure: () => Promise.resolve(false), upsert: () => Promise.resolve(), remove: () => Promise.resolve(),
      nearest: (_e, _v, limit) => { asked.push(limit); return Promise.resolve([{ kind: 'fn', key: 'v', score: 1 }]); },
    };
    const text: TextIndex = {
      upsert: () => Promise.resolve(), remove: () => Promise.resolve(),
      search: ({ limit }) => { asked.push(limit); return Promise.resolve([{ kind: 'fn', key: 't', score: 1 }]); },
    };
    const search = new HybridSearch({ vectors, text }, { HARNESS_SEARCH_DEPTH: 5, HARNESS_SEARCH_RRF_K: 1 });
    const hits = await search.search({ text: 'q', kinds: ['fn'], limit: 1, vector: { embedder: 'e/x', values: [1] } });
    expect(asked).toEqual([5, 5]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ key: 'v', score: 1, similarity: 1 });
  });

  // regression: the "You there?" chat (2026-11-17) offered the web fns at 0.94 to 1 for every message; the score was
  // the fused rank, so the first of any search scored 1 however far it was from what was asked
  it('scores by similarity of meaning, not by rank: the best of an unrelated search scores low', async () => {
    await store.text.upsert([
      { kind: 'fn', key: 'web/search', text: 'Search the web for anything you don’t know, when there is an answer' },
      { kind: 'context', key: 'web/guide', text: 'How you read the pages you find there' },
      { kind: 'fn', key: 'database/tables', text: 'The tables of a database' },
    ]);
    // the web, small talk and databases, as three directions
    await store.vectors.upsert(TEST_EMBEDDER, [
      { kind: 'fn', key: 'web/search', vector: [1, 0.2, 0] },
      { kind: 'context', key: 'web/guide', vector: [1, 0.3, 0] },
      { kind: 'fn', key: 'database/tables', vector: [0, 0, 1] },
    ]);
    const smallTalk = { embedder: TEST_EMBEDDER, values: [0.05, 1, 0.05] } as const;
    const hits = await store.search.search({ text: 'You there?', kinds: ['fn', 'context'], limit: 3, vector: smallTalk });
    // both lists rank the web first, and fusion still orders by them...
    expect(hits[0]?.key).toMatch(/^web\//);
    expect(hits[0]?.ranks).toMatchObject({ vector: 1, text: 1 });
    // ...but no hit scores near 1: each is as close as its meaning is
    expect(Math.max(...hits.map((h) => h.score))).toBeLessThan(0.35);
    for (const hit of hits) expect(hit.score).toBe(hit.similarity);
    // a hit only the words found (past the vectors' depth) gets its similarity from the database too
    const shallow = new HybridSearch({ vectors: store.vectors, text: store.text }, { HARNESS_SEARCH_DEPTH: 1, HARNESS_SEARCH_RRF_K: 60 });
    const near = await shallow.search({ text: 'tables', kinds: ['fn', 'context'], limit: 2, vector: { embedder: TEST_EMBEDDER, values: [1, 0.3, 0.3] } });
    expect(near.map((h) => h.key)).toEqual(['web/guide', 'database/tables']);
    expect(near[1]?.ranks).toEqual({ text: 1 });
    expect(near[1]?.similarity).toBeCloseTo(0.3 / Math.hypot(1, 0.3, 0.3), 5);
    expect(near[1]?.score).toBe(near[1]?.similarity);
    // semantic alone scores the same way
    const semantic = await store.search.search({ text: 'x', kinds: ['fn'], limit: 1, vector: smallTalk, match: 'semantic' });
    expect(semantic[0]?.score).toBeLessThan(0.35);
  });
});
