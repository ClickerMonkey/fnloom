import { agent, fn, g, hub } from '@harness/sdk';
import { mintId, SystemName, type AnnouncedSystems, type ChatModeConfig, type LlmMessage, type Session, type Turn } from '@harness/core';
import { describe, expect, it, vi } from 'vitest';
import { ALICE, ALICE_INFO, OPEN_LIMITS } from '../execution/testing.ts';
import type { ChatModeFactories, ContextorFactories } from './index.ts';
import { CHAT_MODES } from './modes.ts';
import { CONTEXTORS } from './contextors.ts';
import { contextOrder, fixedRegion, modeChoice, PromptTooLarge } from './planner.ts';
import { systemRow } from '../catalog/fixtures.ts';
import { systemsPrompt } from '../chat/announce.ts';
import { exchanges, textOf } from './history.ts';
import { chatModel, contextorRig, contextRecord, seeded } from './testing.ts';

const SESSION = mintId('session', () => 'plan');
const small = agent({ description: 'Small.', args: g.obj({}), returns: g.text(), instructions: 'Be brief.', tools: [], mode: { type: 'static' }, contextor: { type: 'graph' } });
/** A small window that still holds the static toolset's tools, history and some context. */
const ROOMY = 2_560;
const plain = agent({ description: 'Plain.', args: g.obj({}), returns: g.text(), instructions: 'Be brief.', tools: [] });

/** A rig with the graph agent, a session and a turn. */
async function planning(transcript: LlmMessage[] = [], patch: Partial<Session> = {}, options: Parameters<typeof contextorRig>[0] = {}) {
  const r = await contextorRig(options);
  const agentRecord = r.catalog.addFn('hub/chat_small', small);
  r.catalog.addFn('hub/chat', plain);
  const session = await r.store.table('sessions').insert({
    id: SESSION, title: 'T', owner: ALICE, agent: 'hub/chat_small', participants: [], systems: 'all', tools: [], context: [], status: 'idle', transcript,
    createdAt: 0, updatedAt: 0, archived: false, ...patch,
  });
  const turn: Turn = {
    id: mintId('turn', () => 'plan'), actor: ALICE, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running', limits: OPEN_LIMITS, cost: 0,
    errors: 'feed-back', createdAt: 0, session: SESSION,
  };
  const plan = (text: string, extra: { cached?: Awaited<ReturnType<typeof r.planner.plan>>['report'] } = {}) => r.planner.plan({
    session, turn, agent: agentRecord, model: 'small', instructions: 'Be brief.', transcript: [...transcript, { role: 'user', content: text }], ...extra,
  });
  return { r, session, turn, plan, agentRecord };
}

/** Exchanges about numbered topics; the exchanges `withTool` picks look the topic up with a tool call first. */
function talk(count: number, withTool: (i: number) => boolean = () => false): LlmMessage[] {
  return Array.from({ length: count }, (_, i): LlmMessage[] => [
    { role: 'user', content: `Tell me about zeta${i} please.` },
    ...(withTool(i) ? [
      { role: 'assistant', content: '', toolCalls: [{ id: `call-${i}`, name: 'run', arguments: `{"fn":"fs/read","args":{"path":"zeta${i}.md"}}` }] },
      { role: 'tool', toolCallId: `call-${i}`, content: `Notes on zeta${i}.` },
    ] satisfies LlmMessage[] : []),
    { role: 'assistant', content: `Zeta${i} is about ${'detail '.repeat(30)}. That is all about zeta${i}.` },
  ]).flat();
}

