import {
  ActorId, BudgetId, LedgerId, RunId, SessionId, SystemName, TurnId, type BudgetRule, type ResolvedLimits, type Run, type Turn,
} from '@harness/core';
import { describe, expect, it } from 'vitest';
import { RecordingBus, testStore } from '../testing.ts';
import type { CallSite } from './index.ts';
import { coversSite, HubLedger, TURN_CAP } from './ledger.ts';
import { budgetLabel, LedgerSpend } from './spend.ts';
import { ALICE_INFO, testSettings } from './testing.ts';

const ADA = ALICE_INFO.id;
const BOB = ActorId.parse('act_bob');
const ENG = ActorId.parse('act_eng');
const SES = SessionId.parse('ses_1');
const RUN = RunId.parse('run_1');
const TRN = TurnId.parse('trn_1');

function limits(budgets: BudgetRule[], turnCost = 1): ResolvedLimits {
  return { priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: turnCost, time: 60_000 }, budgets: budgets.map((b) => ({ rule: b.id, scope: b.target, remaining: b.maxCost })) };
}

async function world(rules: BudgetRule[] = []) {
  const store = await testStore();
  const time = { now: 10_000_000 };
  let n = 0;
  const bus = new RecordingBus();
  const ledger = new HubLedger({ store, bus, clock: () => time.now, random: () => `${++n}`, settings: testSettings() }, new LedgerSpend(store));
  const turn: Turn = {
    id: TRN, session: SES, actor: ADA, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running', limits: limits(rules), cost: 0, errors: 'feed-back', createdAt: 0,
  };
  await store.table('turns').insert(turn);
  const run: Run = {
    id: RUN, fn: 'tools/helper', fnVersion: 'v1', kind: 'hub/llm', system: SystemName.parse('hub'),
    root: RUN, turn: TRN, session: SES, key: 'k', actor: ADA, caller: ADA, args: {}, status: 'running', allowed: { cancel: true, pause: false, background: false },
    cost: 0, totalCost: 0, priority: 'interactive', background: false, attempt: 1, errors: [], stateChanges: [], createdAt: 0,
  };
  await store.table('runs').insert(run);
  for (const rule of rules) await store.table('budgets').insert(rule);
  return { store, time, ledger, bus };
}

let n = 0;
const budget = (target: BudgetRule['target'], values: Partial<BudgetRule> = {}): BudgetRule => ({
  id: BudgetId.parse(`bgt_${++n}`), target, period: 'all-time', maxCost: 1, onLimit: 'refuse', setBy: ADA, ...values,
});
/** Where the test's calls are made. */
const SITE: CallSite = { fn: 'tools/helper', model: 'm', system: SystemName.parse('tools') };
const line = (cost: number, at: number, extra: { actor?: ActorId; session?: SessionId } = {}) => ({
  cost, at, tokens: 1, actor: extra.actor ?? ADA, fn: 'fs/read' as const, run: RUN, ...(extra.session === undefined ? {} : { session: extra.session }),
});

