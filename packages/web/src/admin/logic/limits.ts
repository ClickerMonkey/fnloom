/**
 * How budgets, priority rules and resolved limits read: where a rule lives in words ("Group: Engineering"), a
 * budget's period and what happens at its limit, how much of it is used, and the resolved view's sentences (where
 * the priority came from, which budget is tightest).
 */
import type { ActorId, BudgetPeriod, LimitLevel, LimitScope, Priority, PriorityLevel, ResolvedLimits } from '@harness/core';
import { formatCost, formatDuration } from '../../chat/logic/format.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import type { Tone } from '../../ui/index.ts';
import type { BudgetView } from '@harness/core';

/** Finds an actor's name; falls back to the id when unknown. */
export type NameOf = (actor: ActorId) => string;

/** Every level's name. */
export const LEVEL_NAME = {
  hub: 'Hub', group: 'Group', user: 'Person', session: 'Chat', turn: 'Message', system: 'System', fn: 'Fn', model: 'Model',
} as const satisfies Record<LimitLevel, string>;

/** The levels a budget may be set at, offered in this order (a single message's budget is set on the message itself). */
export const BUDGET_LEVELS = ['hub', 'group', 'user', 'session', 'system', 'fn', 'model'] as const satisfies readonly LimitLevel[];

/** The levels a priority rule may live at, broad to specific. */
export const PRIORITY_LEVELS = ['hub', 'group', 'user', 'session', 'turn'] as const satisfies readonly PriorityLevel[];

/** Every priority's word, most urgent first. */
export const PRIORITY_WORD = { urgent: 'Urgent', interactive: 'Interactive', normal: 'Normal', background: 'Background' } as const satisfies Record<Priority, string>;

/** Where a rule lives, in words. */
export function scopeText(scope: LimitScope, nameOf: NameOf): string {
  switch (scope.scope) {
    case 'hub': return 'Whole hub';
    case 'group': return `${LEVEL_NAME.group}: ${nameOf(scope.group)}`;
    case 'user': return `${LEVEL_NAME.user}: ${nameOf(scope.user)}`;
    case 'session': return `${LEVEL_NAME.session}: ${scope.session}`;
    case 'turn': return `${LEVEL_NAME.turn}: ${scope.turn}`;
    case 'system': return `${LEVEL_NAME.system}: ${scope.system}`;
    case 'fn': return `${LEVEL_NAME.fn}: ${fnLabel(scope.fn)}`;
    case 'model': return `${LEVEL_NAME.model}: ${scope.model}`;
  }
}

/** Window lengths an admin picks from, in ms. */
export const WINDOWS = [
  { label: 'Hour', ms: 3_600_000 },
  { label: 'Day', ms: 86_400_000 },
  { label: 'Week', ms: 604_800_000 },
  { label: '30 days', ms: 2_592_000_000 },
] as const;

/** A budget period in words: "per day", "all time", "per message". */
export function periodText(period: BudgetPeriod): string {
  if (period === 'all-time') { return 'all time'; }
  if (period === 'per-turn') { return 'per message'; }
  const known = WINDOWS.find((w) => w.ms === period.window);
  return known === undefined ? `per ${formatDuration(period.window)}` : `per ${known.label.toLowerCase()}`;
}

/** What happens at a budget's limit, in words. */
export const ON_LIMIT_TEXT = { refuse: 'Refuses', wait: 'Waits for room', ask: 'Asks to raise it' } as const satisfies Record<BudgetView['onLimit'], string>;

/** How much of a budget is used: the fraction (0 to 1, capped), and its tone. */
export function budgetUse(budget: Pick<BudgetView, 'spent' | 'maxCost'>): { readonly fraction: number; readonly tone: Tone } {
  const fraction = budget.maxCost <= 0 ? 1 : Math.min(1, Math.max(0, budget.spent / budget.maxCost));
  return { fraction, tone: fraction >= 1 ? 'danger' : fraction >= 0.8 ? 'warn' : 'ok' };
}

/** A budget's amount in words: "$2.00 per day · 50k tokens". */
export function budgetAmount(budget: Pick<BudgetView, 'maxCost' | 'maxTokens' | 'maxCalls' | 'maxTime' | 'period'>): string {
  const parts = [`${formatCost(budget.maxCost)} ${periodText(budget.period)}`];
  if (budget.maxTokens !== undefined) { parts.push(`${budget.maxTokens.toLocaleString()} tokens`); }
  if (budget.maxCalls !== undefined) { parts.push(`${budget.maxCalls.toLocaleString()} calls`); }
  if (budget.maxTime !== undefined) { parts.push(`${formatDuration(budget.maxTime)} each`); }
  return parts.join(' · ');
}

/** The resolved view in sentences. */
export interface ResolvedText {
  readonly priority: string;
  readonly turn: string;
  /** The tightest budget's index in `budgets`, or -1 when nothing limits. */
  readonly tightest: number;
}

/** Explain resolved limits. */
export function resolvedText(resolved: ResolvedLimits): ResolvedText {
  const from = `${LEVEL_NAME[resolved.priorityFrom.default].toLowerCase()} default`;
  const capped = resolved.priorityFrom.cappedBy === undefined ? '' : `, capped by the ${LEVEL_NAME[resolved.priorityFrom.cappedBy].toLowerCase()}`;
  return {
    priority: `${PRIORITY_WORD[resolved.priority]}, from the ${from}${capped}.`,
    turn: `Each message may spend up to ${formatCost(resolved.turn.cost)} and run for ${formatDuration(resolved.turn.time)}.`,
    tightest: resolved.limitedBy === undefined ? -1 : resolved.budgets.findIndex((b) => b.rule === resolved.limitedBy),
  };
}
