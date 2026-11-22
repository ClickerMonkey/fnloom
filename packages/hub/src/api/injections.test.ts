/**
 * The admin's view of injected context and its switches: `hub/ctx_injections_list` and `hub/ctx_injection_set` (their
 * operations, shared with the web endpoints `injections` and `setInjection`), over a real catalog and store.
 */
import { ActorId, QualifiedName, SystemName, type ContractChange, type KindDescription, type UserView } from '@harness/core';
import { agent, context, fn, g, hook, kind, LlmPayloadType, system, wireType, type LlmPayload } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { openScope } from '../access/index.ts';
import { StoreCatalog } from '../catalog/catalog.ts';
import { manifestFor, systemRow } from '../catalog/fixtures.ts';
import type { KindDescriber } from '../catalog/index.ts';
import { NO_DYNAMIC_CONTEXT } from '../contextor/dynamic.ts';
import { RecordingBus, memoryLog } from '../testing.ts';
import { adminOperations } from './admin-ops.ts';
import { injectionDeps } from './injections.ts';
import { adminReadOperations } from './person-ops.ts';
import { rig, type Rig } from './testing/rig.ts';
import { webRig } from './testing/rig.ts';

const q = (name: string): QualifiedName => QualifiedName.parse(name);
const admin: UserView = { id: ActorId.parse('act_admin'), kind: 'user', name: 'Admin', email: 'admin@example.com', role: 'admin' };
const member: UserView = { ...admin, id: ActorId.parse('act_member'), name: 'Member', email: 'member@example.com', role: 'member' };

const CHAT: LlmPayload = { instructions: 'Chat.', tools: [], canLoad: 'none', maxTools: 32, context: [], hooks: [], toolExecution: 'parallel', maxIterations: 16 };

/** A small hub contract: the agent kind and two chat agents, the small one at summaries with a tight cap. */
const miniHub = system('hub', { description: 'The hub.' })
  .with({ kinds: { llm: kind({ description: 'Agents.', applicability: 'Agents.', payload: LlmPayloadType }) } })
  .with(({ kinds }) => ({
    fns: {
      chat: kinds.llm.fn({ description: 'Chat.', payload: CHAT, args: g.obj({}), returns: g.text() }),
      chat_small: kinds.llm.fn({ description: 'Small chat.', payload: { ...CHAT, injected: { detail: 'summary', maxTokens: 20 } }, args: g.obj({}), returns: g.text() }),
    },
  }));

const describer: KindDescriber = {
  describe() {
    const description: KindDescription = { args: wireType(g.obj({})), returns: wireType(g.text()), deps: [], operations: { cancel: true, pause: false, undo: false, background: true }, examples: [{ args: {} }] };
    return Promise.resolve({ problems: [], description });
  },
};

/** crm: an agent, a fn, two injected items (one static-mode only) and a hook that explains its block. */
const crm = system('crm', { description: 'Customers.' })
  .with({
    fns: {
      lookup: fn({ description: 'Find a customer.', args: g.obj({ name: g.text() }), returns: g.text() }),
      reviewer: agent({ description: 'Reviews a deal.', args: g.obj({}), returns: g.text(), instructions: 'You review deals.' }),
    },
  })
  .with(({ fns }) => ({
    context: {
      deals: context({
        title: 'Deals', description: 'How deals are reviewed.', summary: 'Look customers up with fn:crm/lookup.',
        content: `Before you judge a deal, look the customer up with fn:crm/lookup and read their history. ${'Say what you found. '.repeat(20)}`,
        fns: [fns.lookup], inject: { into: [fns.reviewer, 'hub/chat*'], order: 40 },
      }),
      quick: context({ title: 'Quick', description: 'Static only.', content: 'Use run.', inject: { into: ['hub/chat*'], order: 50, mode: 'static' } }),
    },
    hooks: { stage: hook({ description: 'The deal stage.', explains: 'The stage each open deal is in.', order: 50 }) },
  }));

