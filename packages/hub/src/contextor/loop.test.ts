/**
 * The chat modes and contextors in the agent loop: the execution rig's real loop, runs and scripted model, with the
 * real planner over the rig's store and catalog.
 */
import type { Message, Request } from '@aeye/core';
import { agent, fn, g, hub } from '@harness/sdk';
import { ActorId, type LlmMessage, type LlmRequest, type RunId, type RunSettled, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_KIND, type AgentKind, type RunInput } from '../execution/index.ts';
import { messageToWire, requestToWire } from '../execution/wire.ts';
import {
  AGENT, ALICE, calls, executionRig, says, ScriptedProvider, SESSION, TEST_MODEL, type ExecutionRig,
} from '../execution/testing.ts';
import { createContextor } from './create.ts';
import { contextorEnv } from './env.ts';
import { registerContextorFns } from './fns.ts';
import { RUN_TAG } from './render.ts';
import { FixedSearch, sessionLoader } from './testing.ts';
import { textOf } from './history.ts';
import { CALIBRATION, Estimator } from './tokens.ts';
import { CatalogFnViews } from './views.ts';

const readDef = fn({
  description: 'Read a text file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'],
  examples: [{ args: { path: 'README.md' } }],
});
const grepDef = fn({ description: 'Search files for a pattern.', args: g.obj({ pattern: g.text() }), returns: g.text(), tags: ['read'] });
const instructions = 'Be helpful.';
const toolsAgent = agent({ description: 'Helps.', args: g.obj({}), returns: g.text(), instructions, tools: [], maxIterations: 6 });
const staticAgent = agent({ description: 'Helps small.', args: g.obj({}), returns: g.text(), instructions, tools: [], maxIterations: 6, mode: { type: 'static' } });
const graphAgent = agent({ description: 'Graph.', args: g.obj({}), returns: g.text(), instructions, tools: [], maxIterations: 6, contextor: { type: 'graph' } });

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

/** The rig with fs/read, fs/grep, three agents, the contextor's hub fns, and fs connected. */
async function started(options: Parameters<typeof executionRig>[0] = {}) {
  const r = await executionRig(options);
  rig = r;
  r.catalog.add('fs', 'read', readDef);
  r.catalog.add('fs', 'grep', grepDef);
  r.catalog.add('tools', 'helper', toolsAgent);
  r.catalog.add('tools', 'small', staticAgent);
  r.catalog.add('tools', 'graph', graphAgent);
  for (const name of ['find', 'inspect', 'load', 'unload'] as const) r.catalog.add('hub', name, hub.defs.fns[name]);
  const search = new FixedSearch();
  const contextor = createContextor({
    store: r.store, catalog: r.catalog, search, settings: contextorEnv.parse(), modelSettings: { HARNESS_DEFAULT_MODEL: 'test-model' }, models: () => r.module.llm.models(),
    log: r.log, clock: () => r.time.now, probes: () => undefined,
  });
  registerContextorFns(r.module.hubFns, {
    store: () => r.store, catalog: () => r.catalog, search: () => search, sessions: () => sessionLoader(r.store),
    contextor: () => contextor, views: () => new CatalogFnViews(r.catalog),
  });
  const fs = r.connect('fs');
  fs.behaviour.run = (request) => Promise.resolve({ status: 'done', result: request.fn === 'read' ? 'line 1\nline 2\nline 3' : 'no match' });
  await r.module.start();
  return { r, fs, search };
}

function agentInput(turn: Turn, fnName: RunInput['fn']): RunInput & { kind: AgentKind } {
  return {
    kind: AGENT_KIND, fn: fnName, args: {}, turn: turn.id, key: 'answer', actor: ALICE, caller: AGENT, priority: 'interactive', background: false, handlers: [],
    ...(turn.session === undefined ? {} : { session: turn.session }),
  };
}

async function answer(r: ExecutionRig, agentName: RunInput['fn'], text: string): Promise<{ settled: RunSettled; run: RunId }> {
  const turn = await r.turn({ session: SESSION, text });
  const { run } = await r.module.agents.start(agentInput(turn, agentName));
  return { settled: await r.module.runs.wait(run), run };
}

/** A message's text, from a saved message or one aeye sent. */
function say(message: LlmMessage | undefined): string {
  return message === undefined ? '' : textOf(message);
}

