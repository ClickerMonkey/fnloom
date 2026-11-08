/**
 * Live: the graph contextor and the static toolset on a small local model (Ollama's `qwen2.5:3b`), at the window
 * Ollama really serves it with (read from `/api/show`: its `num_ctx`, else Ollama's default). Forty context items of
 * about 500 tokens each and a 30-exchange session are far more than the window; five messages each get a fresh prompt
 * that must stay within the budget, as the hub estimates it and as Ollama counts it, and the one item that answers a
 * question must be chosen. Then the static toolset runs a fn the model names through `run`. Skipped when Ollama or
 * the model isn't there. Run with `npm run test:live`.
 */
import { agent, fn, g, hub } from '@harness/sdk';
import { OLLAMA_BASE_URL, type LlmMessage, type RunSettled } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT, ALICE, executionRig, SESSION, testSettings, type ExecutionRig } from '../execution/testing.ts';
import { replyText } from '../execution/wire.ts';
import { budgetPlan } from './budget.ts';
import { createContextor } from './create.ts';
import { contextorEnv } from './env.ts';
import { registerContextorFns } from './fns.ts';
import { OllamaProvider } from './ollama.ts';
import { wordShare, words } from './score.ts';
import { FixedSearch, sessionLoader } from './testing.ts';
import { CatalogFnViews } from './views.ts';

const BASE_URL = process.env['HARNESS_OLLAMA_URL'] ?? OLLAMA_BASE_URL;
/** The small model the graph contextor is proven on (`HARNESS_LIVE_GRAPH_MODEL` names another, e.g. `deepseek-r1:7b`). */
const MODEL = process.env['HARNESS_LIVE_GRAPH_MODEL'] ?? 'qwen2.5:3b';

/** Whether Ollama answers and has the model. */
async function ollamaHas(model: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && 'models' in body && Array.isArray(body.models)
      && body.models.some((m: unknown) => typeof m === 'object' && m !== null && 'name' in m && m.name === model);
  } catch {
    return false;
  }
}
const ready = await ollamaHas(MODEL);
/**
 * The model the text protocol is proven on: `qwen2.5:3b` told to use it (fast), or a model without native tools such
 * as `deepseek-r1:7b` when `HARNESS_LIVE_TEXT_MODEL` names one (slow on a CPU: it thinks before every answer).
 */
const TEXT_MODEL = process.env['HARNESS_LIVE_TEXT_MODEL'] ?? MODEL;
const textReady = await ollamaHas(TEXT_MODEL);

const SUBJECTS = [
  'lighthouse', 'orchard', 'glacier', 'violin', 'harbor', 'canyon', 'meadow', 'comet', 'bakery', 'library', 'volcano', 'garden', 'subway', 'castle', 'desert',
  'forest', 'island', 'market', 'museum', 'river', 'tunnel', 'bridge', 'carnival', 'factory', 'prairie', 'reef', 'temple', 'tower', 'valley', 'vineyard',
  'workshop', 'airport', 'aquarium', 'brewery', 'cathedral', 'dockyard', 'fortress', 'greenhouse', 'moon',
] as const;

/** About 2,000 characters of notes on a subject. */
function notes(subject: string): string {
  return Array.from({ length: 14 }, (_, i) => `The ${subject} note ${i + 1} records a routine observation of the ${subject} with nothing unusual found.`).join(' ');
}

/** A 30-exchange session about other things. */
function pastTalk(): LlmMessage[] {
  return Array.from({ length: 30 }, (_, i): LlmMessage[] => [
    { role: 'user', content: `What did the weekly report ${i} say about staffing?` },
    { role: 'assistant', content: `Report ${i} said staffing was steady and no changes were planned that week.` },
  ]).flat();
}

const textual = agent({
  description: 'Answers with the static toolset over the text protocol.', args: g.obj({}), returns: g.text(), tools: [], maxIterations: 5,
  instructions: 'You are a helpful assistant. Answer in one short sentence. Use a tool when the answer needs one.',
  mode: { type: 'static', protocol: 'text' }, contextor: { type: 'graph' },
});
const small = agent({
  description: 'Answers with the static toolset and the graph contextor.', args: g.obj({}), returns: g.text(), tools: [], maxIterations: 5,
  instructions: 'You are a helpful assistant. Answer in one short sentence, using the context you are given. Call a tool only when the answer needs one.',
  mode: { type: 'static' }, contextor: { type: 'graph' },
});

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

