import { ActorId, ContextorConfig, mintId, QualifiedName, SystemName, type ContextRecord, type ContractChange, type KindDescription, type LlmMessage, type Session, type Turn } from '@harness/core';
import { agent, context, fn, g, hook, kind, LlmPayloadType, system, wireType, parseValue, type LlmPayload } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../catalog/catalog.ts';
import { manifestFor, systemRow } from '../catalog/fixtures.ts';
import type { KindDescriber } from '../catalog/index.ts';
import { ALICE, ALICE_INFO, OPEN_LIMITS } from '../execution/testing.ts';
import { RecordingBus, memoryLog, testStore } from '../testing.ts';
import { createContextor } from './create.ts';
import { contextorEnv } from './env.ts';
import { fitInjected, gatherInjected, injectedTemplate, placeInjected, type InjectedItem } from './injected.ts';
import { openScope } from '../access/index.ts';
import { moreContext } from './render.ts';
import { chatModel, FixedSearch } from './testing.ts';

const q = (name: string): QualifiedName => QualifiedName.parse(name);
const ADMIN = ActorId.parse('act_admin');

/** A chat agent's payload. */
const CHAT: LlmPayload = { instructions: 'Chat.', tools: [], canLoad: 'none', maxTools: 32, context: [], hooks: [], toolExecution: 'parallel', maxIterations: 16 };

/** A small hub contract: the agent kind and its two chat agents (the small one at summary detail, capped at 600). */
const miniHub = system('hub', { description: 'The hub.' })
  .with({ kinds: { llm: kind({ description: 'Agents.', applicability: 'Agents.', payload: LlmPayloadType }) } })
  .with(({ kinds }) => ({
    fns: {
      chat: kinds.llm.fn({ description: 'Chat.', payload: CHAT, args: g.obj({}), returns: g.text() }),
      chat_small: kinds.llm.fn({ description: 'Small chat.', payload: { ...CHAT, mode: { type: 'static' }, injected: { detail: 'summary', maxTokens: 600 } }, args: g.obj({}), returns: g.text() }),
      quiet: kinds.llm.fn({ description: 'Takes none.', payload: { ...CHAT, injected: 'none' }, args: g.obj({}), returns: g.text() }),
      ask_user: fn({ description: 'Ask the person mid-task.', args: g.obj({ question: g.text() }), returns: g.text() }),
    },
  }));

/** A describer that takes every agent as it is. */
const describer: KindDescriber = {
  describe() {
    const description: KindDescription = { args: wireType(g.obj({})), returns: wireType(g.text()), deps: [], operations: { cancel: true, pause: false, undo: false, background: true }, examples: [{ args: {} }] };
    return Promise.resolve({ problems: [], description });
  },
};

/** A forms system: items injected by exact name and by patterns, one per mode, one that brings a fn, one with a hook. */
const forms = system('forms', { description: 'Forms.' })
  .with({
    fns: {
      get_input: fn({ description: 'Show a form.', args: g.obj({ title: g.text() }), returns: g.text() }),
      reviewer: agent({ description: 'Reviews a form.', args: g.obj({}), returns: g.text(), instructions: 'You review forms.\n\n{{injectedContext}}\n\nList findings.' }),
    },
  })
  .with(({ fns }) => ({
    context: {
      asking: context({
        title: 'Forms', description: 'When to ask with a form.', summary: 'Use a form for typed details.',
        content: `A **form** asks for several typed fields at once: show one with ${fns.get_input.name}, then end your turn.`,
        fns: [fns.get_input], inject: { into: ['hub/chat*'], order: 40 },
      }),
      review: context({ title: 'Reviewing', description: 'How to review.', content: 'Check each field.', inject: { into: [fns.reviewer], order: 10 } }),
      everyone: context({ title: 'Everyone', description: 'For every agent.', content: 'Be kind.', inject: { into: ['*'], order: 90 } }),
      tools_only: context({ title: 'Tools only', description: 'Tools mode.', content: 'Call tools natively.', inject: { into: ['hub/chat*'], order: 50, mode: 'tools' } }),
      static_only: context({ title: 'Static only', description: 'Static mode.', content: 'Use run.', inject: { into: ['hub/chat*'], order: 50, mode: 'static' } }),
      other: context({ title: 'Other', description: 'For crm agents only.', content: 'Crm.', inject: { into: ['crm/*'] } }),
      plain: context({ description: 'Not injected.', content: 'Plain words.' }),
    },
    hooks: { stage: hook({ description: 'The form stage.', explains: 'Which form is open now.', order: 50 }) },
  }));