/** The text of a message aeye sent. */
function aeyeText(message: Message | undefined): string {
  return message === undefined ? '' : textOf(messageToWire(message));
}

/** What a request sent, as the hub estimates it with a model's limits. */
function estimateOf(request: LlmRequest, limits: { contextWindow: number; maxOutputTokens: number }, ratio: number): number {
  const estimator = new Estimator('test-model', { ...limits, reasoningTokens: 0, charsPerToken: 4 }, ratio);
  return estimator.messages(request.messages) + (request.tools ?? []).reduce((sum, tool) => sum + estimator.tool(tool), 0);
}

/**
 * Replies that copy each request as it arrives (aeye goes on to add the answer to the request's own messages, so
 * the provider's kept requests show more than was sent), with the model's calibration ratio at that moment when a rig
 * is given (each call's measured tokens move it).
 */
function sent(provider: ScriptedProvider, replies: ReadonlyArray<ReturnType<typeof says>>, rig?: ExecutionRig) {
  const requests: LlmRequest[] = [];
  const ratios: number[] = [];
  return {
    requests,
    ratios,
    replies: replies.map((chunks) => async () => {
      const request: Request | undefined = provider.requests.at(-1);
      if (request !== undefined) requests.push(structuredClone(requestToWire(request)));
      ratios.push((await rig?.store.table('modelCalibration').get('test-model'))?.ratio ?? CALIBRATION.start);
      return chunks;
    }),
  };
}

/** A transcript of exchanges of a question and an answer. */
function longTranscript(exchanges: number, chars = 300): LlmMessage[] {
  return Array.from({ length: exchanges }, (_, i): LlmMessage[] => [
    { role: 'user', content: `Question ${i}: ${'q'.repeat(chars / 2)}` },
    { role: 'assistant', content: `Answer ${i}. ${'a'.repeat(chars)}. Done.` },
  ]).flat();
}

describe('tools mode with the plain contextor (build 1)', () => {
  it('sends the transcript, the loaded fns as tools and the context after the instructions, with maxTokens set', async () => {
    const { r } = await started();
    r.catalog.contexts.set('fs/guide', 'Use fs/read for files.');
    await r.session({ agent: 'tools/helper', tools: ['fs/read'], context: ['fs/guide'] });
    const { requests, replies } = sent(r.provider, [says('Hi.')]);
    r.provider.script(...replies);
    const { settled } = await answer(r, 'tools/helper', 'Hello?');
    expect(settled).toEqual({ status: 'done', result: 'Hi.' });
    const [request] = requests;
    expect(request?.tools?.map((t) => t.name)).toEqual(['fs__read']);
    expect(request?.messages).toEqual([
      { role: 'system', content: `${instructions}\n\n<context name="fs/guide">\nUse fs/read for files.\n</context>` },
      { role: 'user', content: 'Hello?' },
    ]);
    expect(request?.maxTokens).toBe(1_024);
    const [interaction] = (await r.store.table('llmInteractions').find({ limit: 5 })).items;
    expect(interaction?.selection).toMatchObject({ mode: 'tools', contextor: 'plain', fns: [{ name: 'fs/read', detail: 'signature' }], context: [{ name: 'fs/guide', detail: 'full' }] });
  });

  it('loads the fns a person names into the turn\'s tools (carry-over C1)', async () => {
    const { r } = await started();
    await r.session({ agent: 'tools/helper' });
    r.provider.script(calls([['fs__grep', { pattern: 'x' }]]), says('No match.'));
    const { settled } = await answer(r, 'tools/helper', 'run fs/grep for x please');
    expect(settled).toEqual({ status: 'done', result: 'No match.' });
    expect(r.provider.requests[0]?.tools?.map((t) => t.name)).toEqual(['fs__grep']);
  });
});

