import { ActorId, BudgetId, LedgerId, PriorityRuleId, RunId, SessionId, TurnId, type BudgetRule, type PriorityRule, type UserInfo } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../catalog/testing.ts';
import { applicableBudgets, HubLimitResolver, priorityRank, resolveBudgets, resolvePriority } from './limits.ts';
import { LedgerSpend } from './spend.ts';
import { testSettings } from './testing.ts';

const ADA = ActorId.parse('act_ada');
const ENG = ActorId.parse('act_eng');
const OPS = ActorId.parse('act_ops');
const SES = SessionId.parse('ses_1');
const TRN = TurnId.parse('trn_1');
const ada: UserInfo = { id: ADA, name: 'Ada', email: 'a@x', role: 'member', groups: [{ id: ENG, name: 'eng' }, { id: OPS, name: 'ops' }], timeZone: 'UTC', locale: 'en' };
const subject = { user: ada, session: SES, turn: TRN };

let n = 0;
const rule = (target: PriorityRule['target'], values: Pick<PriorityRule, 'default' | 'max'>): PriorityRule => ({ id: PriorityRuleId.parse(`pri_${++n}`), target, setBy: ADA, ...values });
const budget = (target: BudgetRule['target'], values: Partial<BudgetRule>): BudgetRule => ({
  id: BudgetId.parse(`bgt_${++n}`), target, period: 'all-time', maxCost: 10, onLimit: 'refuse', setBy: ADA, ...values,
});

describe('priority', () => {
  it('ranks urgent highest', () => {
    expect(priorityRank('urgent')).toBeGreaterThan(priorityRank('interactive'));
    expect(priorityRank('normal')).toBeGreaterThan(priorityRank('background'));
  });

  it('takes the most specific default: turn, session, user, groups, hub', () => {
    const rules = [rule({ scope: 'hub' }, { default: 'background' }), rule({ scope: 'group', group: ENG }, { default: 'normal' }), rule({ scope: 'user', user: ADA }, { default: 'interactive' })];
    expect(resolvePriority(rules, subject, 'normal')).toEqual({ priority: 'interactive', priorityFrom: { default: 'user' } });
    expect(resolvePriority(rules, subject, 'normal', 'urgent')).toEqual({ priority: 'urgent', priorityFrom: { default: 'turn' } });
    expect(resolvePriority(rules.slice(0, 1), subject, 'normal')).toEqual({ priority: 'background', priorityFrom: { default: 'hub' } });
    expect(resolvePriority([], subject, 'normal')).toEqual({ priority: 'normal', priorityFrom: { default: 'hub' } });
  });

  it('gives the highest default among the user groups, and ignores groups they are not in', () => {
    const rules = [rule({ scope: 'group', group: ENG }, { default: 'normal' }), rule({ scope: 'group', group: OPS }, { default: 'urgent' }), rule({ scope: 'group', group: ActorId.parse('act_x') }, { default: 'background' })];
    expect(resolvePriority(rules, subject, 'background').priority).toBe('urgent');
  });

  it('lowers to the lowest ceiling, where groups count their highest', () => {
    const rules = [
      rule({ scope: 'session', session: SES }, { default: 'urgent' }),
      rule({ scope: 'group', group: ENG }, { max: 'background' }),
      rule({ scope: 'group', group: OPS }, { max: 'normal' }),
      rule({ scope: 'hub' }, { max: 'interactive' }),
    ];
    expect(resolvePriority(rules, subject, 'normal')).toEqual({ priority: 'normal', priorityFrom: { default: 'session', cappedBy: 'group' } });
  });

  it('does not report a ceiling that did not lower anything', () => {
    expect(resolvePriority([rule({ scope: 'hub' }, { max: 'urgent' })], subject, 'normal')).toEqual({ priority: 'normal', priorityFrom: { default: 'hub' } });
  });
});

