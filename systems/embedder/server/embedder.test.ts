import type { Json } from '@harness/core';
import { expectType, parseValue, type Equal, type Log } from '@harness/sdk';
import { HubLlm, type HubAccess } from '@harness/sdk/server';
import { NO_ASKS, TEST_PLACE } from '@harness/sdk/server/testing';
import { describe, expect, it } from 'vitest';
import { GEMMA_DIMENSIONS, embedderSystem, type GemmaTask } from '../shared/index.ts';
import { embedderEnv } from './env.ts';
import { GemmaError, HttpGemmaClient, retryAfter, type GemmaLimits } from './http.ts';
import { VectorCache, createEmbedderImpl, embedCached } from './impl.ts';
import type { EmbedderConfig, GemmaClient } from './index.ts';

const limits: GemmaLimits = { batch: 2, retries: 2, retryDelay: 100, retryMax: 1_000, jitter: 0, timeout: 5_000 };
const vector = (seed: number) => Array.from({ length: GEMMA_DIMENSIONS }, (_, i) => (i === 0 ? seed : 0));

/** A log that keeps its lines. */
function memoryLog(): Log & { lines: Array<[string, string, Record<string, Json> | undefined]> } {
  const lines: Array<[string, string, Record<string, Json> | undefined]> = [];
  const at = (level: string) => (key: string, fields?: Record<string, Json>) => { lines.push([level, key, fields]); };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** A fake service: answers by path, recording each request. */
function fakeService(answer: (path: string, body: unknown, call: number) => Response) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    return Promise.resolve(answer(new URL(url).pathname, body, calls.length));
  };
  return { calls, fetcher };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const info = (maxBatch: number) => json({ model: 'embeddinggemma-300m', dim: GEMMA_DIMENSIONS, max_batch: maxBatch, device: 'cuda' });
const embedded = (body: unknown, truncated = 0) => {
  const texts = typeof body === 'object' && body !== null && 'texts' in body && Array.isArray(body.texts) ? body.texts : [];
  return json({ embeddings: texts.map((_: unknown, i: number) => vector(i + 1)), dim: GEMMA_DIMENSIONS, model: 'embeddinggemma-300m', task: 'query', truncated_count: truncated, trimmed: [] });
};

function client(service: ReturnType<typeof fakeService>, log: Log = memoryLog(), url = 'http://gemma:8760/') {
  const slept: number[] = [];
  const made = new HttpGemmaClient({ url: () => url, fetch: service.fetcher, sleep: (ms) => { slept.push(ms); return Promise.resolve(); }, limits, log });
  return { made, slept };
}