/** A rig whose catalog is a real one over the rig's store, with the hub and crm imported. */
async function setup(): Promise<{ r: Rig; catalog: StoreCatalog }> {
  const holder: { catalog?: StoreCatalog } = {};
  const of = (): StoreCatalog => { if (holder.catalog === undefined) { throw new Error('no catalog yet'); } return holder.catalog; };
  const r = await rig({
    catalog: {
      entries: (section, filter) => of().entries(section, filter),
      fn: (name) => of().fn(name),
      fns: (filter) => of().fns(filter),
      context: (name) => of().context(name),
      availability: (name) => of().availability(name),
      modelNames: () => of().modelNames(),
    },
    contextor: { dynamic: NO_DYNAMIC_CONTEXT },
    access: { scope: (actor) => Promise.resolve(openScope(actor)) },
  });
  const catalog = new StoreCatalog({ store: r.store, bus: new RecordingBus(), log: memoryLog().log, clock: () => r.now, describer });
  holder.catalog = catalog;
  await r.store.table('systems').put(systemRow('crm', 'connected', { stage: 'live' }));
  expect((await catalog.importManifest(await manifestFor(miniHub))).refused).toEqual([]);
  expect((await catalog.importManifest(await manifestFor(crm))).refused).toEqual([]);
  return { r, catalog };
}

describe('hub/ctx_injections_list', () => {
  it('lists what reaches one agent, in order, as the model reads it, with the target that took each in', async () => {
    const { r } = await setup();
    const page = await adminReadOperations(r.hub).ctx_injections_list({ agent: q('hub/chat') }, admin);
    expect(page.targets).toEqual([]);
    expect(page.injections.map((view) => [view.context, view.via, view.order, view.leftOut?.why])).toEqual([
      ['crm/deals', 'hub/chat*', 40, undefined],
      ['crm/quick', 'hub/chat*', 50, 'mode'],
      ['crm/stage', 'hub/chat', 100, undefined],
    ]);
    const [deals, , stage] = page.injections;
    // fn names as the model calls them, in this agent's mode (tools)
    expect(deals?.text).toContain('crm__lookup');
    expect(deals?.text).not.toContain('fn:');
    expect(deals).toMatchObject({ agent: 'hub/chat', system: 'crm', title: 'Deals', detail: 'full', on: true, source: { type: 'context' } });
    expect(deals?.tokens).toBeGreaterThan(50);
    expect(stage).toMatchObject({ source: { type: 'hook', hook: 'crm/stage' }, title: 'The <crm_stage> block', text: 'The stage each open deal is in.' });
  });

  it('gives a capped agent its items at their summaries, and says which didn\'t fit', async () => {
    const { r } = await setup();
    const page = await adminReadOperations(r.hub).ctx_injections_list({ agent: q('hub/chat_small') }, admin);
    const deals = page.injections.find((view) => view.context === 'crm/deals');
    expect(deals).toMatchObject({ detail: 'summary', text: 'Look customers up with crm__lookup.' });
    // 20 tokens hold the deals summary or the hook note, not both: the highest order goes first
    const stage = page.injections.find((view) => view.context === 'crm/stage');
    expect(stage?.leftOut?.why).toBe('no-fit');
  });

  it('lists one item in every agent it reaches, with its targets and the agents each hits', async () => {
    const { r } = await setup();
    const page = await adminReadOperations(r.hub).ctx_injections_list({ context: q('crm/deals') }, admin);
    expect(page.targets).toEqual([{ target: 'crm/reviewer', agents: ['crm/reviewer'] }, { target: 'hub/chat*', agents: ['hub/chat', 'hub/chat_small'] }]);
    expect(page.injections.map((view) => [view.agent, view.via])).toEqual([['crm/reviewer', 'crm/reviewer'], ['hub/chat', 'hub/chat*'], ['hub/chat_small', 'hub/chat*']]);
  });

  it('says why an item is left out: waiting for review, its system off', async () => {
    const { r } = await setup();
    const change: ContractChange = { section: 'context', name: 'crm/deals', change: 'changed', origin: 'contract' };
    await r.store.table('systemReviews').put({ system: SystemName.parse('crm'), pending: { version: '1.0.1', hash: 'h', by: 'contract', changes: [change], since: 1 }, updatedAt: 1 });
    const reads = adminReadOperations(r.hub);
    const [pending] = (await reads.ctx_injections_list({ agent: q('crm/reviewer'), context: q('crm/deals') }, admin)).injections;
    expect(pending?.leftOut?.why).toBe('pending');
    // a left-out item still shows its text and order
    expect(pending?.text).toContain('crm__lookup');
    await r.store.table('systemReviews').remove(SystemName.parse('crm'));
    await r.store.table('systems').put(systemRow('crm', 'disconnected', { stage: 'live' }));
    const [off] = (await reads.ctx_injections_list({ agent: q('crm/reviewer') }, admin)).injections;
    expect(off?.leftOut?.why).toBe('system-off');
  });

  it('shows it as a chat with a given fn setting or mode gets it', async () => {
    const { r } = await setup();
    const reads = adminReadOperations(r.hub);
    const none = await reads.ctx_injections_list({ agent: q('hub/chat'), fnMode: 'none' }, admin);
    expect(none.injections.find((view) => view.context === 'crm/deals')?.leftOut).toEqual({ why: 'fns-unusable', reason: 'this chat uses no fns' });
    const inStatic = await reads.ctx_injections_list({ agent: q('hub/chat'), mode: 'static' }, admin);
    expect(inStatic.injections.find((view) => view.context === 'crm/quick')?.leftOut).toBeUndefined();
  });

  it('refuses a member, a name that is no agent, and an item that injects nothing', async () => {
    const { r } = await setup();
    const reads = adminReadOperations(r.hub);
    await expect(reads.ctx_injections_list({}, member)).rejects.toThrow();
    await expect(reads.ctx_injections_list({ agent: q('crm/lookup') }, admin)).rejects.toThrow(/not an agent/);
    await expect(reads.ctx_injections_list({ context: q('crm/nothing') }, admin)).rejects.toThrow(/not injected anywhere/);
  });
});

