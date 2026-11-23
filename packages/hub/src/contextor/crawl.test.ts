/**
 * `hub/ctx_crawl`'s walk (plan item 7) over a catalog of context, through the real hub decider (questions split by
 * the model's cap, each call's id kept): levels with imports always pulled, one question per `choices` link, the
 * threshold, the token budget, and each reason it stops.
 */
import { CRAWL_BATCH_MAX, ModelCallId, QualifiedName, type ContextChoice, type ModelRoleView } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { TestCatalog } from '../execution/testing.ts';
import { HubDecider } from '../models/decide.ts';
import type { DecisionModel, ModelSite } from '../models/index.ts';
import { ContextCrawler, crawlTokens, type CrawlPlan } from './crawl.ts';

const q = (name: string): QualifiedName => QualifiedName.parse(name);
/** 400 characters: 100 tokens at the default 4 characters per token. */
const TEXT = 'x'.repeat(400);
const SITE: ModelSite = { purpose: 'ctx_crawl' };

/** A catalog of `fs/` context, each 100 tokens, with the imports and choices given. */
function graph(items: Record<string, { imports?: string[]; choices?: Record<string, string>; content?: string }>): TestCatalog {
  const catalog = new TestCatalog();
  for (const [local, item] of Object.entries(items)) {
    const name = q(`fs/${local}`);
    catalog.contexts.set(name, item.content ?? TEXT);
    catalog.contextDecls.set(name, {
      imports: (item.imports ?? []).map((to) => q(`fs/${to}`)),
      choices: Object.entries(item.choices ?? {}).map(([to, when]): ContextChoice => ({ to: q(`fs/${to}`), when })),
    });
  }
  return catalog;
}

/**
 * The real hub decider over a gateway that answers each question with the probability given for the item it names
 * (`Load fs/x …`), 0 for the rest, or fails when `fail` is set. It records each call's questions and site.
 */
function decider(yes: Record<string, number>, options: { readonly fail?: boolean; readonly parallel?: number; readonly delay?: number } = {}) {
  const calls: Array<{ input: unknown; questions: string[]; site: ModelSite }> = [];
  const role: ModelRoleView = { role: 'decide', from: 'setting', choice: { role: 'decide', model: { model: 'judge' }, threshold: 0.5 }, resolved: { model: 'judge', provider: 'ollama' } };
  const hub = new HubDecider({
    roles: { get: () => Promise.resolve(role), resolveModel: () => Promise.resolve({ problem: 'not here' }) },
    llm: {
      models: () => Promise.resolve([]),
      decide: async (input, site) => {
        if (options.fail === true) throw new Error('the decision model is down');
        calls.push({ input: input.input, questions: Object.values(input.questions).map((question) => question.instructions), site });
        const call = ModelCallId.parse(`mdl_${calls.length}`);
        if (options.delay !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delay));
        const answers = Object.fromEntries(Object.entries(input.questions).map(([key, question]) => {
          const target = /^Load (\S+)/.exec(question.instructions)?.[1] ?? '';
          return [key, { type: 'predicate' as const, probability: yes[target] ?? 0 }];
        }));
        return { value: { answers, model: 'judge' }, call, cost: 0.01, model: 'judge' };
      },
    },
    ...(options.parallel === undefined ? {} : { parallel: options.parallel }),
  });
  return { hub, calls };
}

const MODEL: DecisionModel = { model: 'judge', provider: 'ollama', threshold: 0.5 };

function plan(start: string[], fields: Partial<CrawlPlan> = {}): CrawlPlan {
  return {
    start: start.map((local) => q(`fs/${local}`)), guidance: 'Declare a new kind.', maxDepth: 3, maxDecisions: 256, maxTokens: 10_000,
    model: MODEL, site: SITE, signal: new AbortController().signal, ...fields,
  };
}

