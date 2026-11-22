import { ActorId, ContextRecord, QualifiedName, SystemName, type ContractChange, type KindDescription, type Manifest } from '@harness/core';
import { agent, context, fn, g, hook, kind, LlmPayloadType, system, wireType, type AgentPattern, type LlmPayload } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { contractChanges } from '../link/lifecycle.ts';
import { injectionChanges, reviewSummary } from '../link/review-summary.ts';
import { alwaysForToInject, migrateAlwaysFor } from '../store/always-for.ts';
import { RecordingBus, memoryLog, testStore } from '../testing.ts';
import { StoreCatalog } from './catalog.ts';
import { manifestFor } from './fixtures.ts';
import type { KindDescriber } from './index.ts';
import { agentNames, listHookExplains, listInjections } from './injections.ts';

const q = (name: string): QualifiedName => QualifiedName.parse(name);

/** A chat agent's payload. */
const CHAT: LlmPayload = { instructions: 'Chat.', tools: [], canLoad: 'none', maxTools: 32, context: [], hooks: [], toolExecution: 'parallel', maxIterations: 16 };

/** The hub's agent kind, as a small hub contract has it, with its two chat agents. */
const miniHub = system('hub', { description: 'The hub.' })
  .with({ kinds: { llm: kind({ description: 'Agents.', applicability: 'Agents.', payload: LlmPayloadType }) } })
  .with(({ kinds }) => ({
    fns: {
      chat: kinds.llm.fn({ description: 'Chat.', payload: CHAT, args: g.obj({}), returns: g.text() }),
      chat_small: kinds.llm.fn({ description: 'Small chat.', payload: { ...CHAT, injected: { detail: 'summary', maxTokens: 600 } }, args: g.obj({}), returns: g.text() }),
    },
  }));

/** A describer that takes every agent as it is. */
const describer: KindDescriber = {
  describe() {
    const description: KindDescription = { args: wireType(g.obj({})), returns: wireType(g.text()), deps: [], operations: { cancel: true, pause: false, undo: false, background: true }, examples: [{ args: {} }] };
    return Promise.resolve({ problems: [], description });
  },
};

async function setup() {
  const store = await testStore();
  const { log, records } = memoryLog();
  const catalog = new StoreCatalog({ store, bus: new RecordingBus(), log, clock: () => 1_000, describer });
  expect((await catalog.importManifest(await manifestFor(miniHub))).refused).toEqual([]);
  return { store, catalog, records };
}

/** A crm system: one agent, a plain fn, and context injected by refs and patterns. */
function crmWith(into: readonly AgentPattern[], extra: { explains?: string } = {}) {
  return system('crm', { description: 'Customers.' })
    .with({
      fns: {
        lookup: fn({ description: 'Find a customer.', args: g.obj({ name: g.text() }), returns: g.text() }),
        reviewer: agent({ description: 'Reviews a deal.', args: g.obj({}), returns: g.text(), instructions: 'You review deals.' }),
      },
    })
    .with(({ fns }) => ({
      context: {
        deals: context({ title: 'Deals', description: 'How deals are reviewed.', content: 'Look the customer up first.', fns: [fns.lookup], inject: { into: [fns.reviewer, ...into], order: 40 } }),
        plain: context({ description: 'Not injected.', content: 'x' }),
      },
      hooks: { stage: hook({ description: 'The deal stage.', ...(extra.explains === undefined ? {} : { explains: extra.explains }), order: 50 }) },
    }));
}

/** A manifest with one context item's inject.into rewritten (as a hand-written or file-made manifest could have it). */
function withTargets(manifest: Manifest, name: string, into: string[]): Manifest {
  return { ...manifest, context: manifest.context.map((decl) => (decl.name === name && decl.inject !== undefined ? { ...decl, inject: { ...decl.inject, into } } : decl)) };
}

