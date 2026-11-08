import type { Request, Response } from '@aeye/core';
import type { EmbeddingRequest, EmbeddingResponse, SpeechRequest, SpeechResponse, TranscriptionRequest } from '@aeye/ai';
import { limiter } from '@ayepi/rate';
import { WorkDelayError } from '@ayepi/work';
import { BudgetId, ModelCategoryId, RunId, SystemName, TurnId, type Run } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { RecordingBus, testStore, memoryLog } from '../testing.ts';
import { HUB_PURPOSE, HubAiHooks } from './ai.ts';
import { StoreModelCallLog } from '../metrics/calls.ts';
import { BudgetRefused, causeOf, LlmRateLimited } from './errors.ts';
import { InteractionRecorder } from './interactions.ts';
import { HubLedger } from './ledger.ts';
import { ModelResolver } from './models.ts';
import { transientDelay } from './queues.ts';
import { CallReceipts, LlmCallScope } from './scope.ts';
import { LedgerSpend } from './spend.ts';
import { openRouterProviders } from './providers.ts';
import { ALICE, ALICE_INFO, executionRig, OPEN_LIMITS, testSettings } from './testing.ts';

const RUN = RunId.parse('run_1');
const emptyRequest: Request = { messages: [] };
const hiRequest: Request = { messages: [{ role: 'user', content: 'hi' }] };
const reply = (content: string, model: string): Response => ({ content, finishReason: 'stop', model });

/** A run and its turn in a store, for the hooks to reserve against. */
async function seeded(turnCost = 1) {
  const store = await testStore();
  const { log } = memoryLog();
  let n = 0;
  const base = { store, bus: new RecordingBus(), clock: () => 1_000, random: () => `${++n}`, settings: testSettings(), log };
  const limits = { ...OPEN_LIMITS, turn: { cost: turnCost, time: 60_000 } };
  const turn = await store.table('turns').insert({
    id: TurnId.parse('trn_1'), actor: ALICE, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running', limits, cost: 0, errors: 'feed-back', createdAt: 0,
  });
  const run: Run = {
    id: RUN, fn: 'tools/helper', fnVersion: 'v1', kind: 'hub/llm', system: SystemName.parse('hub'), root: RUN, turn: turn.id, key: 'k', actor: ALICE, caller: ALICE, args: {},
    status: 'running', allowed: { cancel: true, pause: false, background: false }, cost: 0, totalCost: 0, priority: 'interactive', background: false, attempt: 1, errors: [],
    stateChanges: [], createdAt: 0,
  };
  await store.table('runs').insert(run);
  const ledger = new HubLedger(base, new LedgerSpend(store));
  const added: number[] = [];
  const tokens: number[] = [];
  const calls = new StoreModelCallLog({ store, clock: base.clock, log, random: base.random });
  const scope = new LlmCallScope({ run: RUN, turn: turn.id, fn: run.fn, actor: ALICE, iteration: 2, priority: 'interactive', limits, queuedAt: 500 });
  const hooks = (limit = 10) => new HubAiHooks({
    ...base, ledger, recorder: new InteractionRecorder(base), calls,
    costs: { addCost: (_run, cost) => { added.push(cost); return Promise.resolve(); }, addTokens: (_run, used) => { tokens.push(used); return Promise.resolve(); } },
    modelLimit: limiter({ limit, window: 60_000 }),
  });
  return { store, ledger, scope, hooks, added, tokens };
}

