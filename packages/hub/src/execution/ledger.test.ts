import {
  ActorId, BudgetId, LedgerId, RunId, SessionId, SystemName, TurnId, type BudgetRule, type ResolvedLimits, type Run, type Turn,
} from '@harness/core';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../catalog/testing.ts';
import { HubLedger, TURN_CAP } from './ledger.ts';
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
  const store = new MemoryStore();
  const time = { now: 10_000_000 };
  let n = 0;
  const ledger = new HubLedger({ store, clock: () => time.now, random: () => `${++n}`, settings: testSettings() }, new LedgerSpend(store));
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
  return { store, time, ledger };
}

let n = 0;
const budget = (target: BudgetRule['target'], values: Partial<BudgetRule> = {}): BudgetRule => ({
  id: BudgetId.parse(`bgt_${++n}`), target, period: 'all-time', maxCost: 1, onLimit: 'refuse', setBy: ADA, ...values,
});
const line = (cost: number, at: number, extra: { actor?: ActorId; session?: SessionId } = {}) => ({
  cost, at, tokens: 1, actor: extra.actor ?? ADA, fn: 'fs/read' as const, run: RUN, ...(extra.session === undefined ? {} : { session: extra.session }),
});

describe('the ledger', () => {
  it('holds estimates against the turn cap, so concurrent calls see each other, and settles the real cost', async () => {
    const { store, ledger } = await world();
    const first = await ledger.reserve({ limits: limits([], 1), estimate: 0.6, run: RUN });
    expect(first.ok).toBe(true);
    const second = await ledger.reserve({ limits: limits([], 1), estimate: 0.6, run: RUN });
    expect(second).toMatchObject({ ok: false, budget: TURN_CAP });
    if (!first.ok) throw new Error('refused');
    await ledger.settle(first.reservation, { cost: 0.1, tokens: 30, actor: ADA, fn: 'tools/helper', run: RUN, model: 'm' });
    expect((await store.table('turns').get(TRN))?.cost).toBeCloseTo(0.1);
    expect((await store.table('reservations').get(first.reservation))?.settled?.cost).toBeCloseTo(0.1);
    expect((await ledger.reserve({ limits: limits([], 1), estimate: 0.6, run: RUN })).ok).toBe(true);
  });

  it('checks reservations made at the same moment one after another, so together they never pass a budget', async () => {
    const total = budget({ scope: 'session', session: SES }, { maxCost: 1 });
    const { ledger } = await world([total]);
    const answers = await Promise.all([0.6, 0.6, 0.6].map((estimate) => ledger.reserve({ limits: limits([total], 10), estimate, run: RUN })));
    expect(answers.map((a) => a.ok)).toEqual([true, false, false]);
  });

  it('records a reservation settled twice only once', async () => {
    const { store, ledger } = await world();
    const held = await ledger.reserve({ limits: limits([], 1), estimate: 0.1, run: RUN });
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
    expect((await ledger.reserve({ limits: limits([total], 10), estimate: 1.04, run: RUN })).ok).toBe(true);
    const refused = await ledger.reserve({ limits: limits([total], 10), estimate: 0.5, run: RUN });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.budget).toBe(total.id);
    expect(refused.reason).toContain('session total');
  });

  it('asks a call to wait when a full window budget says wait, and refuses when an all-time one is full', async () => {
    const windowed = budget({ scope: 'user', user: ADA }, { maxCost: 0.5, period: { window: 60_000 }, onLimit: 'wait' });
    const { store, ledger, time } = await world([windowed]);
    await store.table('ledger').insert({ ...line(0.5, time.now - 1_000), id: LedgerId.parse('led_a') });
    expect(await ledger.reserve({ limits: limits([windowed]), estimate: 0.1, run: RUN })).toMatchObject({ ok: false, wait: 60_000 });
    time.now += 120_000;
    expect((await ledger.reserve({ limits: limits([windowed]), estimate: 0.1, run: RUN })).ok).toBe(true);
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

describe('spend', () => {
  it('counts a window, a pooled group and an each-member allowance from the ledger', async () => {
    const store = new MemoryStore();
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
  });

  it('labels budgets the way the chat shows them', () => {
    expect(budgetLabel({ scope: 'session', session: SES })).toBe('session total');
    expect(budgetLabel({ scope: 'group', group: ENG }, 'each')).toBe('group allowance');
    expect(budgetLabel({ scope: 'model', model: 'x' })).toBe('x budget');
  });
});
