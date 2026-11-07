/**
 * Priority and budgets for a turn, resolved exactly as docs/harness.md "Priority and budgets" says, so there is always
 * one answer. The rules are pure functions over the rules that apply (`resolvePriority`, `resolveBudgets`), and
 * `HubLimitResolver` loads those rules and the spend so far.
 *
 * Priority: the most specific level that sets a default wins (turn, session, user, the user's groups taking the
 * highest among them, then the hub); every level may set a ceiling, the lowest one wins (among groups the highest
 * counts, since membership grants); the turn runs at its default lowered to that ceiling.
 *
 * Budgets: every window and all-time budget that applies counts at once (the hub's, the session's total, the user's,
 * every pooled group budget, and the most generous each-member group allowance). The per-turn cap is the lowest
 * per-turn budget across the levels (groups giving their most generous), and a turn's budget is that cap lowered to
 * the least that is left of every other budget.
 */
import {
  PRIORITIES, type BudgetId, type BudgetRule, type Duration, type LimitScope, type Priority, type PriorityLevel, type PriorityRule,
  type ResolvedLimits, type SessionId, type TurnId, type Usd, type UserInfo,
} from '@harness/core';
import type { LimitResolver } from './index.ts';
import type { ExecutionBase } from './ports.ts';
import { allRows } from './pages.ts';
import type { SpendReader } from './spend.ts';

/** How urgent a priority is: higher runs first. */
export function priorityRank(priority: Priority): number {
  return PRIORITIES.length - 1 - PRIORITIES.indexOf(priority);
}

/** The more urgent of two priorities. */
function higher(a: Priority, b: Priority): Priority {
  return priorityRank(a) >= priorityRank(b) ? a : b;
}

/** Who a turn is resolved for: the levels its rules can live at. */
export interface LimitSubject {
  readonly user: UserInfo;
  readonly session?: SessionId | undefined;
  readonly turn?: TurnId | undefined;
}

/** Whether a rule's target is one of the subject's levels; returns the level it sits at. */
function levelOf(target: LimitScope, subject: LimitSubject): PriorityLevel | undefined {
  switch (target.scope) {
    case 'hub': return 'hub';
    case 'group': return subject.user.groups.some((g) => g.id === target.group) ? 'group' : undefined;
    case 'user': return target.user === subject.user.id ? 'user' : undefined;
    case 'session': return subject.session !== undefined && target.session === subject.session ? 'session' : undefined;
    case 'turn': return subject.turn !== undefined && target.turn === subject.turn ? 'turn' : undefined;
    case 'system':
    case 'fn':
    case 'model': return undefined;
  }
}

/** Levels from the most specific to the broadest. */
const SPECIFIC_FIRST: readonly PriorityLevel[] = ['turn', 'session', 'user', 'group', 'hub'];

/** The value a level gives for some setting: groups merge theirs with `merge`, other levels have at most one rule. */
function perLevel<T>(entries: ReadonlyArray<{ level: PriorityLevel; value: T }>, merge: (a: T, b: T) => T): Map<PriorityLevel, T> {
  const out = new Map<PriorityLevel, T>();
  for (const { level, value } of entries) {
    const existing = out.get(level);
    out.set(level, existing === undefined ? value : merge(existing, value));
  }
  return out;
}

/** The resolved priority and where it came from. */
export function resolvePriority(
  rules: readonly PriorityRule[],
  subject: LimitSubject,
  fallback: Priority,
  requested?: Priority,
): Pick<ResolvedLimits, 'priority' | 'priorityFrom'> {
  const applying = rules.flatMap((rule) => {
    const level = levelOf(rule.target, subject);
    return level === undefined ? [] : [{ level, rule }];
  });
  const defaults = perLevel(applying.flatMap(({ level, rule }) => (rule.default === undefined ? [] : [{ level, value: rule.default }])), higher);
  const ceilings = perLevel(applying.flatMap(({ level, rule }) => (rule.max === undefined ? [] : [{ level, value: rule.max }])), higher);
  if (requested !== undefined) defaults.set('turn', requested);

  const from = SPECIFIC_FIRST.find((level) => defaults.has(level)) ?? 'hub';
  const chosen = defaults.get(from) ?? fallback;
  let ceiling: { level: PriorityLevel; value: Priority } | undefined;
  for (const level of SPECIFIC_FIRST) {
    const value = ceilings.get(level);
    if (value !== undefined && (ceiling === undefined || priorityRank(value) < priorityRank(ceiling.value))) ceiling = { level, value };
  }
  if (ceiling !== undefined && priorityRank(ceiling.value) < priorityRank(chosen)) {
    return { priority: ceiling.value, priorityFrom: { default: from, cappedBy: ceiling.level } };
  }
  return { priority: chosen, priorityFrom: { default: from } };
}

