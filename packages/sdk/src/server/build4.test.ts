/**
 * Build 4 on the system side, against the in-memory hub: fn validation hooks (declared in the manifest, served by
 * `validate` with the args, result and declared state) and model providers a system brings (declared in the manifest,
 * chat streamed, embeddings and decisions served by its aeye provider, its live models listed within the declared set,
 * undeclared models refused).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddingRequest, Provider } from '@aeye/ai';
import type { Chunk, Request, Response } from '@aeye/core';
import type { ProviderChunk } from '@harness/core';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { manifestOf } from '../manifest.ts';
import { provider } from '../providers.ts';
import { system } from '../system.ts';
import { serve, type RunningSystem } from './index.ts';
import { FakeHub } from './testing.ts';

const MODEL = { id: 'tiny', capabilities: ['chat', 'tools', 'streaming'], contextWindow: 4096, pricing: { input: 1, output: 2, cached: 0.1 }, caching: true };
const EMBEDDER = { id: 'vec', capabilities: ['embedding'], contextWindow: 512, dimensions: 1, pricing: { input: 0.01, output: 0 }, caching: false };
const JUDGE = { id: 'judge', capabilities: ['decision'], contextWindow: 8192, maxQuestions: 64, pricing: { input: 0.02, output: 0 }, caching: false };

const shop = system('shop', { description: 'A shop for tests.' }).with({
  config: g.obj({ greeting: g.text() }),
  fns: {
    buy: fn({
      description: 'Buy an item.',
      args: g.obj({ item: g.text(), count: g.num({ whole: true }) }),
      returns: g.obj({ total: g.num() }),
      state: g.obj({ open: g.bool() }),
      validate: {
        input: (_ctx, args, state) => (state.open === false ? { ok: false, reason: 'The shop is closed.' } : args.count > 0 ? { ok: true } : { ok: false, reason: 'Buy at least one.' }),
        output: (ctx, _args, result) => (result.total <= 100 ? { ok: true } : { ok: false, action: ctx.attempt > 1 ? 'stop' : 'retry', reason: 'Too expensive.' }),
      },
    }),
    plain: fn({ description: 'No hooks.', args: g.obj({}), returns: g.text() }),
  },
  providers: { local: provider({ description: 'Models on the shop box.', models: [MODEL, EMBEDDER, JUDGE] }) },
});

/** The embedding requests the fake provider was given. */
const embedded: EmbeddingRequest[] = [];

/** A fake aeye provider: streams the greeting back word by word, embeds each text as its length (an image as 100). */
function fakeProvider(greeting: string): Provider {
  return {
    name: 'fake',
    config: {},
    checkHealth: () => Promise.resolve(true),
    createStreamer: () => async function* stream(request: Request): AsyncGenerator<Chunk, Response> {
      const text = `${greeting} ${request.messages.length}`;
      for (const word of text.split(' ')) yield { content: `${word} ` };
      yield { finishReason: 'stop', usage: { text: { input: 7, output: 2, cached: 5 } } };
      return { content: text, finishReason: 'stop', model: 'tiny', usage: { text: { input: 7, output: 2, cached: 5 } } };
    },
    embed: (request) => {
      embedded.push(request);
      const inputs = request.inputs ?? request.texts ?? [];
      return Promise.resolve({ embeddings: inputs.map((t, index) => ({ embedding: [typeof t === 'string' ? t.length : 100], index })), model: 'vec', usage: { text: { input: 3 } } });
    },
    // a yes to anything mentioning the greeting; the input's length as the tokens
    decide: (request) => Promise.resolve({
      answers: Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, { type: 'predicate' as const, probability: q.instructions.includes(greeting) ? 0.9 : 0.1 }])),
      model: 'judge', usage: { text: { input: typeof request.input === 'string' ? request.input.length : request.input.length * 100 } },
    }),
    // it serves tiny with a smaller window, judge, and a model nobody reviewed
    listModels: () => Promise.resolve([
      { id: 'tiny', provider: 'fake', name: 'Tiny', capabilities: new Set(['chat' as const]), tier: 'efficient' as const, contextWindow: 2048, pricing: {} },
      { id: 'judge', provider: 'fake', name: 'Judge', capabilities: new Set(['decision' as const]), tier: 'efficient' as const, contextWindow: 8192, maxQuestions: 32, pricing: {} },
      { id: 'shadow', provider: 'fake', name: 'Shadow', capabilities: new Set(['chat' as const]), tier: 'efficient' as const, contextWindow: 100, pricing: {} },
    ]),
  };
}