describe('budgets', () => {
  it('counts hub, session, user and pooled group budgets, and only the most generous each-member allowance', () => {
    const hub = budget({ scope: 'hub' }, {});
    const pooled = budget({ scope: 'group', group: ENG }, { share: 'pooled' });
    const small = budget({ scope: 'group', group: ENG }, { share: 'each', maxCost: 2 });
    const big = budget({ scope: 'group', group: OPS }, { share: 'each', maxCost: 5 });
    const other = budget({ scope: 'user', user: ActorId.parse('act_bob') }, {});
    const perTurn = budget({ scope: 'session', session: SES }, { period: 'per-turn', maxCost: 0.2 });
    const { counted, perTurn: turns } = applicableBudgets([hub, pooled, small, big, other, perTurn], subject);
    expect(counted.map((b) => b.id)).toEqual([hub.id, pooled.id, big.id]);
    expect(turns.map((t) => t.rule.id)).toEqual([perTurn.id]);
  });

  it('caps the turn at the lowest per-turn budget, lowered to what is left of every other budget', () => {
    const userCap = budget({ scope: 'user', user: ADA }, { period: 'per-turn', maxCost: 0.5, maxTime: 60_000 });
    const sessionCap = budget({ scope: 'session', session: SES }, { period: 'per-turn', maxCost: 0.3 });
    const total = budget({ scope: 'session', session: SES }, { maxCost: 5 });
    const capped = resolveBudgets([{ level: 'user', rule: userCap }, { level: 'session', rule: sessionCap }], [{ rule: total, remaining: 4 }], { cost: 1, time: 600_000 });
    expect(capped).toEqual({ turn: { cost: 0.3, time: 60_000 }, budgets: [{ rule: total.id, scope: total.target, remaining: 4 }], limitedBy: sessionCap.id });
    const shrunk = resolveBudgets([{ level: 'session', rule: sessionCap }], [{ rule: total, remaining: 0.1 }], { cost: 1, time: 600_000 });
    expect(shrunk.turn.cost).toBe(0.1);
    expect(shrunk.limitedBy).toBe(total.id);
  });

  it('lets a group per-turn budget give its most generous value, and uses the hub default when the hub sets none', () => {
    const a = budget({ scope: 'group', group: ENG }, { period: 'per-turn', maxCost: 0.1 });
    const b = budget({ scope: 'group', group: OPS }, { period: 'per-turn', maxCost: 0.4 });
    expect(resolveBudgets([{ level: 'group', rule: a }, { level: 'group', rule: b }], [], { cost: 1, time: 1_000 }).turn).toEqual({ cost: 0.4, time: 1_000 });
    expect(resolveBudgets([], [], { cost: 0.7, time: 1_000 })).toEqual({ turn: { cost: 0.7, time: 1_000 }, budgets: [] });
  });

  it('never gives a negative budget', () => {
    const total = budget({ scope: 'hub' }, { maxCost: 1 });
    expect(resolveBudgets([], [{ rule: total, remaining: -3 }], { cost: 1, time: 1 }).turn.cost).toBe(0);
  });
});

describe('the resolver', () => {
  it('resolves from stored rules and the spend so far', async () => {
    const store = new MemoryStore();
    const total = budget({ scope: 'user', user: ADA }, { maxCost: 1, period: { window: 3_600_000 } });
    await store.table('budgets').insert(total);
    await store.table('priorityRules').insert(rule({ scope: 'user', user: ADA }, { default: 'normal' }));
    await store.table('ledger').insert({ id: LedgerId.parse('led_1'), at: 999_000, cost: 0.75, tokens: 10, actor: ADA, fn: 'fs/read', run: RunId.parse('run_1') });
    const resolver = new HubLimitResolver({ store, clock: () => 1_000_000, settings: testSettings() }, new LedgerSpend(store));
    const limits = await resolver.resolve({ user: ada, session: SES, turn: TRN });
    expect(limits.priority).toBe('normal');
    expect(limits.turn.cost).toBeCloseTo(0.25);
    expect(limits.limitedBy).toBe(total.id);
    expect(limits.budgets[0]?.remaining).toBeCloseTo(0.25);
  });
});
