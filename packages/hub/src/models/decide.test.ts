/**
 * Splitting decision questions by the model's `maxQuestions`, through aeye and `@aeye/ollama` against a fake Ollama
 * that lists a System One model: aeye refuses an over-cap call, and `decideInBatches` asks it in calls the model takes.
 */
import { AI, DecisionLimitError, type DecisionQuestion } from '@aeye/ai';
import { OllamaProvider } from '@aeye/ollama';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelCallId, type ModelRoleView } from '@harness/core';
import { decideInBatches, HubDecider, questionBatches } from './decide.ts';
import type { ModelSite } from './index.ts';

/** A fake Ollama with one System One model (`nimble`) that answers every predicate with 0.5 + its index / 1000. */
function fakeOllama() {
  const asked: string[][] = [];
  const SystemOneBody = z.object({ questions: z.record(z.string(), z.unknown()) });
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    switch (url.pathname) {
      case '/api/version': return Promise.resolve(json({ version: '0.36.0' }));
      case '/api/tags': return Promise.resolve(json({ models: [{ name: 'nimble', model: 'nimble' }] }));
      case '/api/show': return Promise.resolve(json({ capabilities: ['decision'], model_info: { 'nimble.context_length': 65_536 } }));
      case '/v1/systemone': {
        const names = Object.keys(SystemOneBody.parse(body).questions);
        asked.push(names);
        const answers = Object.fromEntries(names.map((name) => [name, { type: 'noul', noul: 0.5 + Number(name.slice(1)) / 1_000 }]));
        return Promise.resolve(json({ model: 'nimble', answers, usage: { input_tokens: 10, output_tokens: names.length } }));
      }
      default: return Promise.resolve(new Response('no', { status: 404 }));
    }
  };
  return { fetcher, asked };
}

function questions(count: number): Record<string, DecisionQuestion> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, { type: 'predicate', instructions: `Load context ${i}?` }]));
}

describe('decision batches', () => {
  it('splits questions in order by the cap, and keeps them whole without one', () => {
    expect(questionBatches(questions(5), 2).map((batch) => Object.keys(batch))).toEqual([['q0', 'q1'], ['q2', 'q3'], ['q4']]);
    expect(questionBatches(questions(5), undefined).map((batch) => Object.keys(batch))).toEqual([['q0', 'q1', 'q2', 'q3', 'q4']]);
    expect(questionBatches({}, 64)).toEqual([]);
  });

  it('asks an Ollama System One model 150 questions in calls of 64, which aeye refuses as one call', async () => {
    const { fetcher, asked } = fakeOllama();
    const ai = AI.with().providers({ ollama: new OllamaProvider({ fetch: fetcher }) }).create({});
    await ai.models.refresh();
    const model = ai.models.list().find((m) => m.id === 'nimble');
    expect(model?.maxQuestions).toBe(64);
    const all = questions(150);

    await expect(ai.decide.get({ input: 'the user asked about invoices', questions: all })).rejects.toBeInstanceOf(DecisionLimitError);
    expect(asked).toHaveLength(0);

    const decided = await decideInBatches(all, model?.maxQuestions, (batch) => ai.decide.get({ input: 'the user asked about invoices', questions: batch }));
    expect(asked.map((names) => names.length)).toEqual([64, 64, 22]);
    expect(asked.flat()).toEqual(Object.keys(all));
    expect(Object.keys(decided.answers)).toHaveLength(150);
    expect(decided.answers['q149']).toEqual({ type: 'predicate', probability: 0.649 });
    expect(decided.responses.map((response) => response.usage?.text?.output)).toEqual([64, 64, 22]);
  });
});

describe('the hub decider', () => {
  /** A decide role on `judge` (threshold 0.7) and a gateway serving it with a cap of 2, recording each call. */
  function decider(role: ModelRoleView = { role: 'decide', from: 'setting', choice: { role: 'decide', model: { model: 'judge' }, threshold: 0.7 }, resolved: { model: 'judge', provider: 'ollama' } }) {
    const calls: Array<{ names: string[]; metadata: unknown; site: ModelSite }> = [];
    const hub = new HubDecider({
      roles: {
        get: () => Promise.resolve(role),
        resolveModel: (_role, wanted) => Promise.resolve('model' in wanted.model ? { model: wanted.model.model, provider: 'openrouter' } : { problem: 'no such model' }),
      },
      llm: {
        models: () => Promise.resolve([
          { id: 'judge', provider: 'ollama', name: 'Judge', capabilities: ['decision'], maxQuestions: 2 },
          { id: 'other', provider: 'openrouter', name: 'Other', capabilities: ['decision'] },
        ]),
        decide: (input, site) => {
          calls.push({ names: Object.keys(input.questions), metadata: input.metadata, site });
          const answers = Object.fromEntries(Object.keys(input.questions).map((name) => [name, { type: 'predicate' as const, probability: 0.9 }]));
          return Promise.resolve({ value: { answers, model: 'judge' }, call: ModelCallId.parse(`mdl_${calls.length}`), cost: 0.5, model: 'judge' });
        },
      },
    });
    return { hub, calls };
  }

  it('uses the decide role\u2019s model with its threshold and question cap, or a job\u2019s own choice', async () => {
    const { hub } = decider();
    expect(await hub.model()).toEqual({ model: 'judge', provider: 'ollama', threshold: 0.7, maxQuestions: 2 });
    expect(await hub.model({ model: { model: 'other' } })).toEqual({ model: 'other', provider: 'openrouter', threshold: 0.7 });
    expect(await hub.model({ model: { category: 'x' } })).toEqual({ problem: 'no such model' });
    expect(await decider({ role: 'decide', from: 'none' }).hub.model()).toEqual({ problem: 'No decision model is set (an admin sets the Decide role).' });
    expect(await decider({ role: 'decide', from: 'setting', resolved: { problem: 'gone' } }).hub.model()).toEqual({ problem: 'gone' });
  });

  it('asks in calls of at most the cap, pinned to the model\u2019s provider, and sums what they cost', async () => {
    const { hub, calls } = decider();
    const model = await hub.model();
    if ('problem' in model) throw new Error(model.problem);
    const site: ModelSite = { purpose: 'test' };
    const decided = await hub.ask({ input: 'the user asked about invoices', questions: questions(5), model, site, signal: new AbortController().signal });
    expect(calls.map((c) => c.names)).toEqual([['q0', 'q1'], ['q2', 'q3'], ['q4']]);
    expect(calls.every((c) => JSON.stringify(c.metadata) === JSON.stringify({ model: 'judge', provider: 'ollama' }) && c.site === site)).toBe(true);
    expect(Object.keys(decided.answers)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
    expect(decided).toMatchObject({ calls: ['mdl_1', 'mdl_2', 'mdl_3'], cost: 1.5 });
  });
});