describe('injections at manifest time', () => {
  it('knows every agent, saved and declared, and none of the plain fns', async () => {
    const { store, catalog } = await setup();
    await catalog.importManifest(await manifestFor(crmWith(['hub/chat*'])));
    expect(await agentNames(store)).toEqual([q('crm/reviewer'), q('hub/chat'), q('hub/chat_small')]);
  });

  it('accepts exact agents (its own, declared in the same contract) and patterns, warning of one that hits no agent yet', async () => {
    const { catalog, records } = await setup();
    const report = await catalog.importManifest(await manifestFor(crmWith(['hub/chat*', 'billing/*'])));
    expect(report.refused).toEqual([]);
    expect((await catalog.context(q('crm/deals')))?.decl.inject?.into).toEqual(['crm/reviewer', 'hub/chat*', 'billing/*']);
    expect(records.some((record) => JSON.stringify(record).includes('catalog.inject.no-agent') && JSON.stringify(record).includes('billing/* hits no agent yet'))).toBe(true);
  });

  it('refuses an exact name that is no agent: a plain fn, or a name nothing has', async () => {
    const { catalog } = await setup();
    const manifest = await manifestFor(crmWith(['hub/chat*']));
    const report = await catalog.importManifest(withTargets(manifest, 'deals', ['crm/lookup', 'crm/reviewr', 'hub/chat']));
    expect(report.refused).toEqual([{ name: 'crm/deals', problems: ['crm/lookup is not an agent: inject into hub/llm fns only', 'crm/reviewr is not an agent: inject into hub/llm fns only'] }]);
    expect(await catalog.context(q('crm/deals'))).toBeUndefined();
    // the rest of the contract goes in
    expect(await catalog.context(q('crm/plain'))).toBeDefined();
  });
});

describe('the injections the catalog lists', () => {
  it('lists each injected item with its targets resolved to agents, in order, for one agent or one item', async () => {
    const { store, catalog } = await setup();
    await catalog.importManifest(await manifestFor(crmWith(['hub/chat*', 'billing/*'])));
    const [deals] = await listInjections(store);
    expect(deals).toMatchObject({
      context: 'crm/deals', system: 'crm', title: 'Deals', fns: ['crm/lookup'], review: 'approved', off: false, dynamic: false,
      targets: [{ target: 'crm/reviewer', agents: ['crm/reviewer'] }, { target: 'hub/chat*', agents: ['hub/chat', 'hub/chat_small'] }, { target: 'billing/*', agents: [] }],
      agents: ['crm/reviewer', 'hub/chat', 'hub/chat_small'],
    });
    expect(await listInjections(store)).toHaveLength(1);
    expect(await listInjections(store, { agent: q('hub/chat_small') })).toHaveLength(1);
    expect(await listInjections(store, { agent: q('hub/other') })).toEqual([]);
    expect((await listInjections(store, { context: q('crm/deals') })).map((item) => item.context)).toEqual(['crm/deals']);
    expect(await listInjections(store, { context: q('crm/plain') })).toEqual([]);
  });

  it('says where an injection\'s review stands, and lists hook explains', async () => {
    const { store, catalog } = await setup();
    await catalog.importManifest(await manifestFor(crmWith(['hub/chat*'], { explains: 'The deal\'s stage.' })));
    const crm = SystemName.parse('crm');
    const change: ContractChange = { section: 'context', name: 'crm/deals', change: 'added', origin: 'contract' };
    await store.table('systemReviews').put({ system: crm, pending: { version: '1.0.1', hash: 'h', by: 'contract', changes: [change], since: 1 }, updatedAt: 1 });
    expect((await listInjections(store))[0]?.review).toBe('pending');
    await store.table('systemReviews').put({ system: crm, declined: [{ ...change, version: '1.0.1', by: ActorId.parse('act_admin'), at: 2 }], updatedAt: 2 });
    await store.table('context').update(q('crm/deals'), { disabled: true });
    expect((await listInjections(store))[0]).toMatchObject({ review: 'declined', off: true });
    expect(await listHookExplains(catalog, store)).toEqual([{ hook: 'crm/stage', system: 'crm', explains: 'The deal\'s stage.', review: 'approved' }]);
  });
});

