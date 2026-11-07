/**
 * Reading spend from the ledger: what has gone against a budget in its current period. A budget's scope decides which
 * ledger lines count: everything (the hub), one user, the members of a pooled group, one session, system, fn or model.
 */
import type { ActorId, BudgetRule, LedgerEntry, LimitScope, Usd } from '@harness/core';
import type { HubStore, Where } from '../store/index.ts';
import { allRows, rows } from './pages.ts';


/** What has been spent against budgets. */
export interface SpendReader {
  /**
   * The spend counted by a budget in its current period (window or all time). `actor` is whose allowance an
   * each-member group budget counts; without one it counts nothing. Per-turn budgets count a turn's own cost instead.
   */
  spent(rule: BudgetRule, input: { actor?: ActorId | undefined; now: number }): Promise<Usd>;
}

/** Spend added up from the ledger table, page by page. */
export class LedgerSpend implements SpendReader {
  readonly #store: HubStore;

  constructor(store: HubStore) {
    this.#store = store;
  }

  async spent(rule: BudgetRule, input: { actor?: ActorId | undefined; now: number }): Promise<Usd> {
    if (rule.period === 'per-turn') return 0;
    const scope = await this.#where(rule.target, rule.share, input.actor);
    if (scope === undefined) return 0;
    const where: Where<LedgerEntry> = rule.period === 'all-time' ? scope : { ...scope, at: { gt: input.now - rule.period.window } };
    let total = 0;
    for await (const entry of rows(this.#store.table('ledger'), { where })) total += entry.cost;
    return total;
  }

  /** The ledger lines a scope counts; undefined when it counts none (a group with no members, a turn-scoped window). */
  async #where(target: LimitScope, share: BudgetRule['share'], actor: ActorId | undefined): Promise<Where<LedgerEntry> | undefined> {
    switch (target.scope) {
      case 'hub': return {};
      case 'user': return { actor: target.user };
      case 'session': return { session: target.session };
      case 'system': return { system: target.system };
      case 'fn': return { fn: target.fn };
      case 'model': return { model: target.model };
      case 'turn': return undefined;
      case 'group': {
        if (share === 'each') return actor === undefined ? undefined : { actor };
        const members = await this.#members(target.group);
        return members.length === 0 ? undefined : { actor: { in: members } };
      }
    }
  }

  async #members(group: ActorId): Promise<ActorId[]> {
    return (await allRows(this.#store.table('memberships'), { where: { group } })).map((m) => m.user);
  }
}

/** How the turn's own cap reads ("limited by: this message"). */
export const TURN_LABEL = 'this message';

/** A budget's level, as people read it ("limited by: session total"). */
export function budgetLabel(scope: LimitScope, share?: BudgetRule['share']): string {
  switch (scope.scope) {
    case 'hub': return 'hub budget';
    case 'group': return share === 'each' ? 'group allowance' : 'group budget';
    case 'user': return 'your budget';
    case 'session': return 'session total';
    case 'turn': return TURN_LABEL;
    case 'system': return `${scope.system} budget`;
    case 'fn': return `${scope.fn} budget`;
    case 'model': return `${scope.model} budget`;
  }
}