describe('the static toolset', () => {
  it('sends exactly the five tools, shows loaded fns as cards, and runs the fn run() names, not a wrapper', async () => {
    const { r, fs } = await started();
    await r.session({ agent: 'tools/small', tools: ['fs/read'] });
    r.provider.script(calls([['run', { fn: 'fs/read', args: { path: 'README.md' } }]]), says('It has 3 lines.'));
    const { settled, run } = await answer(r, 'tools/small', 'How many lines does README.md have?');
    expect(settled).toEqual({ status: 'done', result: 'It has 3 lines.' });
    const first = r.provider.requests[0];
    expect(first?.tools?.map((t) => t.name)).toEqual(['find', 'inspect', 'load', 'unload', 'run']);
    const system = aeyeText(first?.messages[0]);
    expect(system).toContain('## Loaded fns');
    expect(system).toContain('### fs/read — Read a text file.');
    expect(system).toContain('run({ fn: "fs/read", args:');
    expect(fs.requests.map((q) => [q.fn, q.args])).toEqual([['read', { path: 'README.md' }]]);
    const child = (await r.store.table('runs').find({ where: { parent: run }, limit: 5 })).items[0];
    expect(child).toMatchObject({ fn: 'fs/read', status: 'done', toolCallId: 'call_1' });
  });

  it('answers args that don\'t fit with the fn\'s card and an unknown fn with a hint, and runs neither', async () => {
    const { r, fs } = await started();
    await r.session({ agent: 'tools/small' });
    r.provider.script(
      calls([['run', { fn: 'fs/read', args: { file: 'README.md' } }]]),
      calls([['run', { fn: 'fs/reed', args: { path: 'README.md' } }]]),
      says('Sorry.'),
    );
    const { settled, run } = await answer(r, 'tools/small', 'Read README.md');
    expect(settled).toEqual({ status: 'done', result: 'Sorry.' });
    expect(fs.requests).toEqual([]);
    // the fn the model named is a run settled invalid-input with the args it gave; the unknown fn is no run at all
    expect((await r.store.table('runs').find({ where: { parent: run }, limit: 5 })).items.map((child) => [child.fn, child.status, child.args])).toEqual([
      ['fs/read', 'invalid-input', { file: 'README.md' }],
    ]);
    const transcript = (await r.store.table('sessions').get(SESSION))?.transcript ?? [];
    const replies = transcript.filter((m) => m.role === 'tool').map((m) => say(m));
    expect(replies[0]).toContain('The args don\'t fit fs/read');
    expect(replies[0]).toContain('Example: run({ fn: "fs/read", args: {"path":"README.md"} })');
    expect(replies[1]).toContain('There is no fn fs/reed you can run here.');
    expect(r.records.filter((rec) => rec.msg === 'agent.invalid-input')).toHaveLength(2);
  });

  it('shows a fn loaded with load as a card on the next iteration', async () => {
    const { r } = await started();
    await r.session({ agent: 'tools/small' });
    r.provider.script(calls([['load', { names: ['fs/grep'] }]]), says('Loaded.'));
    await answer(r, 'tools/small', 'Get grep ready');
    expect(aeyeText(r.provider.requests[0]?.messages[0])).not.toContain('### fs/grep');
    expect(aeyeText(r.provider.requests[1]?.messages[0])).toContain('### fs/grep — Search files for a pattern.');
    expect((await r.store.table('sessions').get(SESSION))?.tools).toEqual(['fs/grep']);
  });

  it('ends a run\'s reply with the cards of the fns it exposed', async () => {
    const { r, fs } = await started();
    fs.behaviour.run = () => Promise.resolve({ status: 'done', result: 'found 2', expose: [{ fn: 'fs/read', detail: 'signature' }] });
    await r.session({ agent: 'tools/small' });
    r.provider.script(calls([['run', { fn: 'fs/grep', args: { pattern: 'x' } }]]), says('Found two.'));
    await answer(r, 'tools/small', 'grep for x');
    const reply = (await r.store.table('sessions').get(SESSION))?.transcript.find((m) => m.role === 'tool');
    expect(say(reply)).toBe(`found 2\n\n### fs/read — Read a text file.\nrun({ fn: "fs/read", args: obj{path: text} }) → text`);
  });

  it('speaks the text protocol to a model without tools: blocks become runs, results come back as text, blocks never stream', async () => {
    const provider = new ScriptedProvider();
    const noTools = { ...TEST_MODEL, id: 'plain-model', capabilities: new Set(['chat', 'streaming'] as const) };
    const { r, fs } = await started({ llm: { providers: { openrouter: provider }, models: [noTools] } });
    await r.session({ agent: 'tools/small', model: { model: 'plain-model' } });
    const { requests, replies } = sent(provider, [says(`I will read it.\n<${RUN_TAG} fn="fs/read">{"path": "README.md"}</${RUN_TAG}>`), says('It has 3 lines.')]);
    provider.script(...replies);
    const { settled } = await answer(r, 'tools/small', 'How many lines does README.md have?');
    expect(settled).toEqual({ status: 'done', result: 'It has 3 lines.' });
    expect(requests[0]?.tools ?? []).toEqual([]);
    expect(say(requests[0]?.messages[0])).toContain('To use a tool, write a block');
    expect(fs.requests.map((q) => q.args)).toEqual([{ path: 'README.md' }]);
    const streamed = r.chat.streamed.map((s) => s.text ?? '').join('');
    expect(streamed).toContain('I will read it.');
    expect(streamed).not.toContain('<run');
    const result = requests[1]?.messages.at(-1);
    expect(result).toMatchObject({ role: 'user' });
    expect(say(result)).toBe('<result fn="fs/read" status="done">\nline 1\nline 2\nline 3\n</result>');
  });

  it('answers a block with bad JSON as invalid input, softly', async () => {
    const provider = new ScriptedProvider();
    const noTools = { ...TEST_MODEL, id: 'plain-model', capabilities: new Set(['chat', 'streaming'] as const) };
    const { r, fs } = await started({ llm: { providers: { openrouter: provider }, models: [noTools] } });
    await r.session({ agent: 'tools/small', model: { model: 'plain-model' } });
    const { requests, replies } = sent(provider, [says('<run fn="fs/read">{path: README.md}</run>'), says('Oops.')]);
    provider.script(...replies);
    const { settled } = await answer(r, 'tools/small', 'Read it');
    expect(settled).toEqual({ status: 'done', result: 'Oops.' });
    expect(fs.requests).toEqual([]);
    expect(say(requests[1]?.messages.at(-1))).toMatch(/^<result fn="fs\/read" status="invalid-input">\nThe args of that fs\/read block are not JSON/);
  });
});