function crawler(catalog: TestCatalog, decide: ReturnType<typeof decider>, usable: (name: string) => boolean = () => true): ContextCrawler {
  return new ContextCrawler({ catalog, decider: decide.hub, usable: (record) => Promise.resolve(usable(record.name)) });
}

describe('crawling context by decision', () => {
  it('walks level by level: imports always, a choice when the model says yes, most likely first', async () => {
    const catalog = graph({
      guide: { imports: ['guide.paths'], choices: { kinds: 'the task declares a kind', tables: 'the task makes tables' } },
      'guide.paths': {},
      kinds: { imports: ['kinds.payload'], choices: { 'kinds.examples': 'the kind needs examples' } },
      'kinds.payload': {},
      tables: {},
      'kinds.examples': {},
    });
    const decide = decider({ 'fs/kinds': 0.9, 'fs/tables': 0.2, 'fs/kinds.examples': 0.8 });
    const outcome = await crawler(catalog, decide).crawl(plan(['guide']));
    expect(outcome.taken.map(({ name, depth, via, from, probability }) => ({ name, depth, via, from, probability }))).toEqual([
      { name: 'fs/guide', depth: 0, via: 'start', from: undefined, probability: undefined },
      { name: 'fs/guide.paths', depth: 0, via: 'import', from: 'fs/guide', probability: undefined },
      { name: 'fs/kinds', depth: 1, via: 'choice', from: 'fs/guide', probability: 0.9 },
      { name: 'fs/kinds.payload', depth: 1, via: 'import', from: 'fs/kinds', probability: undefined },
      { name: 'fs/kinds.examples', depth: 2, via: 'choice', from: 'fs/kinds', probability: 0.8 },
    ]);
    expect(outcome.skipped).toEqual([{ context: 'fs/tables', from: 'fs/guide', depth: 1, reason: 'declined', probability: 0.2 }]);
    expect(outcome).toMatchObject({ stop: { reason: 'complete' }, depth: 2, decisions: 3, tokens: 500, calls: ['mdl_1', 'mdl_2'] });
    // one question per link, the guidance as the input once per call, on the crawl's site
    expect(decide.calls.map((call) => call.questions)).toEqual([
      ['Load fs/kinds (kinds) when: the task declares a kind?', 'Load fs/tables (tables) when: the task makes tables?'],
      ['Load fs/kinds.examples (kinds.examples) when: the kind needs examples?'],
    ]);
    expect(decide.calls.every((call) => call.input === 'Guidance: Declare a new kind.' && call.site === SITE)).toBe(true);
  });

  it('asks a level\'s questions in calls of at most the model\'s maxQuestions, and never more than 256 in one call', async () => {
    const five = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`c${i}`, `case ${i}`]));
    const capped = decider({});
    await crawler(graph({ hub: { choices: five }, ...Object.fromEntries(Object.keys(five).map((k) => [k, {}])) }), capped).crawl(plan(['hub'], { model: { ...MODEL, maxQuestions: 2 } }));
    expect(capped.calls.map((call) => call.questions.length)).toEqual([2, 2, 1]);

    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`c${i}`, `case ${i}`]));
    const uncapped = decider({});
    const outcome = await crawler(graph({ hub: { choices: many }, ...Object.fromEntries(Object.keys(many).map((k) => [k, {}])) }), uncapped).crawl(plan(['hub'], { maxDecisions: 4096 }));
    expect(uncapped.calls.map((call) => call.questions.length)).toEqual([CRAWL_BATCH_MAX, 300 - CRAWL_BATCH_MAX]);
    expect(outcome).toMatchObject({ decisions: 300, stop: { reason: 'complete' } });
    expect(outcome.skipped.every((skip) => skip.reason === 'declined')).toBe(true);
  });

  it('asks a level\'s batches together and reads its lookups at once, with the same outcome as one at a time', async () => {
    const many = Object.fromEntries(Array.from({ length: 3 * CRAWL_BATCH_MAX }, (_, i) => [`c${i}`, `case ${i}`]));
    const items = { hub: { choices: many }, ...Object.fromEntries(Object.keys(many).map((k, i) => [k, i % 7 === 0 ? { imports: [`c${(i + 1) % 30}`] } : {}])) };
    const yes = Object.fromEntries(Object.keys(many).filter((_, i) => i % 5 === 0).map((k, i) => [`fs/${k}`, 0.6 + (i % 4) / 10]));
    // the lookups answer out of order: later ones first
    const usable = (record: { name: string }) => new Promise<boolean>((resolve) => setTimeout(() => resolve(!record.name.endsWith('3')), record.name.length % 3));
    const run = async (parallel: number) => {
      const decide = decider(yes, { parallel, delay: 20 });
      const started = performance.now();
      const outcome = await new ContextCrawler({ catalog: graph(items), decider: decide.hub, usable }).crawl(plan(['hub'], { maxDecisions: 4096, maxTokens: 2_500 }));
      return { outcome, ms: performance.now() - started };
    };
    const one = await run(1);
    const three = await run(3);
    expect(three.outcome).toEqual(one.outcome);
    expect(one.outcome.calls).toEqual(['mdl_1', 'mdl_2', 'mdl_3']);
    expect(three.outcome.stop.reason).toBe('max-tokens');
    // three 20 ms calls side by side take about one call's time, not three
    expect(three.ms).toBeLessThan(one.ms);
  });

  it('takes a choice only at or above the decide role\'s threshold', async () => {
    const catalog = graph({ guide: { choices: { a: 'a', b: 'b', c: 'c' } }, a: {}, b: {}, c: {} });
    const outcome = await crawler(catalog, decider({ 'fs/a': 0.7, 'fs/b': 0.69, 'fs/c': 0.95 })).crawl(plan(['guide'], { model: { ...MODEL, threshold: 0.7 } }));
    expect(outcome.taken.map((item) => item.name)).toEqual(['fs/guide', 'fs/c', 'fs/a']);
    expect(outcome.skipped).toEqual([{ context: 'fs/b', from: 'fs/guide', depth: 1, reason: 'declined', probability: 0.69 }]);
  });

  it('stops at maxDepth, naming the links past the last level', async () => {
    const catalog = graph({ guide: { choices: { kinds: 'k' } }, kinds: { choices: { deeper: 'd' } }, deeper: {} });
    const outcome = await crawler(catalog, decider({ 'fs/kinds': 1, 'fs/deeper': 1 })).crawl(plan(['guide'], { maxDepth: 1 }));
    expect(outcome.taken.map((item) => item.name)).toEqual(['fs/guide', 'fs/kinds']);
    expect(outcome.skipped).toEqual([{ context: 'fs/deeper', from: 'fs/kinds', depth: 2, reason: 'max-depth' }]);
    expect(outcome.stop).toEqual({ reason: 'max-depth' });
    // depth 0: the starting context and its imports only, no question asked
    const flat = decider({});
    const zero = await crawler(graph({ guide: { imports: ['paths'], choices: { kinds: 'k' } }, paths: {}, kinds: {} }), flat).crawl(plan(['guide'], { maxDepth: 0 }));
    expect(zero).toMatchObject({ stop: { reason: 'max-depth' }, decisions: 0, depth: 0 });
    expect(zero.taken.map((item) => item.name)).toEqual(['fs/guide', 'fs/paths']);
    expect(flat.calls).toEqual([]);
  });

  it('stops at maxDecisions, skipping the links it had no questions left for', async () => {
    const catalog = graph({ guide: { choices: { a: 'a', b: 'b', c: 'c' } }, a: { choices: { d: 'd' } }, b: {}, c: {}, d: {} });
    const decide = decider({ 'fs/a': 0.9, 'fs/b': 0.9, 'fs/c': 0.9, 'fs/d': 0.9 });
    const outcome = await crawler(catalog, decide).crawl(plan(['guide'], { maxDecisions: 2 }));
    expect(outcome.taken.map((item) => item.name)).toEqual(['fs/guide', 'fs/a', 'fs/b']);
    expect(outcome.skipped).toEqual([{ context: 'fs/c', from: 'fs/guide', depth: 1, reason: 'max-decisions' }]);
    expect(outcome).toMatchObject({ stop: { reason: 'max-decisions' }, decisions: 2 });
    expect(decide.calls.flatMap((call) => call.questions)).toHaveLength(2);
  });

  it('stops at maxTokens: a yes that does not fit (with its imports) is skipped, a smaller one after it still loads', async () => {
    const catalog = graph({
      guide: { choices: { big: 'b', small: 's' } },
      big: { imports: ['big.more'] },
      'big.more': {},
      small: { choices: { next: 'n' } },
      next: {},
    });
    const outcome = await crawler(catalog, decider({ 'fs/big': 0.95, 'fs/small': 0.6, 'fs/next': 1 })).crawl(plan(['guide'], { maxTokens: 250 }));
    expect(outcome.taken.map((item) => item.name)).toEqual(['fs/guide', 'fs/small']);
    expect(outcome.skipped).toEqual([{ context: 'fs/big', from: 'fs/guide', depth: 1, reason: 'max-tokens', probability: 0.95 }]);
    expect(outcome).toMatchObject({ stop: { reason: 'max-tokens' }, tokens: 200 });
    // a starting item that does not fit is skipped the same way
    const tight = await crawler(graph({ guide: { imports: ['paths'] }, paths: {} }), decider({})).crawl(plan(['guide'], { maxTokens: 150 }));
    expect(tight).toMatchObject({ taken: [], skipped: [{ context: 'fs/guide', depth: 0, reason: 'max-tokens' }], stop: { reason: 'max-tokens' }, tokens: 0 });
  });

  it('skips a link to an item the asker can\'t load without asking, and keeps what it took when the model fails', async () => {
    const catalog = graph({ guide: { choices: { secret: 's', gone: 'g', kinds: 'k' } }, secret: {}, kinds: {} });
    const decide = decider({ 'fs/kinds': 0.9 });
    const outcome = await crawler(catalog, decide, (name) => name !== 'fs/secret').crawl(plan(['guide']));
    expect(outcome.skipped).toEqual([
      { context: 'fs/secret', from: 'fs/guide', depth: 1, reason: 'unavailable' },
      { context: 'fs/gone', from: 'fs/guide', depth: 1, reason: 'unavailable' },
    ]);
    expect(decide.calls.flatMap((call) => call.questions)).toEqual(['Load fs/kinds (kinds) when: k?']);

    const failed = await crawler(catalog, decider({}, { fail: true })).crawl(plan(['guide']));
    expect(failed.stop).toEqual({ reason: 'failed', detail: 'the decision model is down' });
    expect(failed.taken.map((item) => item.name)).toEqual(['fs/guide']);
    expect(failed.skipped.filter((skip) => skip.reason === 'failed').map((skip) => skip.context)).toEqual(['fs/secret', 'fs/kinds']);
  });

  it('throws when its run is cancelled during a decide call, rather than reporting a failed crawl', async () => {
    const catalog = graph({ guide: { choices: { kinds: 'k' } }, kinds: {} });
    const cancel = new AbortController();
    cancel.abort();
    await expect(crawler(catalog, decider({}, { fail: true })).crawl(plan(['guide'], { signal: cancel.signal }))).rejects.toThrow('the decision model is down');
  });

  it('sizes dynamic context by its summary until its system writes it', () => {
    expect(crawlTokens({ decl: { name: 'x', description: 'twelve chars', content: TEXT, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', tags: [] } })).toBe(100);
    expect(crawlTokens({ decl: { name: 'x', description: 'twelve chars', imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', tags: [] } })).toBe(3);
  });
});