const SESSION = mintId('session', () => 'inj');
const turnOf = (id: string): Turn => ({
  id: mintId('turn', () => id), actor: ALICE, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running', limits: OPEN_LIMITS, cost: 0,
  errors: 'feed-back', createdAt: 0, session: SESSION,
});

/** A hub with the mini contract and forms installed (connected), the contextor over it, and a chat session. */
async function rig(patch: Partial<Session> = {}, window = 16_384) {
  const store = await testStore();
  const { log, records } = memoryLog();
  const catalog = new StoreCatalog({ store, bus: new RecordingBus(), log, clock: () => 1_000, describer });
  await store.table('systems').put(systemRow('forms', 'connected'));
  expect((await catalog.importManifest(await manifestFor(miniHub))).refused).toEqual([]);
  expect((await catalog.importManifest(await manifestFor(forms))).refused).toEqual([]);
  // the forms system is connected, so its fns can be used
  for (const name of ['forms/get_input', 'forms/reviewer', 'hub/ask_user']) await store.table('fns').update(q(name), { available: true });
  const search = new FixedSearch();
  const services = createContextor({
    store, catalog, search, settings: contextorEnv.parse(), modelSettings: { HARNESS_DEFAULT_MODEL: 'm' },
    models: () => Promise.resolve([chatModel('m', { contextWindow: window })]), log, clock: () => 1_000, probes: () => undefined,
  });
  const session = await store.table('sessions').insert({
    id: SESSION, title: 'T', owner: ALICE, agent: 'hub/chat', participants: [], systems: 'all', tools: [], context: [], status: 'idle', transcript: [],
    createdAt: 0, updatedAt: 0, archived: false, ...patch,
  });
  const plan = async (agentName: string, turn = turnOf('one'), text = 'Hello.', transcript: LlmMessage[] = []) => {
    const record = await catalog.fn(q(agentName));
    if (record === undefined) throw new Error(`no ${agentName}`);
    const payload = parseValue(LlmPayloadType, record.decl.payload);
    const now = await store.table('sessions').get(SESSION);
    return services.planner.plan({ session: now, turn, agent: record, model: 'm', instructions: payload.instructions, transcript: [...transcript, { role: 'user', content: text }] });
  };
  return { store, catalog, search, records, session, plan, ...services };
}

const names = (report: { items: ReadonlyArray<{ name: string }> } | undefined): string[] => (report?.items ?? []).map((item) => item.name);
const leftOut = (report: { leftOut: ReadonlyArray<{ name: string; why: string }> } | undefined): Record<string, string> =>
  Object.fromEntries((report?.leftOut ?? []).map((item) => [item.name, item.why]));

describe('the injected section: targeting', () => {
  it('takes the items whose targets hit the agent: exact names, patterns and *, never another agent\'s', async () => {
    const r = await rig();
    const chat = await r.plan('hub/chat');
    // hub/chat*: Forms; *: Everyone; tools mode: Tools only; a hook's explains for the session's own agent
    expect(names(chat.report.injected)).toEqual(['forms/asking', 'forms/tools_only', 'forms/everyone', 'forms/stage']);
    expect(leftOut(chat.report.injected)).toEqual({ 'forms/static_only': 'mode' });
    const reviewer = await r.plan('forms/reviewer');
    expect(reviewer.report.injected?.leftOut).toEqual([]);
    expect(names(reviewer.report.injected)).toEqual(['forms/review', 'forms/everyone']);
    // another agent run in the chat never touches the session's stamp, which is its own agent's
    expect((await r.store.table('sessions').get(SESSION))?.fixed?.injected).toEqual(['forms/asking', 'forms/tools_only', 'forms/everyone', 'forms/stage']);
  });

  it('puts the section at {{injectedContext}}, else straight after the instructions, as headings and text', async () => {
    const r = await rig();
    const chat = await r.plan('hub/chat');
    expect(chat.injectedContext).toContain('## Forms\n\nA **form** asks for several typed fields at once: show one with forms__get_input');
    expect(chat.instructions).toBe('Chat.{{#if injectedContext}}\n\n{{{injectedContext}}}{{/if}}');
    const reviewer = await r.plan('forms/reviewer');
    expect(reviewer.instructions).toBe('You review forms.\n\n{{{injectedContext}}}\n\nList findings.');
    expect(placeInjected('A\n\n{{ injectedContext }}\n\nB', 'S')).toBe('A\n\nS\n\nB');
    expect(placeInjected('A', 'S')).toBe('A\n\nS');
    expect(injectedTemplate('A')).toBe('A{{#if injectedContext}}\n\n{{{injectedContext}}}{{/if}}');
  });

  it('gives an agent with injected: none no section', async () => {
    const r = await rig();
    const quiet = await r.plan('hub/quiet');
    expect(quiet.injectedContext).toBe('');
    expect(quiet.report.injected).toBeUndefined();
  });
});