describe('the hub AI hooks', () => {
  it('record a call outside a scope as the hub’s own work, with no budget or interaction', async () => {
    const { hooks, store } = await seeded();
    const h = hooks();
    const request: EmbeddingRequest = { texts: ['a', 'bcd'] };
    // the engine method says what the call is, with its typed request
    const ctx = { purpose: 'index', media: { modality: 'embed', request } } as const;
    const response: EmbeddingResponse = { embeddings: [{ embedding: [1, 2, 3], index: 0 }, { embedding: [4, 5, 6], index: 1 }], model: 'embed-1' };
    await h.before(ctx, request, { id: 'embed-1', provider: 'openai' }, 1);
    await h.after(ctx, response, true, false, { text: { input: 4 } }, 0.0001);
    expect(await store.table('llmInteractions').count()).toBe(0);
    expect(await store.table('reservations').count()).toBe(0);
    expect((await store.table('modelCalls').find({ limit: 5 })).items).toMatchObject([{
      modality: 'embed', model: 'embed-1', provider: 'openai', purpose: 'index', status: 'done', cost: 0.0001,
      units: { modality: 'embed', texts: 2, characters: 4, tokens: 4, dimensions: 3 }, sent: 4, received: 48,
    }]);
  });

  it('name a call no one gave a purpose the hub’s', async () => {
    const { hooks, store } = await seeded();
    await hooks().before({}, emptyRequest, { id: 'm', provider: 'p' }, 1);
    expect((await store.table('modelCalls').find({ limit: 5 })).items).toMatchObject([{ modality: 'chat', purpose: HUB_PURPOSE, status: 'running' }]);
  });

  it('point a chat call’s model call, interaction and ledger line at each other, and add its tokens to the run', async () => {
    const { hooks, store, scope, tokens } = await seeded();
    const h = hooks();
    const receipts = new CallReceipts();
    const ctx = { call: scope, receipts };
    await h.before(ctx, hiRequest, { id: 'm1', provider: 'openrouter' }, 0.01);
    await h.after(ctx, reply('hello', 'm1'), true, false, { text: { input: 3, output: 2 } }, 0.004);
    const call = (await store.table('modelCalls').find({ limit: 5 })).items[0];
    const interaction = (await store.table('llmInteractions').find({ limit: 5 })).items[0];
    expect(call).toMatchObject({ modality: 'chat', run: RUN, fn: 'tools/helper', interaction: interaction?.id, units: { input: 3, output: 2 }, cost: 0.004, queued: 500 });
    expect(interaction?.modelCall).toBe(call?.id);
    expect((await store.table('ledger').find({ limit: 5 })).items[0]?.modelCall).toBe(call?.id);
    expect(scope.last?.modelCall).toBe(call?.id);
    expect(receipts.last).toEqual({ modelCall: call?.id, model: 'm1', cost: 0.004 });
    expect(tokens).toEqual([5]);
  });

  it('close a failed or stopped call’s record with why', async () => {
    const { hooks, store, scope } = await seeded();
    const h = hooks();
    const heard: TranscriptionRequest = { audio: new Uint8Array(10) };
    const said: SpeechRequest = { text: 'hi there' };
    const spoken: SpeechResponse = { audio: new ReadableStream(), model: 'tts-1' };
    const a = { call: scope, media: { modality: 'transcribe', request: heard } } as const;
    await h.before(a, heard, { id: 'whisper-1', provider: 'openai' }, 0);
    await h.failed(a, new Error('no hearing'));
    const b = { call: scope, media: { modality: 'speech', request: said } } as const;
    await h.before(b, said, { id: 'tts-1', provider: 'openai' }, 0);
    await h.after(b, spoken, false, true, {}, 0);
    const rows = (await store.table('modelCalls').find({ order: [['startedAt', 'asc']], limit: 5 })).items;
    expect(rows.map((r) => [r.modality, r.status, r.error])).toEqual([['transcribe', 'failed', 'no hearing'], ['speech', 'aborted', 'stopped by its caller']]);
  });

  it('refuse a non-chat call its engine did not describe, so no call goes unrecorded or mislabelled', async () => {
    const { hooks, store } = await seeded();
    const said: SpeechRequest = { text: 'hi' };
    await expect(hooks().before({ purpose: 'x' }, said, { id: 'tts-1', provider: 'openai' }, 0)).rejects.toThrow('did not make through its engine');
    expect(await store.table('modelCalls').count()).toBe(0);
  });

  it('reserve, save the interaction as streaming, then settle it with the real cost', async () => {
    const { hooks, store, scope, added } = await seeded();
    const h = hooks();
    const ctx = { call: scope };
    await h.before(ctx, hiRequest, { id: 'm1', provider: 'openrouter' }, 0.01);
    const open = (await store.table('llmInteractions').find({ limit: 5 })).items[0];
    expect(open).toMatchObject({ status: 'streaming', iteration: 2, model: 'm1', provider: 'openrouter', queuedAt: 500, request: hiRequest });
    expect((await store.table('reservations').find({ limit: 5 })).items[0]?.estimate).toBeCloseTo(0.0125);
    scope.markFirstToken(900);
    await h.after(ctx, reply('hello', 'm1'), true, false, { text: { input: 3, output: 2 } }, 0.004);
    const closed = await store.table('llmInteractions').get(open?.id ?? '');
    expect(closed).toMatchObject({ status: 'done', cost: 0.004, usage: { input: 3, output: 2 }, response: { content: 'hello' }, firstTokenAt: 900 });
    expect((await store.table('ledger').find({ limit: 5 })).items).toMatchObject([{ cost: 0.004, tokens: 5, model: 'm1', llmCall: open?.id, run: RUN }]);
    expect(added).toEqual([0.004]);
    expect(scope.last).toMatchObject({ model: 'm1', cost: 0.004 });
    expect(scope.cost).toBeCloseTo(0.004);
  });

  it('mark a call cut short as aborted or failed', async () => {
    const { hooks, store, scope } = await seeded();
    const h = hooks();
    const a = { call: scope };
    await h.before(a, emptyRequest, { id: 'm', provider: 'p' }, 0);
    await h.after(a, reply('par', 'm'), false, true, {}, 0);
    const b = { call: scope };
    await h.before(b, emptyRequest, { id: 'm', provider: 'p' }, 0);
    await h.failed(b, new Error('boom'));
    const statuses = (await store.table('llmInteractions').find({ limit: 5 })).items.map((i) => [i.status, i.error]);
    expect(statuses).toEqual([['aborted', undefined], ['failed', 'boom']]);
  });

  it('refuse a call over budget before anything is saved', async () => {
    const { hooks, store, scope } = await seeded(0);
    await expect(hooks().before({ call: scope }, emptyRequest, { id: 'm', provider: 'p' }, 0.01)).rejects.toBeInstanceOf(BudgetRefused);
    expect(await store.table('llmInteractions').count()).toBe(0);
  });

  it('refuse a call over its model rate', async () => {
    const { hooks, scope } = await seeded();
    const h = hooks(1);
    await h.before({ call: scope }, emptyRequest, { id: 'm', provider: 'p' }, 0);
    await expect(h.before({ call: scope }, emptyRequest, { id: 'm', provider: 'p' }, 0)).rejects.toBeInstanceOf(LlmRateLimited);
  });
});