describe('the ledger', () => {
  it('holds estimates against the turn cap, so concurrent calls see each other, and settles the real cost', async () => {
    const { store, ledger } = await world();
    const first = await ledger.reserve({ limits: limits([], 1), estimate: 0.6, run: RUN, site: SITE });
    expect(first.ok).toBe(true);
    const second = await ledger.reserve({ limits: limits([], 1), estimate: 0.6, run: RUN, site: SITE });
    expect(second).toMatchObject({ ok: false, budget: TURN_CAP });
    if (!first.ok) throw new Error('refused');
    await ledger.settle(first.reservation, { cost: 0.1, tokens: 30, actor: ADA, fn: 'tools/helper', run: RUN, model: 'm' });
    expect((await store.table('turns').get(TRN))?.cost).toBeCloseTo(0.1);
    expect((await store.table('reservations').get(first.reservation))?.settled?.cost).toBeCloseTo(0.1);
    expect((await ledger.reserve({ limits: limits([], 1), estimate: 0.6, run: RUN, site: SITE })).ok).toBe(true);
  });

  it('checks reservations made at the same moment one after another, so together they never pass a budget', async () => {
    const total = budget({ scope: 'session', session: SES }, { maxCost: 1 });
    const { ledger } = await world([total]);
    const answers = await Promise.all([0.6, 0.6, 0.6].map((estimate) => ledger.reserve({ limits: limits([total], 10), estimate, run: RUN, site: SITE })));
    expect(answers.map((a) => a.ok)).toEqual([true, false, false]);
  });

  it('records a reservation settled twice only once', async () => {
    const { store, ledger } = await world();
    const held = await ledger.reserve({ limits: limits([], 1), estimate: 0.1, run: RUN, site: SITE });
    if (!held.ok) throw new Error('refused');
    const entry = { cost: 0.05, tokens: 3, actor: ADA, fn: 'tools/helper' as const, run: RUN, model: 'm' };
    await ledger.settle(held.reservation, entry);
    await ledger.settle(held.reservation, entry);
    expect((await store.table('ledger').find({ limit: 10 })).items).toHaveLength(1);
    expect((await store.table('turns').get(TRN))?.cost).toBeCloseTo(0.05);
  });

  it('allows a small overrun past a budget, never a large one', async () => {
    const total = budget({ scope: 'session', session: SES }, { maxCost: 1 });
    const { ledger } = await world([total]);
    expect((await ledger.reserve({ limits: limits([total], 10), estimate: 1.04, run: RUN, site: SITE })).ok).toBe(true);
    const refused = await ledger.reserve({ limits: limits([total], 10), estimate: 0.5, run: RUN, site: SITE });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.budget).toBe(total.id);
    expect(refused.reason).toContain('session total');
  });

  it('asks a call to wait when a full window budget says wait, and refuses when an all-time one is full', async () => {
    const windowed = budget({ scope: 'user', user: ADA }, { maxCost: 0.5, period: { window: 60_000 }, onLimit: 'wait' });
    const { store, ledger, time } = await world([windowed]);
    await store.table('ledger').insert({ ...line(0.5, time.now - 1_000), id: LedgerId.parse('led_a') });
    expect(await ledger.reserve({ limits: limits([windowed]), estimate: 0.1, run: RUN, site: SITE })).toMatchObject({ ok: false, wait: 60_000 });
    time.now += 120_000;
    expect((await ledger.reserve({ limits: limits([windowed]), estimate: 0.1, run: RUN, site: SITE })).ok).toBe(true);
  });

  it('records system-reported costs and reports what is left, with what limits it', async () => {
    const total = budget({ scope: 'hub' }, { maxCost: 2 });
    const { ledger } = await world([total]);
    await ledger.record({ cost: 1.8, tokens: 0, actor: ADA, fn: 'fs/read', run: RUN, system: SystemName.parse('fs') });
    const left = await ledger.remaining(limits([total], 10), { turn: TRN, actor: ADA });
    expect(left.cost).toBeCloseTo(0.2);
    expect(left.limitedBy).toBe('hub budget');
    expect(await ledger.remaining(limits([], 0.5), { turn: TRN, actor: ADA })).toEqual({ cost: 0, limitedBy: 'this message' });
  });
});

describe('system, fn and model budgets', () => {
  const site = { system: SystemName.parse('tools'), fn: 'tools/helper' as const, model: 'm' };

  it('cover a call when its site matches, and nothing else does', () => {
    expect(coversSite({ scope: 'system', system: SystemName.parse('tools') }, site)).toBe(true);
    expect(coversSite({ scope: 'system', system: SystemName.parse('fs') }, site)).toBe(false);
    expect(coversSite({ scope: 'system', system: SystemName.parse('tools') }, { fn: site.fn, model: 'm' })).toBe(false);
    expect(coversSite({ scope: 'fn', fn: 'tools/helper' }, site)).toBe(true);
    expect(coversSite({ scope: 'fn', fn: 'tools/other' }, site)).toBe(false);
    expect(coversSite({ scope: 'model', model: 'm' }, site)).toBe(true);
    expect(coversSite({ scope: 'model', model: 'n' }, site)).toBe(false);
    expect(coversSite({ scope: 'hub' }, site)).toBe(false);
  });

  it.each([
    ['model', { scope: 'model', model: 'm' }, 'm budget'],
    ['fn', { scope: 'fn', fn: 'tools/helper' }, 'tools/helper budget'],
    ['system', { scope: 'system', system: SystemName.parse('tools') }, 'tools budget'],
  ] as const)('a used-up %s budget refuses a call it covers, though the turn’s limits don’t name it', async (_name, target, label) => {
    const rule = budget(target, { maxCost: 1 });
    const { store, ledger } = await world([rule]);
    await store.table('ledger').insert({ id: LedgerId.parse('led_spent'), at: 0, cost: 1, tokens: 1, actor: BOB, run: RUN, ...site });
    const refused = await ledger.reserve({ limits: limits([], 10), estimate: 0.5, run: RUN, site });
    expect(refused).toMatchObject({ ok: false, budget: rule.id });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.reason).toContain(label);
    // a call made elsewhere is not covered
    expect((await ledger.reserve({ limits: limits([], 10), estimate: 0.5, run: RUN, site: { fn: 'fs/read', model: 'other' } })).ok).toBe(true);
  });

  it('a covering budget holds what open calls reserved, so calls at once can’t pass it together', async () => {
    const rule = budget({ scope: 'model', model: 'm' }, { maxCost: 1 });
    const { ledger } = await world([rule]);
    const answers = await Promise.all([0.6, 0.6].map((estimate) => ledger.reserve({ limits: limits([], 10), estimate, run: RUN, site })));
    expect(answers.map((a) => a.ok)).toEqual([true, false]);
  });

  it('a full window model budget that says wait asks the call to wait until it frees up', async () => {
    const rule = budget({ scope: 'model', model: 'm' }, { maxCost: 0.5, period: { window: 60_000 }, onLimit: 'wait' });
    const { store, ledger, time } = await world([rule]);
    await store.table('ledger').insert({ id: LedgerId.parse('led_w'), at: time.now - 1_000, cost: 0.5, tokens: 1, actor: ADA, run: RUN, ...site });
    expect(await ledger.reserve({ limits: limits([], 10), estimate: 0.1, run: RUN, site })).toMatchObject({ ok: false, budget: rule.id, wait: 60_000 });
    time.now += 120_000;
    expect((await ledger.reserve({ limits: limits([], 10), estimate: 0.1, run: RUN, site })).ok).toBe(true);
  });

  it('per-turn rules at these scopes are not counted as running totals', async () => {
    const rule = budget({ scope: 'fn', fn: 'tools/helper' }, { maxCost: 0, period: 'per-turn' });
    const { ledger } = await world([rule]);
    expect((await ledger.reserve({ limits: limits([], 10), estimate: 0.5, run: RUN, site })).ok).toBe(true);
  });
});