describe('choosing modes and contextors', () => {
  it('takes the session\'s choice, then the agent\'s, then build 1\'s, with defaults filled in', () => {
    expect(modeChoice(undefined, {})).toEqual({ mode: { type: 'tools' }, contextor: { type: 'plain' } });
    expect(modeChoice(undefined, { mode: { type: 'static' } }).mode).toEqual({ type: 'static', protocol: 'auto', placement: 'system-end', loadDetail: 'full' });
    expect(modeChoice({ mode: { type: 'tools' }, contextor: { type: 'suggest', topN: 3 } }, { mode: { type: 'static' }, contextor: { type: 'graph' } })).toEqual({
      mode: { type: 'tools' }, contextor: { type: 'suggest', topN: 3 },
    });
  });

  it('has a factory for every variant, checked at compile time', () => {
    // @ts-expect-error a chat mode variant without a factory does not compile
    const missingMode: ChatModeFactories = { tools: CHAT_MODES.tools };
    // @ts-expect-error a contextor variant without a factory does not compile
    const missingContextor: ContextorFactories = { plain: CONTEXTORS.plain, suggest: CONTEXTORS.suggest };
    expect([missingMode, missingContextor]).toHaveLength(2);
    expect(Object.keys(CHAT_MODES)).toEqual(['tools', 'static']);
    expect(Object.keys(CONTEXTORS)).toEqual(['plain', 'suggest', 'graph']);
  });
});