describe('transient failures', () => {
  it('wait out rate limits and budgets that say wait, even inside a wrapper', () => {
    const wrapped = new Error('prompt failed', { cause: new LlmRateLimited('m', 1_500) });
    expect(transientDelay(wrapped)).toBe(1_500);
    expect(causeOf(wrapped, LlmRateLimited)?.retryAfter).toBe(1_500);
    expect(transientDelay(new BudgetRefused('full', BudgetId.parse('bgt_1'), 60_000))).toBe(60_000);
    expect(transientDelay(new BudgetRefused('full', BudgetId.parse('bgt_1')))).toBeUndefined();
    expect(transientDelay(new WorkDelayError({ delay: 5 }))).toBeUndefined();
  });
});

describe('model choices', () => {
  it('resolve ids, categories and weights, with the hub default otherwise', async () => {
    const store = await testStore();
    await store.table('modelCategories').insert({ id: ModelCategoryId.parse('mct_1'), name: 'fast', description: 'Fast ones', models: ['m-fast', 'm-slow'] });
    const models = new ModelResolver({ store, settings: testSettings(), roles: { resolve: () => Promise.resolve(undefined) } });
    expect(await models.resolve(undefined)).toEqual({ model: 'test-model' });
    expect(await models.resolve({ model: 'x' })).toEqual({ model: 'x' });
    expect(await models.resolve({ category: 'fast' })).toEqual({ model: 'm-fast' });
    expect(await models.resolve({ category: 'none' })).toEqual({ model: 'test-model' });
    expect(await models.resolve({ auto: { cost: 1, accuracy: 0.5 } })).toEqual({ weights: { cost: 1, accuracy: 0.5 } });
  });

  it('use the chat role’s model, on its provider, when no choice names one', async () => {
    const store = await testStore();
    const roles = { resolve: (role: string) => Promise.resolve(role === 'chat' ? { model: 'qwen2.5:3b', provider: 'ollama' } : undefined) };
    const models = new ModelResolver({ store, settings: testSettings(), roles });
    expect(await models.resolve(undefined)).toEqual({ model: 'qwen2.5:3b', provider: 'ollama' });
    expect(await models.resolve({ category: 'none' })).toEqual({ model: 'qwen2.5:3b', provider: 'ollama' });
    expect(await models.resolve({ model: 'x' })).toEqual({ model: 'x' });
  });
});

describe('providers', () => {
  it('make OpenRouter the provider only with a key', () => {
    expect(openRouterProviders(undefined)).toEqual({});
    const provider = openRouterProviders('sk-test')['openrouter'];
    expect(provider?.name).toBe('openrouter');
    expect(typeof provider?.createStreamer?.()).toBe('function');
    expect(typeof provider?.createExecutor?.()).toBe('function');
  });

  it('list the models the hub AI can pick from', async () => {
    const rig = await executionRig();
    expect(await rig.module.llm.models()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'test-model', name: 'Test model', capabilities: ['chat', 'streaming', 'tools', 'json', 'structured'] })]));
  });
});