/** A budget rule with what is left of it now. */
export interface BudgetStanding {
  readonly rule: BudgetRule;
  readonly remaining: Usd;
}

/** The hub's per-turn defaults, used when no per-turn rule is set at the hub. */
export interface TurnDefaults {
  readonly cost: Usd;
  readonly time: Duration;
}

/** The budgets that apply to a subject, from all the rules: which count at once, and which give the per-turn cap. */
export function applicableBudgets(rules: readonly BudgetRule[], subject: LimitSubject): { counted: BudgetRule[]; perTurn: Array<{ level: PriorityLevel; rule: BudgetRule }> } {
  const counted: BudgetRule[] = [];
  const perTurn: Array<{ level: PriorityLevel; rule: BudgetRule }> = [];
  let allowance: BudgetRule | undefined;
  for (const rule of rules) {
    const level = levelOf(rule.target, subject);
    if (level === undefined) continue;
    if (rule.period === 'per-turn') {
      perTurn.push({ level, rule });
    } else if (level === 'group' && rule.share === 'each') {
      if (allowance === undefined || rule.maxCost > allowance.maxCost) allowance = rule;
    } else {
      counted.push(rule);
    }
  }
  if (allowance !== undefined) counted.push(allowance);
  return { counted, perTurn };
}

/** The resolved turn budget from the per-turn rules and what is left of every counted budget. */
export function resolveBudgets(
  perTurn: ReadonlyArray<{ level: PriorityLevel; rule: BudgetRule }>,
  standings: readonly BudgetStanding[],
  defaults: TurnDefaults,
): Pick<ResolvedLimits, 'turn' | 'budgets' | 'limitedBy'> {
  const cost = perLevel(perTurn.map(({ level, rule }) => ({ level, value: rule })), (a, b) => (b.maxCost > a.maxCost ? b : a));
  const time = perLevel(perTurn.flatMap(({ level, rule }) => (rule.maxTime === undefined ? [] : [{ level, value: rule.maxTime }])), Math.max);

  let cap: { cost: Usd; by: BudgetId | undefined } = cost.has('hub') ? { cost: Infinity, by: undefined } : { cost: defaults.cost, by: undefined };
  for (const rule of cost.values()) if (rule.maxCost < cap.cost) cap = { cost: rule.maxCost, by: rule.id };
  let turnTime = time.has('hub') ? Infinity : defaults.time;
  for (const value of time.values()) turnTime = Math.min(turnTime, value);

  let limit = cap;
  for (const standing of standings) {
    const left = Math.max(0, standing.remaining);
    if (left < limit.cost) limit = { cost: left, by: standing.rule.id };
  }
  return {
    turn: { cost: limit.cost, time: turnTime },
    budgets: standings.map((s) => ({ rule: s.rule.id, scope: s.rule.target, remaining: s.remaining })),
    ...(limit.by === undefined ? {} : { limitedBy: limit.by }),
  };
}

/** Resolves limits from the stored priority rules and budgets, and the ledger's spend. */
export class HubLimitResolver implements LimitResolver {
  readonly #deps: Pick<ExecutionBase, 'store' | 'clock' | 'settings'>;
  readonly #spend: SpendReader;

  constructor(deps: Pick<ExecutionBase, 'store' | 'clock' | 'settings'>, spend: SpendReader) {
    this.#deps = deps;
    this.#spend = spend;
  }

  async resolve(input: { user: UserInfo; session?: SessionId; turn?: TurnId; requested?: Priority }): Promise<ResolvedLimits> {
    const { store, clock, settings } = this.#deps;
    const subject: LimitSubject = { user: input.user, session: input.session, turn: input.turn };
    const [priorityRules, budgetRules] = await Promise.all([allRows(store.table('priorityRules')), allRows(store.table('budgets'))]);
    const priority = resolvePriority(priorityRules, subject, settings.queue.HARNESS_DEFAULT_PRIORITY, input.requested);
    const { counted, perTurn } = applicableBudgets(budgetRules, subject);
    const now = clock();
    const standings = await Promise.all(counted.map(async (rule) => ({ rule, remaining: rule.maxCost - (await this.#spend.spent(rule, { actor: input.user.id, now })) })));
    const budgets = resolveBudgets(perTurn, standings, { cost: settings.queue.HARNESS_TURN_COST, time: settings.queue.HARNESS_TURN_TIME });
    return { ...priority, ...budgets };
  }
}