describe('the graph contextor', () => {
  it('brings a skill\'s fn card without the fn matching the message', async () => {
    const { r, plan } = await planning();
    r.catalog.addContext(contextRecord('fs/git-skill', { description: 'How to use git.', content: 'Use fs/git_status first.', fns: ['fs/git_status'] }));
    r.catalog.addFn('fs/git_status', fn({ description: 'Show the working tree status.', args: g.obj({}), returns: g.text() }));
    r.catalog.addFn('fs/unrelated');
    r.search.hits = [{ kind: 'context', key: 'fs/git-skill', rank: 1, similarity: 1, text: 'git' }];
    await r.graph.derive(contextRecord('fs/git-skill', { fns: ['fs/git_status'] }));
    const planned = await plan('how do I commit with git?');
    expect(planned.report.context.map((c) => [c.name, c.detail])).toEqual([['fs/git-skill', 'full']]);
    expect(planned.report.fns.map((f) => f.name)).toEqual(['fs/git_status']);
    expect(planned.report.fns[0]?.detail).not.toBe('listed');
    expect(planned.context).toContain('<context key="fs/git-skill">');
    expect(planned.context).toContain('<fn name="fs/git_status" label="Git status"');
    expect(planned.tools.map((t) => t.name)).toEqual(['find', 'inspect', 'load', 'unload', 'run']);
  });

  it('keeps the agent\'s own fns callable: native tools in tools mode, offered in static mode', async () => {
    const { r, session, turn } = await planning();
    r.catalog.addFn('hub/fns_search', hub.defs.fns.fns_search);
    r.catalog.addFn('hub/run_status', hub.defs.fns.run_status);
    const toolbox = (mode: ChatModeConfig) => r.catalog.addFn(`hub/toolbox_${mode.type}`, agent({
      description: 'Toolbox.', args: g.obj({}), returns: g.text(), instructions: 'Be brief.', tools: [hub.fns.fns_search, hub.fns.run_status], mode, contextor: { type: 'graph' },
    }));
    const planFor = (mode: ChatModeConfig) => r.planner.plan({ session, turn, agent: toolbox(mode), model: 'small', instructions: 'Be brief.', transcript: [{ role: 'user', content: 'hello' }] });
    const tools = await planFor({ type: 'tools' });
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['hub__fns_search', 'hub__run_status']);
    expect(tools.report.fns.map((f) => f.name).sort()).toEqual(['hub/fns_search', 'hub/run_status']);
    expect(tools.report.fns[0]?.detail).not.toBe('listed');
    // static mode leaves out build 1's search and load fns, whose jobs its own tools do
    const listed = await planFor({ type: 'static', protocol: 'auto', placement: 'system-end', loadDetail: 'full' });
    expect(listed.report.fns.map((f) => f.name)).toEqual(['hub/run_status']);
    expect(listed.context).not.toContain('hub/fns_search');
    expect(listed.tools.map((t) => t.name)).toEqual(['find', 'inspect', 'load', 'unload', 'run']);
  });

  it('takes a large item in a short form when only that fits, and never goes over the budget', async () => {
    const { r, plan } = await planning();
    r.catalog.addContext(contextRecord('fs/manual', { description: 'The fs manual.', summary: 'fs reads, writes and runs commands.', content: 'm'.repeat(8_000) }));
    r.search.hits = [{ kind: 'context', key: 'fs/manual', rank: 1, similarity: 1, text: '' }];
    const planned = await plan('what does the fs manual say?');
    expect(planned.report.context).toEqual([expect.objectContaining({ name: 'fs/manual', detail: 'signature' })]);
    expect(planned.estimate).toBeLessThanOrEqual(2_048 - 512 - Math.ceil(0.06 * 2_048));
    expect(planned.maxTokens).toBe(512);
  });

  it('bounds an agent that declares no maxOutput by HARNESS_AGENT_MAX_OUTPUT, and 0 leaves the model\'s own limit', async () => {
    const planned = async (settings: { HARNESS_AGENT_MAX_OUTPUT?: number } = {}): Promise<number> => {
      const { r, plan } = await planning([], {}, { models: [chatModel('small', { contextWindow: 200_000 })], settings });
      await r.limits.set('small', { contextWindow: 200_000, maxOutputTokens: 100_000 }, ALICE);
      return (await plan('hi')).maxTokens;
    };
    expect(await planned()).toBe(16_000);
    expect(await planned({ HARNESS_AGENT_MAX_OUTPUT: 3_000 })).toBe(3_000);
    expect(await planned({ HARNESS_AGENT_MAX_OUTPUT: 0 })).toBe(100_000);
  });

  it('keeps offering a fn the session ran recently, and a loaded one', async () => {
    const transcript: LlmMessage[] = [
      { role: 'user', content: 'grep for TODO' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'run', arguments: '{"fn":"fs/grep","args":{"pattern":"TODO"}}' }] },
      { role: 'tool', toolCallId: '1', content: '3 matches' },
      { role: 'assistant', content: 'Three.' },
    ];
    const { r, plan } = await planning(transcript, { tools: ['fs/write'] });
    r.catalog.addFn('fs/grep');
    r.catalog.addFn('fs/write');
    r.search.hits = [{ kind: 'fn', key: 'fs/grep', rank: 0.3, similarity: 0.3, text: '' }];
    const planned = await plan('and now in docs?');
    const names = planned.report.fns.map((f) => f.name);
    expect(names).toContain('fs/grep');
    expect(['signature', 'full']).toContain(planned.report.fns.find((f) => f.name === 'fs/write')?.detail);
  });

  it('rebuilds history: the newest exchanges as messages, the relevant older ones as summaries', async () => {
    // the newest exchange looks its topic up too, so the linear part has a tool call however few exchanges fit
    const transcript = talk(30, (i) => i % 3 === 0 || i === 29);
    // a window with room for the static toolset's tools (each carries its first example) and some history
    const { plan } = await planning(transcript, {}, { models: [chatModel('small', { contextWindow: ROOMY })] });
    const planned = await plan('remind me about zeta3');
    expect(planned.report.linear).toBeGreaterThanOrEqual(1);
    expect(planned.report.linear).toBeLessThan(30);
    expect(planned.report.earlier).toContain(3);
    expect(planned.context).toContain('<earlier turn="3">');
    const last = planned.messages.at(-1);
    expect(last).toEqual({ role: 'user', content: 'remind me about zeta3' });
    // the linear part is the newest exchanges whole and in order, then the current message
    const newest = exchanges(transcript).slice(-planned.report.linear).flatMap((e) => [...e.messages]);
    expect(planned.messages.slice(0, -1)).toEqual(newest);
    // every tool call in it travels with its reply, right after the call
    const calls = planned.messages.flatMap((m, i) => (m.toolCalls ?? []).map((call) => ({ id: call.id, at: i })));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const reply = planned.messages.findIndex((m) => m.role === 'tool' && m.toolCallId === call.id);
      expect(reply).toBeGreaterThan(call.at);
    }
  });

  it('chooses the same for a retried job, and keeps its choice on the session', async () => {
    const { r, plan, session } = await planning(talk(10));
    r.catalog.addContext(contextRecord('fs/guide', { content: 'g'.repeat(400) }));
    r.search.hits = [{ kind: 'context', key: 'fs/guide', rank: 0.9, similarity: 0.9, text: '' }];
    const first = await plan('guide me');
    const again = await plan('guide me', { cached: first.report });
    expect(again.context).toBe(first.context);
    expect(again.messages).toEqual(first.messages);
    expect((await r.store.table('sessions').get(session.id))?.selection?.items.map((i) => i.name)).toEqual(first.report.context.map((c) => c.name));
  });

  it('previews a message without keeping anything', async () => {
    const { r } = await planning(talk(2));
    const report = await r.planner.preview(SESSION, 'what about zeta1?', ALICE);
    expect(report.contextor).toBe('graph');
    expect(report.mode).toBe('static');
    expect((await r.store.table('sessions').get(SESSION))?.selection).toBeUndefined();
  });

  it('refuses a message larger than the model takes, with both numbers', async () => {
    const { plan } = await planning();
    await expect(plan('word '.repeat(3_000))).rejects.toThrow(PromptTooLarge);
    await expect(plan('word '.repeat(3_000))).rejects.toThrow(/^This message is about [\d,]+ tokens; small takes [\d,]+ here/);
    // the report carries the budget's real reserve: a quarter of the 2,048 window for the reply, a 6% margin
    const refused = await plan('word '.repeat(3_000)).then(() => undefined, (error: unknown) => error);
    expect(refused instanceof PromptTooLarge ? refused.report : undefined).toMatchObject({ window: 2_048, output: 512, reasoning: 0, margin: 123 });
  });

  it('keeps choosing with less room while the whole prompt comes out over budget, and fits', async () => {
    const graph = CONTEXTORS.graph;
    // a contextor whose parts always come to about 300 tokens more than the room it is given
    const spy = vi.spyOn(CONTEXTORS, 'graph').mockImplementation((config, deps) => {
      const real = graph(config, deps);
      return { type: real.type, select: (input) => real.select({ ...input, plan: { ...input.plan, flexible: input.plan.flexible + 300 } }) };
    });
    try {
      const { r, plan } = await planning(talk(20), {}, { models: [chatModel('small', { contextWindow: ROOMY })] });
      for (let i = 0; i < 12; i++) r.catalog.addContext(contextRecord(`fs/item-${i}`, { content: 'c'.repeat(600) }));
      r.search.hits = Array.from({ length: 12 }, (_, i) => ({ kind: 'context' as const, key: `fs/item-${i}`, rank: 1 - i / 20, similarity: 1 - i / 20, text: '' }));
      const planned = await plan('item details please');
      expect(planned.estimate).toBeLessThanOrEqual(ROOMY - 512 - Math.ceil(0.06 * ROOMY));
      expect(planned.report.context.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('stays within budget for random sessions (seeded)', async () => {
    const random = seeded(3);
    for (let round = 0; round < 12; round++) {
      const { r, plan } = await planning(talk(Math.floor(random() * 40)));
      for (let i = 0; i < 20; i++) {
        const name = `fs/item-${i}` as const;
        r.catalog.addContext(contextRecord(name, { content: 'c'.repeat(Math.floor(random() * 3_000)), imports: i > 0 && random() < 0.3 ? [`fs/item-${i - 1}`] : [], fns: random() < 0.3 ? [`fs/fn-${i}`] : [] }));
        r.catalog.addFn(`fs/fn-${i}`);
      }
      r.search.hits = Array.from({ length: 10 }, (_, i) => ({ kind: random() < 0.5 ? 'context' as const : 'fn' as const, key: random() < 0.5 ? `fs/item-${i}` : `fs/fn-${i}`, rank: random(), similarity: random(), text: '' }));
      const planned = await plan('item details please');
      expect(planned.estimate).toBeLessThanOrEqual(2_048 - 512 - Math.ceil(0.06 * 2_048));
    }
  });
});

describe('static mode calls', () => {
  it('offers the nearest names for an unknown fn, and refuses args that do not fit', async () => {
    const { r, plan } = await planning();
    r.catalog.addFn('fs/read');
    r.search.hits = [{ kind: 'fn', key: 'fs/read', rank: 1, similarity: 1, text: '' }];
    const planned = await plan('read it');
    const unknown = await r.planner.interpret({ type: 'tool', id: '1', name: 'run', args: { fn: 'fs/raed', args: { path: 'a' } } }, planned);
    expect(unknown).toMatchObject({ type: 'invalid', reply: 'There is no fn fs/raed you can run here. The nearest: fs/read.' });
    const bad = await r.planner.interpret({ type: 'block', id: 'b1', fn: 'fs/read', json: '{"path": 3}' }, planned);
    expect(bad).toMatchObject({ type: 'invalid', fn: 'fs/read', invalid: { source: 'schema', problems: [{ path: 'path' }] } });
    const good = await r.planner.interpret({ type: 'block', id: 'b2', fn: 'fs/read', json: '{"path": "a"}' }, planned);
    expect(good).toEqual({ type: 'run', fn: 'fs/read', args: { path: 'a' } });
    // a block names the machine with on, as run's on does
    expect(await r.planner.interpret({ type: 'block', id: 'b4', fn: 'fs/read', on: 'laptop', json: '{"path": "a"}' }, planned)).toEqual({ type: 'run', fn: 'fs/read', args: { path: 'a' }, on: 'laptop' });
    expect(await r.planner.interpret({ type: 'block', id: 'b5', fn: 'fs/read', on: 'Not A Machine!', json: '{"path": "a"}' }, planned)).toMatchObject({ type: 'invalid', invalid: { problems: [{ path: 'on' }] } });
    expect(await r.planner.interpret({ type: 'tool', id: '2', name: 'find', args: { text: 'x' } }, planned)).toEqual({ type: 'run', fn: 'hub/fns_search', args: { text: 'x' } });
    expect(await r.planner.interpret({ type: 'block', id: 'b3', fn: undefined, json: '{}' }, planned)).toMatchObject({ type: 'invalid', invalid: { source: 'schema' } });
  });

  it('puts cards in a trailing system message with placement tail', async () => {
    const tail: ChatModeConfig = { type: 'static', placement: 'tail', protocol: 'auto', loadDetail: 'full' };
    const { r, plan } = await planning([], { mode: tail, tools: ['fs/read'] });
    r.catalog.addFn('fs/read');
    const planned = await plan('read');
    expect(planned.context).not.toContain('<fn name="fs/read"');
    expect(planned.messages.at(-1)).toMatchObject({ role: 'system' });
    expect(textOf(planned.messages.at(-1) ?? { role: 'system', content: '' })).toContain('<fn name="fs/read"');
  });
});

describe('context order', () => {
  it('puts parents before children and chains in order', () => {
    const chosen = (name: `${string}/${string}`, fields: Parameters<typeof contextRecord>[1], activation: number) => ({ record: contextRecord(name, fields), detail: 'full' as const, activation, text: '' });
    const ordered = contextOrder([
      chosen('r/part-2', { parent: 'r/doc' }, 0.9),
      chosen('r/part-1', { parent: 'r/doc', next: 'r/part-2' }, 0.5),
      chosen('r/doc', {}, 0.1),
    ]);
    expect(ordered.map((c) => c.record.name)).toEqual(['r/doc', 'r/part-1', 'r/part-2']);
  });
});

describe('the plain contextor (build 6: a context brings its fns)', () => {
  it('replays turn 1: a loaded guide comes with what it imports, its fns are tools, and its choices show their sizes', async () => {
    const { r, session, turn } = await planning([], { agent: 'hub/chat', context: ['fs/authoring'] });
    const chat = await r.catalog.fn('hub/chat');
    if (chat === undefined) throw new Error('no hub/chat');
    const plan = (text: string) => r.planner.plan({ session, turn, agent: chat, model: 'small', instructions: 'Be brief.', transcript: [{ role: 'user', content: text }] });
    r.catalog.addContext(contextRecord('fs/authoring', {
      description: 'Writing a system.', content: 'Start here.', imports: ['fs/authoring.layout'], fns: ['fs/install_system'],
      choices: [{ to: 'fs/authoring.kinds', when: 'pick this when the system declares a kind' }],
    }));
    r.catalog.addContext(contextRecord('fs/authoring.layout', { description: 'Folder layout.', content: 'A system has server/ and system.json.', fns: ['fs/read'] }));
    r.catalog.addContext(contextRecord('fs/authoring.kinds', { description: 'Kinds.', content: 'A kind has a payload type.' }));
    r.catalog.addFn('fs/install_system', fn({ description: 'Install a system.', args: g.obj({}), returns: g.text() }));
    r.catalog.addFn('fs/read', fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text() }));
    const planned = await plan('write me a system');
    expect(planned.report.contextor).toBe('plain');
    expect(planned.report.context.map((c) => c.name)).toEqual(['fs/authoring', 'fs/authoring.layout']);
    expect(planned.tools.map((t) => t.name).sort()).toEqual(['fs__install_system', 'fs__read']);
    const system = planned.context;
    expect(system).toContain('<brought_fns in_tools="yes">In your tools now: fs/install_system</brought_fns>');
    expect(system).toMatch(/<choice key="fs\/authoring\.kinds" tokens="\d+">pick this when the system declares a kind/);
  });

  it('says only the fns actually added are in the tools, and names the held ones with why (regression: "You there?")', async () => {
    const { r, session, turn } = await planning([], { agent: 'hub/chat', context: ['database/guide'] });
    const chat = await r.catalog.fn('hub/chat');
    if (chat === undefined) throw new Error('no hub/chat');
    const held = (name: string) => ({ available: { unavailable: 'held' as const, detail: `${name} changed and waits for an admin to approve it` } });
    r.catalog.addContext(contextRecord('database/guide', {
      description: 'Tables.', content: 'Make a table, then add rows.', fns: ['database/create_table', 'database/insert_rows', 'database/list_tables', 'database/gone'],
    }));
    r.catalog.addFn('database/create_table', fn({ description: 'Create a table.', args: g.obj({}), returns: g.text() }), held('database/create_table'));
    r.catalog.addFn('database/insert_rows', fn({ description: 'Insert rows.', args: g.obj({}), returns: g.text() }), held('database/insert_rows'));
    r.catalog.addFn('database/list_tables', fn({ description: 'List tables.', args: g.obj({}), returns: g.text() }));
    const planned = await r.planner.plan({ session, turn, agent: chat, model: 'small', instructions: 'Be brief.', transcript: [{ role: 'user', content: 'track my tasks' }] });
    expect(planned.tools.map((t) => t.name)).toEqual(['database__list_tables']);
    expect(planned.context).toContain('<brought_fns in_tools="yes">In your tools now: database/list_tables</brought_fns>\n');
    expect(planned.context).toContain('<brought_fns in_tools="no" available="no">You can\'t use these now: database/create_table, database/insert_rows (changed and waits for an admin to approve it).');
    // a fn that doesn't exist (or that the person can't see) is not named
    expect(planned.context).not.toContain('database/gone');
  });

  it('in the static toolset never says a brought fn is in the tools: its card is in the prompt, run by name', async () => {
    const mode: ChatModeConfig = { type: 'static', protocol: 'native', placement: 'system-end', loadDetail: 'full' };
    const { r, session, turn } = await planning([], { agent: 'hub/chat', context: ['database/guide'], mode });
    const chat = await r.catalog.fn('hub/chat');
    if (chat === undefined) throw new Error('no hub/chat');
    r.catalog.addContext(contextRecord('database/guide', { description: 'Tables.', content: 'Make a table, then add rows.', fns: ['database/list_tables', 'database/create_table'] }));
    r.catalog.addFn('database/list_tables', fn({ description: 'List tables.', args: g.obj({}), returns: g.text() }));
    r.catalog.addFn('database/create_table', fn({ description: 'Create a table.', args: g.obj({}), returns: g.text() }), { available: { unavailable: 'held', detail: 'database/create_table changed and waits for an admin to approve it' } });
    const planned = await r.planner.plan({ session, turn, agent: chat, model: 'small', instructions: 'Be brief.', transcript: [{ role: 'user', content: 'track my tasks' }] });
    expect(planned.report.mode).toBe('static');
    expect(planned.context).not.toContain('in_tools');
    expect(planned.context).not.toContain('In your tools');
    expect(planned.context).toContain('<brought_fns loaded="yes">Their cards are in this prompt; run one with run({ fn, args }): database/list_tables</brought_fns>');
    expect(planned.context).toContain('<fn name="database/list_tables"');
    expect(planned.context).toContain('<brought_fns loaded="no" available="no">You can\'t use these now: database/create_table (changed and waits for an admin to approve it).');
    // the text protocol says to write a block
    const text = await planning([], { agent: 'hub/chat', context: ['database/guide'], mode: { ...mode, protocol: 'text' } });
    text.r.catalog.addContext(contextRecord('database/guide', { description: 'Tables.', content: 'Make a table.', fns: ['database/list_tables'] }));
    text.r.catalog.addFn('database/list_tables', fn({ description: 'List tables.', args: g.obj({}), returns: g.text() }));
    const textChat = await text.r.catalog.fn('hub/chat');
    if (textChat === undefined) throw new Error('no hub/chat');
    const written = await text.r.planner.plan({ session: text.session, turn: text.turn, agent: textChat, model: 'small', instructions: 'Be brief.', transcript: [{ role: 'user', content: 'tables' }] });
    expect(written.context).toContain('<brought_fns loaded="yes">Their cards are in this prompt; run one with a &lt;run fn="…"&gt;{…}&lt;/run&gt; block: database/list_tables</brought_fns>');
  });
});