describe('the review summary\'s injects flag', () => {
  it('names the agents a new injection reaches and the item, with its size', async () => {
    const after = await manifestFor(crmWith(['hub/chat*']));
    const summary = reviewSummary(contractChanges(undefined, after), [q('hub/chat'), q('hub/chat_small')]);
    const flag = summary.flags.find((item) => item.flag === 'injects');
    expect(flag?.items).toEqual(['crm/reviewer', 'hub/chat', 'hub/chat_small']);
    expect(flag?.line).toMatch(/^Changes what crm\/reviewer, hub\/chat and hub\/chat_small are told: \+ Deals \(crm\/deals, \d+ tokens\)$/);
    // it comes after the write and delete flags
    expect(summary.flags.map((item) => item.flag).indexOf('injects')).toBeGreaterThanOrEqual(0);
  });

  it('flags a changed text, target or order, and an injection that went; not an unchanged one or a plain item', async () => {
    const before = await manifestFor(crmWith(['hub/chat*']));
    expect(injectionChanges(contractChanges(before, before))).toEqual([]);
    const retargeted = withTargets(before, 'deals', ['crm/reviewer', 'billing/*']);
    const [changed] = injectionChanges(contractChanges(before, retargeted), [q('hub/chat'), q('crm/reviewer')]);
    expect(changed).toMatchObject({ section: 'context', name: 'crm/deals', change: 'changed', targets: [{ target: 'crm/reviewer', agents: ['crm/reviewer'] }, { target: 'billing/*', agents: [] }] });
    const flag = reviewSummary(contractChanges(before, retargeted), [q('hub/chat'), q('crm/reviewer')]).flags.find((item) => item.flag === 'injects');
    expect(flag?.line).toBe(`Changes what crm/reviewer is told: ~ Deals (crm/deals, ${changed?.tokens ?? 0} tokens)`);
    const uninjected = { ...before, context: before.context.map(({ inject, ...decl }) => (decl.name === 'deals' ? decl : { ...decl, ...(inject === undefined ? {} : { inject }) })) };
    expect(injectionChanges(contractChanges(before, uninjected)).map((item) => item.change)).toEqual(['removed']);
    const retexted = { ...before, context: before.context.map((decl) => (decl.name === 'deals' ? { ...decl, content: 'New words.' } : decl)) };
    expect(injectionChanges(contractChanges(before, retexted)).map((item) => item.change)).toEqual(['changed']);
    const plainChanged = { ...before, context: before.context.map((decl) => (decl.name === 'plain' ? { ...decl, content: 'y' } : decl)) };
    expect(injectionChanges(contractChanges(before, plainChanged))).toEqual([]);
  });

  it('flags a hook\'s new explains, and says a pattern hits no agent yet', async () => {
    const before = await manifestFor(crmWith(['hub/chat*']));
    const after = withTargets(await manifestFor(crmWith(['hub/chat*'], { explains: 'The deal\'s stage.' })), 'deals', ['billing/*']);
    const changes = injectionChanges(contractChanges(before, after), []);
    expect(changes.map((item) => [item.section, item.name, item.change])).toEqual([['context', 'crm/deals', 'changed'], ['hooks', 'crm/stage', 'added']]);
    const flag = reviewSummary(contractChanges(before, after)).flags.find((item) => item.flag === 'injects');
    expect(flag?.line).toContain('hits no agent yet');
    expect(flag?.line).toContain('+ What crm/stage\'s block means');
  });
});

describe('the alwaysFor step of the store migration', () => {
  const record = (origin: ContextRecord['origin'], alwaysFor: string[] | undefined): ContextRecord => ContextRecord.parse({
    name: 'hub/memory.tabs', system: 'hub', ...(origin === undefined ? {} : { origin }), mentions: { context: [], fns: [] }, stale: false, updatedAt: 1,
    decl: { name: 'memory.tabs', description: 'Tabs.', content: 'I like tabs.', imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', tags: [], ...(alwaysFor === undefined ? {} : { alwaysFor }) },
  });
  const memory = { type: 'memory' as const, scope: { to: 'everyone' as const }, author: ActorId.parse('act_admin') };

  it('turns a hub-made item\'s alwaysFor into inject with the same agents, exactly, and drops a system\'s', () => {
    const moved = alwaysForToInject(record(memory, ['hub/chat', 'crm/reviewer']));
    expect(moved?.decl.inject).toEqual({ into: ['hub/chat', 'crm/reviewer'], order: 100, requires: [] });
    expect(moved !== undefined && 'alwaysFor' in moved.decl).toBe(false);
    const declared = alwaysForToInject(record(undefined, ['hub/chat']));
    expect(declared?.decl.inject).toBeUndefined();
    expect(declared !== undefined && 'alwaysFor' in declared.decl).toBe(false);
    expect(alwaysForToInject(record(memory, []))?.decl.inject).toBeUndefined();
    expect(alwaysForToInject(record(memory, undefined))).toBeUndefined();
  });

  it('moves every stored row once, and then has nothing left to do', async () => {
    const store = await testStore();
    const { log } = memoryLog();
    await store.table('context').put(record(memory, ['hub/chat']));
    expect(await migrateAlwaysFor(store, log)).toBe(1);
    const stored = await store.table('context').get(q('hub/memory.tabs'));
    expect(stored?.decl.inject).toEqual({ into: ['hub/chat'], order: 100, requires: [] });
    expect(stored !== undefined && 'alwaysFor' in stored.decl).toBe(false);
    expect(await migrateAlwaysFor(store, log)).toBe(0);
  });
});

