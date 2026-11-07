import type { Request, Response } from '@aeye/core';
import { limiter } from '@ayepi/rate';
import { WorkDelayError } from '@ayepi/work';
import { BudgetId, ModelCategoryId, RunId, SystemName, TurnId, type Run } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { MemoryBus, MemoryStore, memoryLog } from '../catalog/testing.ts';
import { HubAiHooks } from './ai.ts';
import { BudgetRefused, causeOf, LlmRateLimited } from './errors.ts';
import { InteractionRecorder } from './interactions.ts';
import { HubLedger } from './ledger.ts';
import { ModelResolver } from './models.ts';
import { transientDelay } from './queues.ts';
import { LlmCallScope } from './scope.ts';
import { LedgerSpend } from './spend.ts';
import { openRouterProviders } from './providers.ts';
import { ALICE, ALICE_INFO, executionRig, OPEN_LIMITS, testSettings } from './testing.ts';

const RUN = RunId.parse('run_1');
const emptyRequest: Request = { messages: [] };
const hiRequest: Request = { messages: [{ role: 'user', content: 'hi' }] };
const reply = (content: string, model: string): Response => ({ content, finishReason: 'stop', model });

/** A run and its turn in a store, for the hooks to reserve against. */
async function seeded(turnCost = 1) {
  const store = new MemoryStore();
  const { log } = memoryLog();
  let n = 0;
  const base = { store, bus: new MemoryBus(), clock: () => 1_000, random: () => `${++n}`, settings: testSettings(), log };
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
  const scope = new LlmCallScope({ run: RUN, turn: turn.id, fn: run.fn, actor: ALICE, iteration: 2, priority: 'interactive', limits, queuedAt: 500 });
  const hooks = (limit = 10) => new HubAiHooks({
    ...base, ledger, recorder: new InteractionRecorder(base), costs: { addCost: (_run, cost) => { added.push(cost); return Promise.resolve(); } },
    modelLimit: limiter({ limit, window: 60_000 }),
  });
  return { store, ledger, scope, hooks, added };
}

describe('the hub AI hooks', () => {
  it('do nothing for calls outside a scope', async () => {
    const { hooks, store } = await seeded();
    await hooks().before({}, emptyRequest, { id: 'm', provider: 'p' }, 1);
    expect(await store.table('llmInteractions').count()).toBe(0);
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
    const store = new MemoryStore();
    await store.table('modelCategories').insert({ id: ModelCategoryId.parse('mct_1'), name: 'fast', description: 'Fast ones', models: ['m-fast', 'm-slow'] });
    const models = new ModelResolver({ store, settings: testSettings() });
    expect(await models.resolve(undefined)).toEqual({ model: 'test-model' });
    expect(await models.resolve({ model: 'x' })).toEqual({ model: 'x' });
    expect(await models.resolve({ category: 'fast' })).toEqual({ model: 'm-fast' });
    expect(await models.resolve({ category: 'none' })).toEqual({ model: 'test-model' });
    expect(await models.resolve({ auto: { cost: 1, accuracy: 0.5 } })).toEqual({ weights: { cost: 1, accuracy: 0.5 } });
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
    const rig = executionRig();
    expect(await rig.module.llm.models()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'test-model', name: 'Test model', capabilities: ['chat', 'streaming', 'tools', 'json', 'structured'] })]));
  });
});