describe('budgets in the loop', () => {
  const LIMITS = { contextWindow: 2_048, maxOutputTokens: 256 };
  const B = 2_048 - 256 - Math.ceil(0.06 * 2_048);

  for (const agentName of ['tools/helper', 'tools/graph'] as const) {
    it(`keeps every request of ${agentName} within a 2048 window over a 60-exchange transcript, without aeye forgetting`, async () => {
      const { r } = await started();
      await r.store.table('modelLimits').put({ model: 'test-model', limits: LIMITS, setBy: ActorId.parse('act_admin'), updatedAt: 0 });
      await r.session({ agent: agentName, tools: ['fs/read'], transcript: longTranscript(60) });
      const { requests, replies, ratios } = sent(r.provider, [calls([['fs__read', { path: 'a' }]]), says('Done.')], r);
      r.provider.script(...replies);
      const { settled } = await answer(r, agentName, 'Read a for me');
      expect(settled).toEqual({ status: 'done', result: 'Done.' });
      expect(requests).toHaveLength(2);
      for (const [i, request] of requests.entries()) {
        expect(estimateOf(request, LIMITS, ratios[i] ?? 0)).toBeLessThanOrEqual(B);
        expect(request.maxTokens).toBe(256);
      }
      expect(r.records.some((rec) => rec.msg === 'agent.forget')).toBe(false);
      const interactions = (await r.store.table('llmInteractions').find({ limit: 5 })).items;
      for (const interaction of interactions) {
        expect(interaction.selection?.budget.estimate).toBeLessThanOrEqual(B);
        expect(interaction.selection?.budget.window).toBe(2_048);
      }
      if (agentName === 'tools/helper') expect(interactions[0]?.selection?.budget.cut.some((c) => c.what.endsWith('older exchanges'))).toBe(true);
      else expect(interactions[0]?.selection?.contextor).toBe('graph');
    });
  }

  it('fails a message larger than the window with a plain message, not a provider error', async () => {
    const { r } = await started();
    await r.store.table('modelLimits').put({ model: 'test-model', limits: LIMITS, setBy: ActorId.parse('act_admin'), updatedAt: 0 });
    await r.session({ agent: 'tools/helper' });
    const { settled } = await answer(r, 'tools/helper', 'word '.repeat(4_000));
    expect(settled.status).toBe('failed');
    expect(settled.status === 'failed' ? settled.error.message : '').toMatch(/^This message is about [\d,]+ tokens; test-model takes [\d,]+ here\. Shorten it or pick a model with a larger window\.$/);
    expect(r.provider.requests).toEqual([]);
  });
});