describe('the embedder contract', () => {
  it('takes an optional service URL as its config', () => {
    expectType<Equal<EmbedderConfig, { url?: string | undefined }>>(true);
    expect(parseValue(embedderSystem.defs.config, {})).toEqual({});
    expect(() => parseValue(embedderSystem.defs.config, { url: 'ftp://x' })).toThrow();
  });

  it('has defaults for every tunable', () => {
    const parsed = embedderEnv.parse();
    expect(parsed.HARNESS_EMBEDDER_URL).toMatch(/^https?:\/\//);
    expect(parsed.EMBEDDER_BATCH).toBe(64);
  });
});

describe('HttpGemmaClient', () => {
  it('batches to the smaller of its own and the service\'s batch size, in order', async () => {
    const service = fakeService((path, body) => (path === '/info' ? info(256) : embedded(body)));
    const { made } = client(service);
    const vectors = await made.embed(['a', 'b', 'c'], 'document');
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 1]);
    expect(service.calls.map((c) => c.url)).toEqual(['http://gemma:8760/info', 'http://gemma:8760/embed', 'http://gemma:8760/embed']);
    expect(service.calls[1]?.body).toEqual({ texts: ['a', 'b'], task: 'document', normalize: true, truncate: true });
    await made.embed(['d'], 'query');
    expect(service.calls.filter((c) => c.url.endsWith('/info'))).toHaveLength(1);
    expect(await made.embed([], 'query')).toEqual([]);
  });

  it('waits out a busy service by its Retry-After, and a loading one by backing off', async () => {
    const service = fakeService((path, body, call) => {
      if (path === '/info') { return info(1); }
      if (call === 2) { return json({ detail: 'busy' }, 429, { 'retry-after': '2' }); }
      if (call === 3) { return json({ detail: 'loading' }, 503); }
      return embedded(body);
    });
    const log = memoryLog();
    const { made, slept } = client(service, log);
    expect(await made.embed(['a'], 'query')).toHaveLength(1);
    expect(slept).toEqual([1_000, 200]);
    expect(log.lines.filter(([, key]) => key === 'embedder.retry')).toHaveLength(2);
  });

  it('gives up after its retries, and at once on other errors', async () => {
    const busy = client(fakeService((path) => (path === '/info' ? info(8) : json({}, 429))));
    await expect(busy.made.embed(['a'], 'query')).rejects.toMatchObject({ name: 'GemmaError', status: 429 });
    expect(busy.slept).toHaveLength(2);
    const bad = client(fakeService((path) => (path === '/info' ? info(8) : json({ detail: 'empty' }, 400))));
    await expect(bad.made.embed(['a'], 'query')).rejects.toThrow(/answered 400/);
    expect(bad.slept).toHaveLength(0);
  });

  it('refuses vectors of the wrong size or count', async () => {
    const short = client(fakeService((path) => (path === '/info' ? info(8) : json({ embeddings: [[1, 2]], dim: 2, model: 'm', task: 'query', truncated_count: 0 }))));
    await expect(short.made.embed(['a'], 'query')).rejects.toBeInstanceOf(GemmaError);
    const malformed = client(fakeService((path) => (path === '/info' ? info(8) : json({ nope: true }))));
    await expect(malformed.made.embed(['a'], 'query')).rejects.toThrow();
  });

  it('logs truncated texts and reports health', async () => {
    const log = memoryLog();
    const service = fakeService((path, body) => {
      if (path === '/health') { return json({ status: 'ok', model: 'embeddinggemma-300m', dim: GEMMA_DIMENSIONS, device: 'cuda' }); }
      return path === '/info' ? info(8) : embedded(body, 1);
    });
    const { made } = client(service, log);
    await made.embed(['long'], 'document');
    expect(log.lines).toContainEqual(['warn', 'embedder.truncated', { task: 'document', texts: 1, truncated: 1 }]);
    expect((await made.health()).status).toBe('ok');
  });

  it('says when the service can\'t be reached, and asks for its batch size again next time', async () => {
    let up = false;
    const service = fakeService((path, body) => {
      if (!up) { throw new Error('offline'); }
      return path === '/info' ? info(4) : embedded(body);
    });
    const fetcher = service.fetcher;
    const made = new HttpGemmaClient({ url: () => 'http://gemma', fetch: fetcher, sleep: () => Promise.resolve(), limits, log: memoryLog() });
    await expect(made.embed(['a'], 'query')).rejects.toMatchObject({ status: 0 });
    up = true;
    expect(await made.embed(['a'], 'query')).toHaveLength(1);
  });

  it('reads Retry-After seconds', () => {
    expect(retryAfter('3')).toBe(3_000);
    expect(retryAfter('0.5')).toBe(500);
    expect(retryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBeUndefined();
    expect(retryAfter(null)).toBeUndefined();
  });
});

describe('the query cache', () => {
  it('evicts the least recently used', () => {
    const cache = new VectorCache(2);
    cache.set('a', [1]);
    cache.set('b', [2]);
    cache.get('a');
    cache.set('c', [3]);
    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual([[1], undefined, [3]]);
    const off = new VectorCache(0);
    off.set('a', [1]);
    expect(off.size).toBe(0);
  });

  it('embeds each missing text once and keeps the order', async () => {
    const cache = new VectorCache(10);
    cache.set('known', [9]);
    const asked: string[][] = [];
    const vectors = await embedCached(cache, ['x', 'known', 'x', 'y'], (texts) => { asked.push(texts); return Promise.resolve(texts.map((t) => [t.charCodeAt(0)])); });
    expect(asked).toEqual([['x', 'y']]);
    expect(vectors).toEqual([[120], [9], [120], [121]]);
    await expect(embedCached(new VectorCache(0), ['z'], () => Promise.resolve([[1]]))).rejects.toThrow(/fewer vectors/);
  });
});