describe('the injected section: what is left out', () => {
  it('leaves out an item waiting for review or declined, switched off for the agent, its system off, or its fns unusable', async () => {
    const r = await rig();
    const change: ContractChange = { section: 'context', name: 'forms/everyone', change: 'added', origin: 'contract' };
    await r.store.table('systemReviews').put({ system: SystemName.parse('forms'), pending: { version: '1.0.1', hash: 'h', by: 'contract', changes: [change], since: 1 }, updatedAt: 1 });
    await r.store.table('injectionSettings').put({ agent: q('hub/chat'), context: q('forms/tools_only'), on: false, by: ADMIN, at: 1 });
    await r.store.table('fns').update(q('forms/get_input'), { disabled: true });
    const chat = await r.plan('hub/chat');
    expect(leftOut(chat.report.injected)).toEqual({ 'forms/everyone': 'pending', 'forms/tools_only': 'off', 'forms/asking': 'fns-unusable', 'forms/static_only': 'mode' });
    expect(chat.report.injected?.leftOut.find((item) => item.name === 'forms/asking')?.reason).toBe('forms/get_input: forms/get_input is switched off');
    expect(names(chat.report.injected)).toEqual(['forms/stage']);
  });

  it('leaves out every forms item when the chat does not use forms, and a brought fn beyond the chat\'s fn setting', async () => {
    const off = await rig({ systems: [] });
    const chat = await off.plan('hub/chat');
    expect(names(chat.report.injected)).toEqual([]);
    expect(leftOut(chat.report.injected)['forms/asking']).toBe('system-off');
    const none = await rig({ fnMode: 'none' });
    expect(leftOut((await none.plan('hub/chat')).report.injected)['forms/asking']).toBe('fns-unusable');
  });

  it('leaves out a declined item, and one whose system an admin switched off', async () => {
    const r = await rig();
    const change: ContractChange = { section: 'context', name: 'forms/everyone', change: 'added', origin: 'contract' };
    await r.store.table('systemReviews').put({ system: SystemName.parse('forms'), declined: [{ ...change, version: '1.0.1', by: ADMIN, at: 2 }], updatedAt: 2 });
    await r.store.table('context').update(q('forms/everyone'), { disabled: true });
    expect(leftOut((await r.plan('hub/chat')).report.injected)['forms/everyone']).toBe('declined');
    await r.store.table('systems').put(systemRow('forms', 'connected', { enabled: { functions: false, renderers: true } }));
    expect(leftOut((await r.plan('hub/chat', turnOf('two'))).report.injected)['forms/asking']).toBe('system-off');
  });
});

