/**
 * Splitting decision questions by the model's `maxQuestions` and `maxRequestBytes`, through aeye and `@aeye/ollama` against a fake Ollama
 * that lists a System One model: aeye refuses an over-cap call, and `decideInBatches` asks it in calls the model takes.
 */
import { AI, DecisionLimitError, type DecisionQuestion } from '@aeye/ai';
import { OllamaProvider } from '@aeye/ollama';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelCallId, type ModelRoleView } from '@harness/core';
import { decideInBatches, decisionInputBytes, HubDecider, questionBatches } from './decide.ts';
import type { DecisionModel, ModelSite } from './index.ts';

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
    expect(questionBatches(questions(5), { maxQuestions: 2 }).map((batch) => Object.keys(batch))).toEqual([['q0', 'q1'], ['q2', 'q3'], ['q4']]);
    expect(questionBatches(questions(5), {}).map((batch) => Object.keys(batch))).toEqual([['q0', 'q1', 'q2', 'q3', 'q4']]);
    expect(questionBatches({}, { maxQuestions: 64 })).toEqual([]);
  });

  it('splits by bytes of input and questions too, each batch within the cap, and refuses a question that never fits', () => {
    const all = questions(5);
    // each question is {"qN":{"type":"predicate","instructions":"Load context N?"}}, 56 bytes with its comma
    const one = JSON.stringify({ q0: all['q0'] }).length - 1;
    const input = 'x'.repeat(100);
    const limits = { maxRequestBytes: 100 + 2 + one * 2 };
    const batches = questionBatches(all, limits, decisionInputBytes(input));
    expect(batches.map((batch) => Object.keys(batch))).toEqual([['q0', 'q1'], ['q2', 'q3'], ['q4']]);
    for (const batch of batches) { expect(decisionInputBytes(input) + JSON.stringify(batch).length).toBeLessThanOrEqual(limits.maxRequestBytes); }
    // both caps: the tighter one wins
    expect(questionBatches(all, { ...limits, maxQuestions: 1 }, decisionInputBytes(input)).map((batch) => Object.keys(batch))).toEqual([['q0'], ['q1'], ['q2'], ['q3'], ['q4']]);
    // a conversation counts as its JSON, and text by its UTF-8 bytes
    expect(decisionInputBytes([{ role: 'user', content: 'hi' }])).toBe(JSON.stringify([{ role: 'user', content: 'hi' }]).length);
    expect(decisionInputBytes('é')).toBe(2);
    expect(() => questionBatches(all, { maxRequestBytes: 100 + one }, decisionInputBytes(input), 'nimble')).toThrow(DecisionLimitError);
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

    const decided = await decideInBatches(all, { input: 'the user asked about invoices', ...(model?.maxQuestions === undefined ? {} : { maxQuestions: model.maxQuestions }) }, (batch) => ai.decide.get({ input: 'the user asked about invoices', questions: batch }));
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
          { id: 'judge', provider: 'ollama', name: 'Judge', capabilities: ['decision'], maxQuestions: 2, maxRequestBytes: 4_096 },
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
    expect(await hub.model()).toEqual({ model: 'judge', provider: 'ollama', threshold: 0.7, maxQuestions: 2, maxRequestBytes: 4_096 });
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

  it('asks up to `parallel` calls at once, keeping answers, calls and cost in batch order however they finish', async () => {
    let running = 0;
    let most = 0;
    const role: ModelRoleView = { role: 'decide', from: 'setting', choice: { role: 'decide', model: { model: 'judge' }, threshold: 0.7 }, resolved: { model: 'judge', provider: 'ollama' } };
    const hub = new HubDecider({
      roles: { get: () => Promise.resolve(role), resolveModel: () => Promise.resolve({ problem: 'not here' }) },
      llm: {
        models: () => Promise.resolve([]),
        decide: async (input) => {
          const names = Object.keys(input.questions);
          running += 1;
          most = Math.max(most, running);
          // the first batch is the slowest: the later ones finish before it
          await new Promise((resolve) => setTimeout(resolve, names.includes('q0') ? 30 : 5));
          running -= 1;
          const answers = Object.fromEntries(names.map((name) => [name, { type: 'predicate' as const, probability: 0.9 }]));
          return { value: { answers, model: 'judge' }, call: ModelCallId.parse(`mdl_${names[0]}`), cost: names.length, model: 'judge' };
        },
      },
      parallel: 2,
    });
    const model: DecisionModel = { model: 'judge', provider: 'ollama', threshold: 0.7, maxQuestions: 2 };
    const decided = await hub.ask({ input: 'the user asked about invoices', questions: questions(7), model, site: { purpose: 'test' }, signal: new AbortController().signal });
    expect(most).toBe(2);
    expect(Object.keys(decided.answers)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
    expect(decided).toMatchObject({ calls: ['mdl_q0', 'mdl_q2', 'mdl_q4', 'mdl_q6'], cost: 7 });
  });

  it('fails the decision with the first call that fails', async () => {
    const decided = decideInBatches(questions(4), { input: 'x', maxQuestions: 1 }, async (batch) => {
      if ('q1' in batch) throw new Error('the model is down');
      return { answers: {}, model: 'judge' };
    }, 4);
    await expect(decided).rejects.toThrow('the model is down');
  });

  it('asks in calls within the model’s bytes too, keeping every call', async () => {
    const { hub, calls } = decider();
    const model = await hub.model();
    if ('problem' in model) throw new Error(model.problem);
    // a long input leaves room for one question per call under the model's 4 KiB
    const input = 'x'.repeat(4_096 - 2 - 60);
    const decided = await hub.ask({ input, questions: questions(3), model, site: { purpose: 'test' }, signal: new AbortController().signal });
    expect(calls.map((c) => c.names)).toEqual([['q0'], ['q1'], ['q2']]);
    expect(decided.calls).toEqual(['mdl_1', 'mdl_2', 'mdl_3']);
  });
});