describe('the embedder implementation', () => {
  class FakeClient implements GemmaClient {
    readonly asked: Array<[readonly string[], GemmaTask]> = [];
    healthy = true;
    embed(texts: readonly string[], task: GemmaTask): Promise<number[][]> {
      this.asked.push([texts, task]);
      return Promise.resolve(texts.map((_, i) => vector(i)));
    }

    health() {
      return this.healthy ? Promise.resolve({ status: 'ok' as const, model: 'm', dim: GEMMA_DIMENSIONS }) : Promise.reject(new Error('down'));
    }
  }

  /** A hub that is never reached, so the real `HubLlm` over it fails every call: the embedder uses no LLM. */
  const unreachable: HubAccess = { ready: () => Promise.reject(new Error('unused')), now: () => undefined, limits: () => ({ maxFrame: 262_144, maxChunk: 131_072, heartbeat: 15_000 }) };
  const ctx = (config: EmbedderConfig, log: Log) => ({ ...TEST_PLACE, ...NO_ASKS, system: 'embedder', config, log, signal: new AbortController().signal, llm: new HubLlm({ hub: unreachable }), resources: { stat: () => Promise.reject(new Error('unused')), text: () => Promise.reject(new Error('unused')), bytes: () => Promise.reject(new Error('unused')), links: () => Promise.reject(new Error('unused')), sections: () => Promise.reject(new Error('unused')), search: () => Promise.reject(new Error('unused')) }, types: { definitions: () => Promise.reject(new Error('unused')) }, data: { find: () => Promise.reject(new Error('unused')), get: () => Promise.reject(new Error('unused')), table: () => Promise.reject(new Error('unused')), save: () => Promise.reject(new Error('unused')), remove: () => Promise.reject(new Error('unused')) } });

  it('is a provider whose models are the tasks: embeds documents and queries with their task, caching queries', async () => {
    const fake = new FakeClient();
    const { impl } = createEmbedderImpl({ client: fake, defaultUrl: 'http://default', queryCache: 10 });
    const gemma = impl.providers.gemma(ctx({}, memoryLog()));
    const documents = await gemma.embed?.({ texts: ['d1', 'd2'], model: 'document' }, {});
    expect(documents).toEqual({ embeddings: [{ embedding: vector(0), index: 0 }, { embedding: vector(1), index: 1 }], model: 'document' });
    await gemma.embed?.({ texts: ['q1'], model: 'query' }, {});
    await gemma.embed?.({ texts: ['q1'], model: { id: 'query' } }, {});
    expect(fake.asked).toEqual([[['d1', 'd2'], 'document'], [['q1'], 'query']]);
    await expect(gemma.embed?.({ texts: ['x'], model: 'passage' }, {})).rejects.toThrow(/no model passage/);
  });

  it('lists both models while the service answers with EmbeddingGemma’s size, and says when it is down', async () => {
    const fake = new FakeClient();
    const gemma = createEmbedderImpl({ client: fake, defaultUrl: 'http://default', queryCache: 10 }).impl.providers.gemma(ctx({}, memoryLog()));
    expect((await gemma.listModels?.())?.map((m) => [m.id, [...m.capabilities], m.contextWindow])).toEqual([['document', ['embedding'], 2_048], ['query', ['embedding'], 2_048]]);
    expect(await gemma.checkHealth()).toBe(true);
    fake.healthy = false;
    expect(await gemma.checkHealth()).toBe(false);
    await expect(gemma.listModels?.()).rejects.toThrow('down');
  });

  it('follows the config\'s URL, falling back to the default, and starts even when the service is down', async () => {
    const fake = new FakeClient();
    const log = memoryLog();
    const server = createEmbedderImpl({ client: fake, defaultUrl: 'http://default', queryCache: 10 });
    await server.impl.lifecycle?.started?.(ctx({}, log));
    expect(server.url()).toBe('http://default');
    expect(log.lines.at(-1)?.[1]).toBe('embedder.ready');
    fake.healthy = false;
    await server.impl.lifecycle?.configured?.({ ...ctx({ url: 'http://elsewhere' }, log), previous: {} });
    expect(server.url()).toBe('http://elsewhere');
    expect(log.lines.at(-1)).toEqual(['warn', 'embedder.unavailable', { url: 'http://elsewhere', detail: 'down' }]);
  });
});