describe('a budget that asks', () => {
  it('holds the call, asks for a raise, and lets it through once the budget is raised', async () => {
    const rule = budget({ scope: 'user', user: ADA }, { maxCost: 1, onLimit: 'ask' });
    const { store, ledger, bus } = await world([rule]);
    await store.table('ledger').insert({ ...line(1, 0), id: LedgerId.parse('led_ask') });
    const held = await ledger.reserve({ limits: limits([rule], 10), estimate: 0.5, run: RUN, site: SITE });
    expect(held).toMatchObject({ ok: false, budget: rule.id, wait: testSettings().execution.HARNESS_BUDGET_RECHECK });
    expect(bus.of('budget.reached')).toEqual([{ budget: rule, run: RUN, reason: 'the your budget of $1.00 is used up', session: 'ses_1' }]);
    await store.table('budgets').update(rule.id, { maxCost: 5 });
    expect((await ledger.reserve({ limits: limits([rule], 10), estimate: 0.5, run: RUN, site: SITE })).ok).toBe(true);
  });

  it('a full all-time budget that says wait refuses, since it never frees up', async () => {
    const rule = budget({ scope: 'user', user: ADA }, { maxCost: 1, onLimit: 'wait' });
    const { store, ledger } = await world([rule]);
    await store.table('ledger').insert({ ...line(1, 0), id: LedgerId.parse('led_all') });
    const refused = await ledger.reserve({ limits: limits([rule], 10), estimate: 0.5, run: RUN, site: SITE });
    expect(refused).toEqual({ ok: false, budget: rule.id, reason: 'the your budget of $1.00 is used up' });
  });
});

describe('spend', () => {
  it('counts a window, a pooled group and an each-member allowance from the ledger', async () => {
    const store = await testStore();
    await store.table('memberships').insert({ group: ENG, user: ADA, addedBy: ADA, addedAt: 0 });
    await store.table('memberships').insert({ group: ENG, user: BOB, addedBy: ADA, addedAt: 0 });
    const entries = [line(1, 100), line(2, 900), line(4, 950, { actor: BOB }), line(8, 990, { actor: ActorId.parse('act_cy'), session: SES })];
    let i = 0;
    for (const entry of entries) await store.table('ledger').insert({ ...entry, id: LedgerId.parse(`led_${++i}`) });
    const spend = new LedgerSpend(store);
    const now = 1_000;
    expect(await spend.spent(budget({ scope: 'hub' }), { now })).toBe(15);
    expect(await spend.spent(budget({ scope: 'hub' }, { period: { window: 500 } }), { now })).toBe(14);
    expect(await spend.spent(budget({ scope: 'user', user: ADA }), { now })).toBe(3);
    expect(await spend.spent(budget({ scope: 'group', group: ENG }, { share: 'pooled' }), { now })).toBe(7);
    expect(await spend.spent(budget({ scope: 'group', group: ENG }, { share: 'each' }), { actor: BOB, now })).toBe(4);
    expect(await spend.spent(budget({ scope: 'group', group: ENG }, { share: 'each' }), { now })).toBe(0);
    expect(await spend.spent(budget({ scope: 'session', session: SES }), { now })).toBe(8);
    expect(await spend.spent(budget({ scope: 'hub' }, { period: 'per-turn' }), { now })).toBe(0);
    // a pooled group with no members counts nothing
    expect(await spend.spent(budget({ scope: 'group', group: ActorId.parse('act_empty') }, { share: 'pooled' }), { now })).toBe(0);
  });

  it('labels budgets the way the chat shows them', () => {
    expect(budgetLabel({ scope: 'session', session: SES })).toBe('session total');
    expect(budgetLabel({ scope: 'group', group: ENG }, 'each')).toBe('group allowance');
    expect(budgetLabel({ scope: 'model', model: 'x' })).toBe('x budget');
  });
});