/** The rig on Ollama, with the items, the session, the contextor's hub fns and a connected fs. */
async function onOllama(model: string = MODEL, transcript: LlmMessage[] = pastTalk(), agentName: 'tools/small' | 'tools/textual' = 'tools/small') {
  const provider = new OllamaProvider({ baseURL: BASE_URL });
  const models = await provider.listModels();
  const search = new FixedSearch();
  const r = await executionRig({ settings: testSettings({ HARNESS_TOOL_TIMEOUT: 120_000 }, {}, model), llm: { providers: { ollama: provider }, models }, search });
  rig = r;
  for (const subject of SUBJECTS) r.catalog.contexts.set(`facts/${subject}`, notes(subject));
  r.catalog.contexts.set('facts/zebra-code', `The zebra code is 7351. It opens the north gate. ${notes('gate').slice(0, 1_800)}`);
  search.hits = (text) => {
    const query = words(text);
    return [...r.catalog.contexts.entries()]
      .map(([key, content]) => ({ kind: 'context' as const, key, score: wordShare(query, `${key.replace(/[/-]/g, ' ')} ${content.slice(0, 200)}`) ?? 0, text: content.slice(0, 200) }))
      .filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  };
  r.catalog.add('fs', 'read', fn({ description: 'Read a text file and give its lines.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] }));
  r.catalog.add('tools', 'small', small);
  r.catalog.add('tools', 'textual', textual);
  for (const name of ['find', 'inspect', 'load', 'unload'] as const) r.catalog.add('hub', name, hub.defs.fns[name]);
  const contextor = createContextor({
    store: r.store, catalog: r.catalog, search, settings: contextorEnv.parse(), modelSettings: { HARNESS_DEFAULT_MODEL: model }, models: () => r.module.llm.models(),
    log: r.log, clock: () => r.time.now, probes: () => undefined,
  });
  registerContextorFns(r.module.hubFns, {
    store: () => r.store, catalog: () => r.catalog, search: () => search, sessions: () => sessionLoader(r.store),
    contextor: () => contextor, views: () => new CatalogFnViews(r.catalog),
  });
  const fs = r.connect('fs');
  fs.behaviour.run = () => Promise.resolve({ status: 'done', result: 'line one\nline two\nline three' });
  await r.module.start();
  await r.session({ agent: agentName, transcript });
  const limits = await contextor.limits.resolve(model);
  const plan = budgetPlan(limits.limits, 0, contextorEnv.parse().HARNESS_PROMPT_MARGIN);
  const ask = async (text: string): Promise<{ settled: RunSettled; run: string }> => {
    const turn = await r.turn({ session: SESSION, text });
    const { run } = await r.module.agents.start({
      kind: 'hub/llm', fn: agentName, args: {}, turn: turn.id, session: SESSION, key: 'answer', actor: ALICE, caller: AGENT, priority: 'interactive', background: false, handlers: [],
    });
    return { settled: await r.module.runs.wait(run), run };
  };
  return { r, fs, ask, limits, plan };
}

describe.skipIf(!ready)('the graph contextor and the static toolset on a small local model (live)', () => {
  it('keeps five fresh prompts inside the served window and finds the one item that answers', { timeout: 900_000 }, async () => {
    const { r, ask, limits, plan } = await onOllama();
    console.info('live.ollama.limits', { model: MODEL, limits: limits.limits, sources: limits.sources, budget: plan.available });
    const questions = [
      'What is the zebra code?',
      'Tell me about the lighthouse notes.',
      'What did weekly report 7 say about staffing?',
      'Summarize the moon notes in a few words.',
      'Thanks, that is all.',
    ];
    const answers: string[] = [];
    for (const question of questions) {
      const { settled, run } = await ask(question);
      expect(settled.status, settled.status === 'failed' ? settled.error.message : '').toBe('done');
      answers.push(settled.status === 'done' ? replyText(settled.result) : '');
      const interactions = (await r.store.table('llmInteractions').find({ where: { run }, limit: 10 })).items;
      expect(interactions.length).toBeGreaterThan(0);
      for (const interaction of interactions) {
        expect(interaction.selection?.budget.estimate).toBeLessThanOrEqual(plan.available);
        expect(interaction.usage?.input ?? 0).toBeLessThanOrEqual(limits.limits.contextWindow - limits.limits.maxOutputTokens);
      }
      console.info('live.ollama.turn', {
        question, answer: answers.at(-1), calls: interactions.length,
        estimate: interactions.map((i) => i.selection?.budget.estimate), measured: interactions.map((i) => i.usage?.input),
        context: interactions[0]?.selection?.context.map((c) => `${c.name}:${c.detail}`),
      });
    }
    const first = (await r.store.table('llmInteractions').find({ limit: 50 })).items.find((i) => i.selection?.context.some((c) => c.name === 'facts/zebra-code'));
    expect(first, 'the zebra item was chosen for the zebra question').toBeDefined();
    expect(answers[0]).toContain('7351');
    expect(r.records.some((rec) => rec.msg === 'agent.forget')).toBe(false);
  });

  it('runs a fn the model names through the static toolset\'s run', { timeout: 600_000 }, async () => {
    const { fs, ask } = await onOllama();
    let answer = '';
    for (let attempt = 0; attempt < 3 && fs.requests.length === 0; attempt++) {
      const { settled } = await ask('How many lines does README.md have? Use fs/read with the path README.md, then tell me the number.');
      answer = settled.status === 'done' ? replyText(settled.result) : settled.status === 'failed' ? settled.error.message : settled.status;
    }
    expect(fs.requests.map((q) => [q.fn, q.args])).toContainEqual(['read', { path: 'README.md' }]);
    console.info('live.ollama.static-run', { answer });
    expect(answer).toMatch(/3|three/i);
  });
});

describe.skipIf(!textReady)('the text protocol on a local model (live)', () => {
  it('runs fs/read from a <run> block and answers with the number', { timeout: 1_800_000 }, async () => {
    const { r, fs, ask, plan } = await onOllama(TEXT_MODEL, [], 'tools/textual');
    let answer = '';
    for (let attempt = 0; attempt < 2 && fs.requests.length === 0; attempt++) {
      const { settled } = await ask('How many lines does README.md have? Run fs/read with the path README.md to find out.');
      answer = settled.status === 'done' ? replyText(settled.result) : settled.status === 'failed' ? settled.error.message : settled.status;
    }
    const interactions = (await r.store.table('llmInteractions').find({ limit: 50 })).items;
    console.info('live.ollama.text-protocol', { answer: answer.slice(-300), calls: interactions.length, estimate: interactions.map((i) => i.selection?.budget.estimate), available: plan.available });
    expect(interactions.every((i) => (i.request.tools ?? []).length === 0)).toBe(true);
    expect(fs.requests.map((q) => q.fn)).toContain('read');
    for (const interaction of interactions) expect(interaction.selection?.budget.estimate).toBeLessThanOrEqual(plan.available);
  });
});
