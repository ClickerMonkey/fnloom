/**
 * The chat modes and contextors in the agent loop: the execution rig's real loop, runs and scripted model, with the
 * real planner over the rig's store and catalog.
 */
import { openScope } from '../access/index.ts';
import type { Message, Request } from '@aeye/core';
import { agent, fn, g, hub } from '@harness/sdk';
import { ActorId, SystemName, type LlmMessage, type LlmRequest, type RunId, type RunSettled, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_KIND, type AgentKind, type RunInput } from '../execution/index.ts';
import { messageToWire, requestToWire } from '../execution/wire.ts';
import {
  AGENT, ALICE, calls, executionRig, says, ScriptedProvider, SESSION, TEST_MODEL, testSettings, type ExecutionRig,
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
  for (const name of ['fns_search', 'inspect', 'load', 'unload'] as const) r.catalog.add('hub', name, hub.defs.fns[name]);
  const search = new FixedSearch();
  const contextor = createContextor({
    store: r.store, catalog: r.catalog, search, settings: contextorEnv.parse(), modelSettings: { HARNESS_DEFAULT_MODEL: 'test-model' }, models: () => r.module.llm.models(),
    log: r.log, clock: () => r.time.now, probes: () => undefined,
  });
  registerContextorFns(r.module.hubFns, {
    store: () => r.store, catalog: () => r.catalog, search: () => search, sessions: () => sessionLoader(r.store),
    contextor: () => contextor, views: () => new CatalogFnViews(r.catalog), mcpScope: () => Promise.resolve(undefined), access: (actor) => Promise.resolve(openScope(actor)),
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
      { role: 'system', content: `${instructions}\n\n<ctx key="fs/guide">Use fs__read for files.</ctx>` },
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
  it('sends exactly the six tools, shows loaded fns as cards, and runs the fn run() names, not a wrapper', async () => {
    const { r, fs } = await started();
    await r.session({ agent: 'tools/small', tools: ['fs/read'] });
    r.provider.script(calls([['run', { fn: 'fs/read', args: { path: 'README.md' } }]]), says('It has 3 lines.'));
    const { settled, run } = await answer(r, 'tools/small', 'How many lines does README.md have?');
    expect(settled).toEqual({ status: 'done', result: 'It has 3 lines.' });
    const first = r.provider.requests[0];
    expect(first?.tools?.map((t) => t.name)).toEqual(['find', 'find_ctx', 'inspect', 'load', 'unload', 'run']);
    const system = aeyeText(first?.messages[0]);
    expect(system).toContain('## Loaded fns');
    expect(system).toContain('<fn name="fs__read" label="Read"');
    expect(system).toContain('Read a text file.\n<args>');
    expect(system).toContain('## Loaded fns — call one with run({ fn, args })');
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
    expect(replies[0]).toContain('The args don\'t fit fs__read');
    expect(replies[0]).toContain('<example>{"path":"README.md"}</example>');
    expect(replies[1]).toContain('There is no fn fs/reed you can run here.');
    expect(r.records.filter((rec) => rec.msg === 'agent.invalid-input')).toHaveLength(2);
  });

  it('shows a fn loaded with load as a card on the next iteration', async () => {
    const { r } = await started();
    await r.session({ agent: 'tools/small' });
    r.provider.script(calls([['load', { names: ['fs/grep'] }]]), says('Loaded.'));
    await answer(r, 'tools/small', 'Get grep ready');
    expect(aeyeText(r.provider.requests[0]?.messages[0])).not.toContain('<fn name="fs__grep"');
    expect(aeyeText(r.provider.requests[1]?.messages[0])).toContain('<fn name="fs__grep" label="Grep"');
    expect((await r.store.table('sessions').get(SESSION))?.tools).toEqual(['fs/grep']);
  });

  it('ends a run\'s reply with the cards of the fns it exposed', async () => {
    const { r, fs } = await started();
    fs.behaviour.run = () => Promise.resolve({ status: 'done', result: 'found 2', expose: [{ fn: 'fs/read', detail: 'signature' }] });
    await r.session({ agent: 'tools/small' });
    r.provider.script(calls([['run', { fn: 'fs/grep', args: { pattern: 'x' } }]]), says('Found two.'));
    await answer(r, 'tools/small', 'grep for x');
    const reply = (await r.store.table('sessions').get(SESSION))?.transcript.find((m) => m.role === 'tool');
    expect(say(reply)).toMatch(/^found 2\n\n<fn name="fs__read" label="Read" mode="\w+" available="yes">\nRead a text file\.\n<args>obj\{path: text\}<\/args>\n<returns>text<\/returns>\n<\/fn>$/);
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
    expect(say(requests[0]?.messages[0])).toContain('To use a tool, write only the block');
    expect(fs.requests.map((q) => q.args)).toEqual([{ path: 'README.md' }]);
    const streamed = r.chat.streamed.map((s) => s.text ?? '').join('');
    expect(streamed).toContain('I will read it.');
    expect(streamed).not.toContain('<run');
    const result = requests[1]?.messages.at(-1);
    expect(result).toMatchObject({ role: 'user' });
    expect(say(result)).toBe('<result fn="fs__read" status="done">\nline 1\nline 2\nline 3\n</result>');
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
    expect(say(requests[1]?.messages.at(-1))).toMatch(/^<result fn="fs__read" status="invalid-input">\nThe args of that fs__read block are not JSON/);
  });
});

describe('what static `run` may run', () => {
  const offDef = fn({ description: 'Switched off.', args: g.obj({}), returns: g.text() });
  const rawDef = fn({ description: 'Fetch raw bytes for the hub.', args: g.obj({ url: g.text() }), returns: g.text(), visibility: 'none' });
  const mineDef = fn({ description: 'Only for people.', args: g.obj({}), returns: g.text(), visibility: 'user' });

  it('refuses a fn that is switched off, offline, outside the session\'s systems or not for the model, and starts no run', async () => {
    const { r, fs } = await started();
    r.catalog.add('fs', 'off', offDef, { disabled: true });
    r.catalog.add('fs', 'gone', offDef, { available: { unavailable: 'system-disconnected', detail: 'fs is not connected' } });
    r.catalog.add('web', 'fetch_raw', rawDef);
    r.catalog.add('fs', 'mine', mineDef);
    r.catalog.add('git', 'status', offDef);
    await r.session({ agent: 'tools/small', systems: [SystemName.parse('fs'), SystemName.parse('web')] });
    const names = ['fs/off', 'fs/gone', 'git/status', 'web/fetch_raw', 'fs/mine'];
    r.provider.script(...names.map((name) => calls([['run', { fn: name, args: {} }]])), says('None of those.'));
    const { settled, run } = await answer(r, 'tools/small', 'Try them');
    expect(settled).toEqual({ status: 'done', result: 'None of those.' });
    expect(fs.requests).toEqual([]);
    // nothing ran: a refusal is at most a run settled invalid-input, shown softly as retried
    const children = (await r.store.table('runs').find({ where: { parent: run }, limit: 10 })).items;
    expect(children.every((child) => child.status === 'invalid-input' && child.startedAt === undefined)).toBe(true);
    // a fn that exists but is blocked is kept as such a run, with what blocks it, so the chat can say so (regression:
    // a switched-off or offline fn left no run at all); one that reads as missing has none
    const blocks = new Map(children.map((child) => [child.fn, child.outcome?.status === 'invalid-input' ? child.outcome.invalid.blocked?.code : undefined]));
    expect(Object.fromEntries(blocks)).toEqual({ 'fs/off': 'disabled', 'fs/gone': 'system-disconnected', 'git/status': 'other-system', 'web/fetch_raw': undefined, 'fs/mine': undefined });
    const replies = ((await r.store.table('sessions').get(SESSION))?.transcript ?? []).filter((m) => m.role === 'tool').map((m) => say(m));
    expect(replies).toHaveLength(names.length);
    // one that exists says what blocks it, in the hub's words (regression: "You there?"); one not for the model reads as missing
    const said = [
      'fs__off can\'t be used now: fs__off is switched off. Don\'t call it again; tell the person what blocks it.',
      'fs__gone can\'t be used now: fs is not connected. Don\'t call it again; tell the person what blocks it.',
      'git__status can\'t be used now: this session does not use git.',
      'There is no fn web__fetch_raw you can run here.',
      'There is no fn fs__mine you can run here.',
    ];
    said.forEach((line, i) => { expect(replies[i]).toContain(line); });
    expect(r.records.filter((rec) => rec.msg === 'agent.invalid-input')).toHaveLength(names.length);
  });

  it('keeps load and inspect to the same fns', async () => {
    const { r } = await started();
    r.catalog.add('web', 'fetch_raw', rawDef);
    await r.session({ agent: 'tools/small' });
    r.provider.script(calls([['load', { names: ['web/fetch_raw'] }]]), calls([['inspect', { name: 'web/fetch_raw' }]]), says('No.'));
    await answer(r, 'tools/small', 'Load the raw fetch');
    const replies = ((await r.store.table('sessions').get(SESSION))?.transcript ?? []).filter((m) => m.role === 'tool').map((m) => say(m));
    expect(replies[0]).toContain('not for the model');
    expect(replies[1]).toContain('web__fetch_raw can\'t be used now: not for the model');
    expect((await r.store.table('sessions').get(SESSION))?.tools).toEqual([]);
  });
});

describe('invalid input does not count toward the turn\'s error limit', () => {
  const ONE = { settings: testSettings({}, { HARNESS_AGENT_TOOL_FAILURES: 1 }) };

  it('lets a static model retry bad args and unknown fns past the limit, and the turn still ends done', async () => {
    const { r, fs } = await started(ONE);
    await r.session({ agent: 'tools/small' });
    r.provider.script(
      calls([['run', { fn: 'fs/read', args: { file: 'a' } }]]),
      calls([['run', { fn: 'fs/reed', args: { path: 'a' } }]]),
      calls([['run', { args: { path: 'a' } }]]),
      says('Gave up.'),
    );
    const { settled } = await answer(r, 'tools/small', 'Read a');
    expect(settled).toEqual({ status: 'done', result: 'Gave up.' });
    expect(fs.requests).toEqual([]);
    expect(r.provider.requests).toHaveLength(4);
  });

  it('lets a text-protocol model write bad JSON past the limit', async () => {
    const provider = new ScriptedProvider();
    const noTools = { ...TEST_MODEL, id: 'plain-model', capabilities: new Set(['chat', 'streaming'] as const) };
    const { r } = await started({ ...ONE, llm: { providers: { openrouter: provider }, models: [noTools] } });
    await r.session({ agent: 'tools/small', model: { model: 'plain-model' } });
    provider.script(says('<run fn="fs/read">{path: a}</run>'), says('<run fn="fs/read">{"path": </run>'), says('Sorry.'));
    const { settled } = await answer(r, 'tools/small', 'Read a');
    expect(settled).toEqual({ status: 'done', result: 'Sorry.' });
    expect(provider.requests).toHaveLength(3);
  });

  it('lets a fn refuse its input (ctx.invalid) in tools mode past the limit, while one failed round stops the turn', async () => {
    const { r, fs } = await started(ONE);
    fs.behaviour.run = () => Promise.resolve({ status: 'invalid-input', invalid: { source: 'validation', problems: [{ path: 'path', message: 'outside the root' }] } });
    await r.session({ agent: 'tools/helper', tools: ['fs/read'] });
    r.provider.script(calls([['fs__read', { path: '/etc' }]]), calls([['fs__read', { path: '/root' }]]), says('Both outside.'));
    expect((await answer(r, 'tools/helper', 'Read them')).settled).toEqual({ status: 'done', result: 'Both outside.' });
    expect(fs.requests).toHaveLength(2);

    fs.behaviour.run = () => Promise.resolve({ status: 'failed', error: { class: 'caller', message: 'disk on fire' } });
    r.provider.script(calls([['fs__read', { path: 'a' }]]), says('never'));
    expect((await answer(r, 'tools/helper', 'Read a')).settled).toMatchObject({ status: 'failed', error: { code: 'tool-failures' } });
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

  it('records a graph session\'s first selection as the user message\'s suggestions, once per turn', async () => {
    const { r } = await started();
    await r.session({ agent: 'tools/graph', tools: ['fs/read'] });
    r.provider.script(calls([['fs__read', { path: 'a' }]]), says('Done.'));
    await answer(r, 'tools/graph', 'Read a for me');
    expect(r.chat.suggested).toHaveLength(1);
    const record = r.chat.suggested[0]?.record;
    expect(record?.by).toBe('graph');
    expect(record?.items).toContainEqual(expect.objectContaining({ used: true, kind: 'fn', name: 'fs/read' }));
  });

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

describe('a model that thinks in its answer', () => {
  it('streams its <think> block as reasoning and answers without it, through the text protocol', async () => {
    const provider = new ScriptedProvider();
    const noTools = { ...TEST_MODEL, id: 'plain-model', capabilities: new Set(['chat', 'streaming'] as const) };
    const { r } = await started({ llm: { providers: { openrouter: provider }, models: [noTools] } });
    await r.session({ agent: 'tools/small', model: { model: 'plain-model' } });
    provider.script(says('<think>The file has three lines, so</think>\n\nIt has 3 lines.'));
    const { settled } = await answer(r, 'tools/small', 'How many lines?');
    expect(settled).toEqual({ status: 'done', result: 'It has 3 lines.' });
    expect(r.chat.streamed.map((s) => s.reasoning ?? '').join('')).toBe('The file has three lines, so');
    expect(r.chat.streamed.map((s) => s.text ?? '').join('')).not.toContain('<think>');
    expect(r.chat.finished.at(-1)?.parts).toEqual([{ type: 'text', text: 'It has 3 lines.' }]);
  });
});