let running: RunningSystem<'shop'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function start(hub: FakeHub): Promise<void> {
  running = await serve(shop, {
    fns: {
      buy: { async run(args, ctx) { return ctx.done({ total: args.count * 30 }); } },
      plain: { async run(_a, ctx) { return ctx.done('ok'); } },
    },
    providers: { local: (ctx) => fakeProvider(ctx.config.greeting) },
  }, { hub: 'ws://hub.test/link', state: 'unused', version: '1.0.0' }, hub.host());
  await running.ready();
}

describe('fn validation hooks', () => {
  it('declares which hooks a fn has in its manifest', async () => {
    const manifest = await manifestOf(shop, { version: '1.0.0' });
    expect(manifest.fns.find((f) => f.name === 'buy')?.validate).toEqual({ input: true, output: true });
    expect(manifest.fns.find((f) => f.name === 'plain')?.validate).toBeUndefined();
  });

  it('checks input with the args and the declared state', async () => {
    const hub = new FakeHub({ config: { greeting: 'hi' } });
    await start(hub);
    const run = hub.runInfo('shop/buy');
    expect(await hub.peer().call('validate', { phase: 'input', run, fn: 'buy', args: { item: 'pen', count: 2 } })).toEqual({ ok: true });
    expect(await hub.peer().call('validate', { phase: 'input', run, fn: 'buy', args: { item: 'pen', count: 0 } })).toEqual({ ok: false, reason: 'Buy at least one.' });
    hub.state.set(`run:${run.id}`, { values: { open: false }, version: 1 });
    expect(await hub.peer().call('validate', { phase: 'input', run, fn: 'buy', args: { item: 'pen', count: 2 } })).toEqual({ ok: false, reason: 'The shop is closed.' });
  });

  it('checks a result, retrying first and stopping on a later attempt', async () => {
    const hub = new FakeHub({ config: { greeting: 'hi' } });
    await start(hub);
    const base = { phase: 'output', run: hub.runInfo('shop/buy'), fn: 'buy', args: { item: 'tv', count: 9 } } as const;
    expect(await hub.peer().call('validate', { ...base, result: { total: 50 }, attempt: 1 })).toEqual({ ok: true });
    expect(await hub.peer().call('validate', { ...base, result: { total: 270 }, attempt: 1 })).toEqual({ ok: false, action: 'retry', reason: 'Too expensive.' });
    expect(await hub.peer().call('validate', { ...base, result: { total: 270 }, attempt: 2 })).toEqual({ ok: false, action: 'stop', reason: 'Too expensive.' });
  });

  it('passes a fn without hooks, and refuses args that do not fit', async () => {
    const hub = new FakeHub({ config: { greeting: 'hi' } });
    await start(hub);
    expect(await hub.peer().call('validate', { phase: 'input', run: hub.runInfo('shop/plain'), fn: 'plain', args: {} })).toEqual({ ok: true });
    await expect(hub.peer().call('validate', { phase: 'input', run: hub.runInfo('shop/buy'), fn: 'buy', args: { item: 3 } })).rejects.toThrow();
  });
});

