/** A call pinned to a provider goes to that provider, even when another serves a model of the same name. */
import type { ModelInfo } from '@aeye/ai';
import { limiter } from '@ayepi/rate';
import { describe, expect, it } from 'vitest';
import { StoreModelCallLog } from '../metrics/calls.ts';
import { memoryLog, RecordingBus, testStore } from '../testing.ts';
import { AeyeLlm, createHubAi, HubAiHooks, SwitchingLlm } from './ai.ts';
import { InteractionRecorder } from './interactions.ts';
import { HubLedger } from './ledger.ts';
import { LedgerSpend } from './spend.ts';
import { says, ScriptedProvider, TEST_MODEL, testSettings } from './testing.ts';

/** The hub AI over two providers that both serve `test-model`. */
async function twoProviders() {
  const store = await testStore();
  const { log } = memoryLog();
  let n = 0;
  const base = { store, bus: new RecordingBus(), clock: () => 1_000, random: () => `${++n}`, settings: testSettings(), log };
  const hooks = new HubAiHooks({
    ...base, ledger: new HubLedger(base, new LedgerSpend(store)), recorder: new InteractionRecorder(base), calls: new StoreModelCallLog({ store, clock: base.clock, log, random: base.random }),
    costs: { addCost: () => Promise.resolve(), addTokens: () => Promise.resolve() }, modelLimit: limiter({ limit: 10, window: 60_000 }),
  });
  const openrouter = new ScriptedProvider();
  const openai = new ScriptedProvider();
  const models: ModelInfo[] = [TEST_MODEL, { ...TEST_MODEL, provider: 'openai', pricing: { text: { input: 3, output: 4 } } }];
  const ai = createHubAi({ providers: { openrouter, openai }, hooks, log, models });
  return { ai, store, openrouter, openai };
}

describe('a call pinned to a provider', () => {
  it('goes to the pinned provider, and its model call records that provider', async () => {
    const { ai, store, openrouter, openai } = await twoProviders();
    openai.script(says('from openai'));
    openrouter.script(says('from openrouter'));
    const answer = await ai.chat.get({ messages: [{ role: 'user', content: 'hi' }] }, { purpose: 'test', metadata: { model: 'test-model', provider: 'openai' } });
    expect(answer.content).toBe('from openai');
    expect([openai.requests.length, openrouter.requests.length]).toEqual([1, 0]);
    expect((await store.table('modelCalls').find({ limit: 5 })).items).toMatchObject([{ provider: 'openai', model: 'test-model' }]);
  });

  it('refuses a pin to a provider that is not set up', async () => {
    const { ai, openrouter } = await twoProviders();
    openrouter.script(says('never'));
    await expect(ai.chat.get({ messages: [{ role: 'user', content: 'hi' }] }, { purpose: 'test', metadata: { model: 'test-model', provider: 'ollama' } })).rejects.toThrow('ollama is not set up');
    expect(openrouter.requests).toHaveLength(0);
  });
});

describe('the switching hub AI', () => {
  // the index's embedders wait on this: a system's provider is offered a moment before the AI is rebuilt with it
  it('says which providers are set up, following each rebuild', async () => {
    const { log } = memoryLog();
    const store = await testStore();
    const base = { store, bus: new RecordingBus(), clock: () => 1_000, settings: testSettings(), log };
    const hooks = new HubAiHooks({
      ...base, ledger: new HubLedger(base, new LedgerSpend(store)), recorder: new InteractionRecorder(base), calls: new StoreModelCallLog({ store, clock: base.clock, log }),
      costs: { addCost: () => Promise.resolve(), addTokens: () => Promise.resolve() }, modelLimit: limiter({ limit: 10, window: 60_000 }),
    });
    const engine = new SwitchingLlm((providers) => new AeyeLlm(createHubAi({ providers, hooks, log, models: [TEST_MODEL] })), { openrouter: new ScriptedProvider() });
    expect([engine.serves('openrouter'), engine.serves('embedder/gemma')]).toEqual([true, false]);
    await engine.use({ openrouter: new ScriptedProvider(), 'embedder/gemma': new ScriptedProvider() });
    expect(engine.serves('embedder/gemma')).toBe(true);
  });
});
