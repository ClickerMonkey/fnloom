/**
 * Build 4 on the system side, against the in-memory hub: fn validation hooks (declared in the manifest, served by
 * `validate` with the args, result and declared state) and model providers a system brings (declared in the manifest,
 * chat streamed and embeddings served by its aeye provider, undeclared models refused).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Provider } from '@aeye/ai';
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
const EMBEDDER = { id: 'vec', capabilities: ['embedding'], contextWindow: 512, pricing: { input: 0.01, output: 0 }, caching: false };

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
  providers: { local: provider({ description: 'Models on the shop box.', models: [MODEL, EMBEDDER] }) },
});

/** A fake aeye provider: streams the greeting back word by word, embeds each text as its length. */
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
    embed: (request) => Promise.resolve({ embeddings: request.texts.map((t, index) => ({ embedding: [t.length], index })), model: 'vec', usage: { text: { input: 3 } } }),
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
    expect(manifest.providers).toEqual([{ name: 'local', description: 'Models on the shop box.', models: [MODEL, EMBEDDER] }]);
    expect(() => provider({ description: 'Twice.', models: [MODEL, MODEL] })).toThrow(/declared twice/);
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

  it('embeds texts with its provider', async () => {
    const hub = new FakeHub({ config: { greeting: 'hi' } });
    await start(hub);
    expect(await hub.peer().call('providerEmbed', { provider: 'local', model: 'vec', texts: ['ab', 'abcd'] })).toEqual({ vectors: [[2], [4]], tokens: 3 });
  });
});