describe('model providers', () => {
  it('declares its providers and their models in the manifest', async () => {
    const manifest = await manifestOf(shop, { version: '1.0.0' });
    expect(manifest.providers).toEqual([{ name: 'local', description: 'Models on the shop box.', models: [MODEL, EMBEDDER, JUDGE] }]);
    expect(() => provider({ description: 'Twice.', models: [MODEL, MODEL] })).toThrow(/declared twice/);
    // an embedding model says its vectors' size, so the hub's index can store them
    expect(() => provider({ description: 'Sizeless.', models: [{ ...EMBEDDER, dimensions: undefined }] })).toThrow(/dimensions/);
  });

  it('streams a chat call through its provider, then the usage', async () => {
    const hub = new FakeHub({ config: { greeting: 'hello there' } });
    await start(hub);
    const items: ProviderChunk[] = [];
    for await (const item of hub.peer().call('providerChat', { provider: 'local', model: 'tiny', stream: true, request: { messages: [{ role: 'user', content: 'hi' }] } })) items.push(item);
    const text = items.flatMap((i) => (i.type === 'chunk' && i.chunk.content !== undefined ? [i.chunk.content] : [])).join('');
    expect(text).toBe('hello there 1 ');
    expect(items.at(-1)).toEqual({ type: 'done', usage: { input: 7, output: 2, cached: 5 } });
  });

  it('refuses a model it does not declare, as a model error', async () => {
    const hub = new FakeHub({ config: { greeting: 'hi' } });
    await start(hub);
    const items: ProviderChunk[] = [];
    for await (const item of hub.peer().call('providerChat', { provider: 'local', model: 'huge', stream: true, request: { messages: [] } })) items.push(item);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'error', kind: 'model' });
    expect(items[0]?.type === 'error' ? items[0].message : '').toContain('huge');
  });

  it("embeds texts with its provider, as aeye's texts shorthand", async () => {
    const hub = new FakeHub({ config: { greeting: 'hi' } });
    await start(hub);
    embedded.length = 0;
    expect(await hub.peer().call('providerEmbed', { provider: 'local', model: 'vec', inputs: ['ab', 'abcd'] })).toEqual({ vectors: [[2], [4]], tokens: 3 });
    expect(embedded[0]).toMatchObject({ texts: ['ab', 'abcd'] });
    expect(embedded[0]?.inputs).toBeUndefined();
  });

  it("embeds images with its provider, in aeye's one inputs list", async () => {
    const hub = new FakeHub({ config: { greeting: 'hi' } });
    await start(hub);
    embedded.length = 0;
    const image = { image: 'data:image/png;base64,AQID', mimeType: 'image/png' };
    expect(await hub.peer().call('providerEmbed', { provider: 'local', model: 'vec', inputs: ['ab', image] })).toEqual({ vectors: [[2], [100]], tokens: 3 });
    expect(embedded[0]).toMatchObject({ inputs: ['ab', image] });
    expect(embedded[0]?.texts).toBeUndefined();
    // an image the link can't carry (not an http(s) or data URL) is refused before the provider sees it
    await expect(hub.peer().call('providerEmbed', { provider: 'local', model: 'vec', inputs: [{ image: 'file:///etc/passwd' }] })).rejects.toThrow();
  });

  it('answers decision calls with its provider, for text or a conversation, and refuses an undeclared model', async () => {
    const hub = new FakeHub({ config: { greeting: 'hi' } });
    await start(hub);
    const questions = { greets: { type: 'predicate' as const, instructions: 'Does it say hi?' }, other: { type: 'predicate' as const, instructions: 'Is it long?' } };
    expect(await hub.peer().call('providerDecide', { provider: 'local', model: 'judge', input: 'hello', questions })).toEqual({
      answers: { greets: { type: 'predicate', probability: 0.9 }, other: { type: 'predicate', probability: 0.1 } }, tokens: 5,
    });
    expect(await hub.peer().call('providerDecide', { provider: 'local', model: 'judge', input: [{ role: 'user', content: 'hi' }], questions })).toMatchObject({ tokens: 100 });
    await expect(hub.peer().call('providerDecide', { provider: 'local', model: 'oracle', input: 'x', questions })).rejects.toThrow(/declares no model oracle/);
  });

  it('lists the declared models it serves now, with their served limits, never one the manifest lacks', async () => {
    const hub = new FakeHub({ config: { greeting: 'hi' } });
    await start(hub);
    expect(await hub.peer().call('providerModels', { provider: 'local' })).toEqual({ listed: true, models: [{ id: 'tiny', contextWindow: 2048 }, { id: 'judge', contextWindow: 8192, maxQuestions: 32 }] });
    await expect(hub.peer().call('providerModels', { provider: 'nowhere' })).rejects.toThrow(/No provider nowhere/);
  });
});