describe('the injected section: order, detail and fit', () => {
  it('orders by the admin\'s per-agent order, else the item\'s', async () => {
    const r = await rig();
    await r.store.table('injectionSettings').put({ agent: q('hub/chat'), context: q('forms/everyone'), on: true, order: 5, by: ADMIN, at: 1 });
    expect(names((await r.plan('hub/chat')).report.injected)).toEqual(['forms/everyone', 'forms/asking', 'forms/tools_only', 'forms/stage']);
  });

  it('gives hub/chat_small each item at its summary within its 600-token cap, in static mode', async () => {
    const r = await rig({ agent: 'hub/chat_small' });
    const small = await r.plan('hub/chat_small');
    expect(small.injectedContext).toContain('## Forms\n\nUse a form for typed details.');
    expect(small.injectedContext).not.toContain('several typed fields');
    expect(names(small.report.injected)).toEqual(['forms/asking', 'forms/static_only', 'forms/everyone', 'forms/stage']);
    expect(small.report.injected?.items.find((item) => item.name === 'forms/asking')?.detail).toBe('summary');
    expect(small.report.injected?.tokens).toBeLessThanOrEqual(600);
  });

  const item = (name: string, full: string, summary?: string): InjectedItem => ({
    name: q(`forms/${name}`), source: { type: 'context' }, system: SystemName.parse('forms'), via: 'hub/chat*', title: name, order: 100, full, summary, fns: [],
    record: { name: q(`forms/${name}`), system: SystemName.parse('forms'), stale: false, updatedAt: 0, mentions: { context: [], fns: [] }, decl: { name, description: `About ${name}.`, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', tags: [] } } satisfies ContextRecord,
    dynamic: false,
  });
  const chars = { text: (text: string) => text.length };
  const fit = (room: number, items: InjectedItem[]) => fitInjected(items, { detail: 'full', room, estimator: chars, render: (text) => text });

  it('falls back from the highest order down: to the summary, then a <more_ctx> line, then out, each reported', () => {
    const items = [item('a', 'A'.repeat(100), 'a short'), item('b', 'B'.repeat(100), 'b short'), item('c', 'C'.repeat(100))];
    expect(fit(10_000, items).placed.map((p) => p.detail)).toEqual(['full', 'full', 'full']);
    // the summaries first, the highest order first
    const summaries = fit(250, items);
    expect(summaries.placed.map((p) => p.detail)).toEqual(['full', 'summary', 'full']);
    expect(summaries.cut).toEqual([{ what: 'injected b (forms/b)', why: 'at its summary, to fit the injected section' }]);
    // every summary before any line: both summarised, c (no summary of its own) kept whole
    expect(fit(160, items).placed.map((p) => p.detail)).toEqual(['summary', 'summary', 'full']);
    // then listed under <more_ctx>, the highest order first
    const lines = moreContext([items[2]?.record].flatMap((r) => (r === undefined ? [] : [r]))).length;
    const listed = fit(13 + 13 + 4 + lines, items);
    expect(listed.placed.map((p) => p.detail)).toEqual(['summary', 'summary', 'listed']);
    expect(listed.text).toContain('<more_ctx');
    expect(listed.text).toContain('forms/c');
    expect(listed.cut.map((c) => c.what)).toEqual(['injected b (forms/b)', 'injected a (forms/a)', 'injected c (forms/c)']);
    // then out, the highest order first
    const out = fit(30, items);
    expect(out.placed.map((p) => p.detail)).toEqual(['summary', 'summary']);
    expect(out.noFit.map((n) => [n.name, n.why])).toEqual([['forms/c', 'no-fit']]);
    // a line bigger than the summary it would replace is never used: the summary goes out instead
    const tight = fit(13, items);
    expect(tight.placed.map((p) => p.detail)).toEqual(['summary']);
    expect(tight.noFit.map((n) => n.name)).toEqual(['forms/c', 'forms/b']);
    expect(out.tokens).toBeLessThanOrEqual(30);
  });
});

describe('the injected section: starting tools and contextors', () => {
  it('puts the fns an item brings among the starting tools, and none for an item left out', async () => {
    const r = await rig();
    const chat = await r.plan('hub/chat');
    expect(chat.tools.map((tool) => tool.name)).toContain('forms__get_input');
    await r.store.table('injectionSettings').put({ agent: q('hub/chat'), context: q('forms/asking'), on: false, by: ADMIN, at: 1 });
    const off = await r.plan('hub/chat', turnOf('two'));
    expect(off.tools.map((tool) => tool.name)).not.toContain('forms__get_input');
  });

  it('treats an injected item as loaded: never shown again when loaded, asked for or found, for plain, suggest and graph', async () => {
    for (const contextor of [{ type: 'plain' }, { type: 'suggest', autoInject: { items: 3, tokens: 2_000 } }, { type: 'graph' }].map((config) => ContextorConfig.parse(config))) {
      const r = await rig({ context: [q('forms/asking'), q('forms/plain')], contextor });
      r.search.hits = ['forms/everyone', 'forms/asking'].map((key, rank) => ({ kind: 'context' as const, key, rank, text: key, similarity: 0.99 }));
      const chat = await r.plan('hub/chat', turnOf('one'), 'Tell me about forms and everyone.');
      const chosen = chat.report.context.map((c) => c.name);
      expect(chosen, contextor.type).not.toContain('forms/asking');
      expect(chosen, contextor.type).not.toContain('forms/everyone');
      expect(chosen, contextor.type).toContain('forms/plain');
      // the text is in the prompt once
      expect(`${chat.injectedContext}${chat.context}`.split('several typed fields').length - 1).toBe(1);
    }
  });

  it('counts the section in the fixed part', async () => {
    const r = await rig();
    const chat = await r.plan('hub/chat');
    const quiet = await r.plan('hub/quiet');
    // the parts' estimates round apart by a token or two
    expect(chat.report.budget.fixed - quiet.report.budget.fixed).toBeGreaterThanOrEqual((chat.report.injected?.tokens ?? 0) - 2);
    expect(chat.report.injected?.tokens).toBeGreaterThan(20);
  });
});

describe('the fixed region\'s stamp', () => {
  it('stamps the region at a turn, keeps it for every step of the turn, and rebuilds at the next turn only when it changed', async () => {
    const r = await rig();
    const one = turnOf('one');
    const first = await r.plan('hub/chat', one);
    const stamp = (await r.store.table('sessions').get(SESSION))?.fixed;
    expect(stamp).toMatchObject({ injected: ['forms/asking', 'forms/tools_only', 'forms/everyone', 'forms/stage'], at: one.id });
    expect(first.report.injected?.rebuilt).toBeUndefined();
    // an admin switches an item off mid-turn: this turn's steps keep the region they started with
    await r.store.table('injectionSettings').put({ agent: q('hub/chat'), context: q('forms/everyone'), on: false, by: ADMIN, at: 2 });
    const step = await r.plan('hub/chat', one);
    expect(step.injectedContext).toBe(first.injectedContext);
    // the next turn rebuilds it, once, and says what went
    const two = turnOf('two');
    const next = await r.plan('hub/chat', two);
    expect(next.injectedContext).not.toContain('Be kind.');
    expect(next.report.injected?.rebuilt).toEqual({ added: [], dropped: ['forms/everyone'] });
    expect((await r.store.table('sessions').get(SESSION))?.fixed).toMatchObject({ at: two.id, injected: ['forms/asking', 'forms/tools_only', 'forms/stage'] });
    expect(r.records.some((record) => JSON.stringify(record).includes('contextor.fixed-rebuilt'))).toBe(true);
    // nothing changed: the same region, no rebuild and no new stamp
    const three = await r.plan('hub/chat', turnOf('three'));
    expect(three.injectedContext).toBe(next.injectedContext);
    expect(three.report.injected?.rebuilt).toBeUndefined();
    expect((await r.store.table('sessions').get(SESSION))?.fixed?.at).toBe(two.id);
  });

  it('takes a system\'s items out at the next turn when it goes off, and adds them back when it comes on', async () => {
    const r = await rig();
    expect(names((await r.plan('hub/chat', turnOf('one'))).report.injected)).toContain('forms/asking');
    await r.store.table('sessions').update(SESSION, { systems: [] });
    const off = await r.plan('hub/chat', turnOf('two'));
    expect(names(off.report.injected)).toEqual([]);
    expect(off.report.injected?.rebuilt?.dropped).toContain('forms/asking');
    await r.store.table('sessions').update(SESSION, { systems: 'all' });
    const on = await r.plan('hub/chat', turnOf('three'));
    expect(on.report.injected?.rebuilt?.added).toContain('forms/asking');
  });

  it('keeps nothing for a preview', async () => {
    const r = await rig();
    const report = await r.planner.preview(SESSION, 'Hello.', ALICE);
    expect(names(report.injected)).toContain('forms/asking');
    expect((await r.store.table('sessions').get(SESSION))?.fixed).toBeUndefined();
  });
});

describe('gathering the injected section', () => {
  it('works its items out together (a dynamic one written by its system), at most `parallel` at once, in the same order as one by one', async () => {
    const r = await rig();
    const session = await r.store.table('sessions').get(SESSION);
    const agentRecord = await r.catalog.fn(q('hub/chat'));
    if (agentRecord === undefined) throw new Error('no hub/chat');
    const gather = async (parallel: number) => {
      let running = 0;
      let most = 0;
      // each item's text takes a while, the first ones longest, so they finish out of order
      const dynamic = {
        resolve: async (record: ContextRecord) => {
          running += 1;
          most = Math.max(most, running);
          await new Promise((resolve) => setTimeout(resolve, 10 - Math.min(9, record.name.length % 10)));
          running -= 1;
          return record;
        },
      };
      const gathered = await gatherInjected({ store: r.store, catalog: r.catalog, dynamic, parallel }, { agent: agentRecord, session, access: openScope(ALICE), user: ALICE, mode: 'tools' });
      return { order: gathered.items.map((item) => item.name), left: gathered.leftOut.map((item) => item.name), most };
    };
    const one = await gather(1);
    const two = await gather(2);
    expect(one.most).toBe(1);
    expect(two.most).toBe(2);
    expect(two.order).toEqual(one.order);
    expect(two.left).toEqual(one.left);
    expect(one.order).toContain('forms/asking');
  });
});