describe('the chat agents\' prompt', () => {
  it('tells the model to stop and say what blocks it, with the hub\'s reason, instead of retrying (Phil: a prompt rule, no guard)', () => {
    for (const def of [hub.defs.fns.chat, hub.defs.fns.chat_small]) {
      const { instructions } = def.payload;
      expect(instructions).toContain('When something you need is unavailable or refused, or the same call keeps failing or returning nothing, stop:');
      expect(instructions).toContain('tell the person what blocks you and why, with the reason the hub gave');
      expect(instructions).toContain('instead of retrying, guessing or working around it.');
    }
  });
});

describe('the systems in the system prompt (Phil: told about each system, just the initially available set)', () => {
  const WIDE = { models: [chatModel('small', { contextWindow: 32_000 })] };
  const fs = { name: SystemName.parse('fs'), label: 'Files', description: 'Files on the host.' };
  const snapshot: AnnouncedSystems = {
    prompt: [fs, { name: SystemName.parse('git'), label: 'Git', description: 'Git repositories.' }],
    on: [SystemName.parse('fs'), SystemName.parse('git')], off: [],
  };

  it('lists the first turn\'s snapshot first after the instructions, in name order, the same on every step whatever changed since', async () => {
    const { r, plan } = await planning(talk(1), { announcedSystems: snapshot }, WIDE);
    const list = systemsPrompt(snapshot.prompt);
    const before = await plan('hello');
    expect(before.context.startsWith(`${list}\n\n`)).toBe(true);
    expect(list.indexOf('name="fs"')).toBeLessThan(list.indexOf('name="git"'));
    // the systems change in the database: the prompt still lists the snapshot, so it stays the same and caches
    await r.store.table('systems').put(systemRow('crm', 'connected', { description: 'Tickets.' }));
    await r.store.table('systems').put(systemRow('fs', 'disconnected'));
    const after = await plan('hello');
    expect(after.context).toBe(before.context);
    expect(after.context).not.toContain('crm');
  });

  it('counts the list in the fixed part of the budget', async () => {
    const withList = await (await planning(talk(1), { announcedSystems: snapshot }, WIDE)).plan('hello');
    const without = await (await planning(talk(1), {}, WIDE)).plan('hello');
    expect(without.context).not.toContain('<systems>');
    expect(withList.report.budget.fixed).toBeGreaterThan(without.report.budget.fixed);
  });

  it('before a chat has a snapshot (a preview), lists the systems available now', async () => {
    const { r, plan } = await planning(talk(1), {}, WIDE);
    await r.store.table('systems').put(systemRow('fs', 'connected', { description: 'Files on the host.' }));
    await r.store.table('systems').put(systemRow('web', 'disconnected'));
    const live = await plan('hello');
    expect(live.context.startsWith(`${systemsPrompt([{ ...fs, label: 'Fs' }])}\n\n`)).toBe(true);
    expect(live.context).not.toContain('name="web"');
  });

  it('puts the list before the guide, and leaves the guide alone with no systems', () => {
    expect(fixedRegion([fs], 'guide')).toBe(`${systemsPrompt([fs])}\n\nguide`);
    expect(fixedRegion([], 'guide')).toBe('guide');
  });
});