describe('hub/ctx_injection_set', () => {
  it('switches an item off for one agent only, records who and when, and back on removes the row', async () => {
    const { r } = await setup();
    const ops = adminOperations(r.hub);
    const reads = adminReadOperations(r.hub);
    const off = await ops.ctx_injection_set({ agent: q('hub/chat'), context: q('crm/deals'), on: false }, admin.id);
    expect(off).toMatchObject({ agent: 'hub/chat', context: 'crm/deals', on: false, leftOut: { why: 'off' }, switched: { by: 'act_admin', at: r.now } });
    expect(await r.store.table('injectionSettings').get({ agent: q('hub/chat'), context: q('crm/deals') })).toMatchObject({ on: false, by: 'act_admin' });
    // another agent keeps it
    const [small] = (await reads.ctx_injections_list({ agent: q('hub/chat_small'), context: q('crm/deals') }, admin)).injections;
    expect(small?.on).toBe(true);
    const on = await ops.ctx_injection_set({ agent: q('hub/chat'), context: q('crm/deals'), on: true }, admin.id);
    expect(on.on).toBe(true);
    expect(on.switched).toBeUndefined();
    expect(await r.store.table('injectionSettings').get({ agent: q('hub/chat'), context: q('crm/deals') })).toBeUndefined();
  });

  it('gives an item another order for one agent, and order null goes back to the declared one', async () => {
    const { r } = await setup();
    const ops = adminOperations(r.hub);
    const moved = await ops.ctx_injection_set({ agent: q('hub/chat'), context: q('crm/stage'), order: 5 }, admin.id);
    expect(moved.order).toBe(5);
    const page = await adminReadOperations(r.hub).ctx_injections_list({ agent: q('hub/chat') }, admin);
    expect(page.injections[0]?.context).toBe('crm/stage');
    const back = await ops.ctx_injection_set({ agent: q('hub/chat'), context: q('crm/stage'), order: null }, admin.id);
    expect(back.order).toBe(100);
    expect(await r.store.table('injectionSettings').get({ agent: q('hub/chat'), context: q('crm/stage') })).toBeUndefined();
  });

  it('refuses nothing to set, and an item that doesn\'t reach the agent', async () => {
    const { r } = await setup();
    const ops = adminOperations(r.hub);
    await expect(ops.ctx_injection_set({ agent: q('hub/chat'), context: q('crm/deals') }, admin.id)).rejects.toThrow(/say `on`/);
    await expect(ops.ctx_injection_set({ agent: q('crm/reviewer'), context: q('crm/quick'), on: false }, admin.id)).rejects.toThrow(/not injected into/);
  });
});

describe('the web endpoints', () => {
  it('lists and sets for an admin, the same as the hub fns', async () => {
    const { r } = await setup();
    const web = await webRig(r);
    const tokens = await web.admin();
    const page = await web.client.call('injections', { agent: q('hub/chat') }, web.as(tokens));
    expect(page.injections.map((view) => view.context)).toEqual(['crm/deals', 'crm/quick', 'crm/stage']);
    const set = await web.client.call('setInjection', { agent: q('hub/chat'), context: q('crm/deals'), on: false }, web.as(tokens));
    expect(set.leftOut?.why).toBe('off');
    expect(injectionDeps(r.hub).clock()).toBe(r.now);
  });
});
