/**
 * Budgets and priorities: every budget (with what it has spent this period) and priority rule, saving and removing
 * them, and the resolved view: the one priority and set of budgets a message by a person (in a chat) would get now.
 */
import type { ActorId, BudgetId, PriorityRule, PriorityRuleId, ResolvedLimits, SessionId } from '@harness/core';
import { Loaded, Task, type TaskResult } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import type { BudgetView } from '@harness/core';
import type { BudgetBody, PriorityBody } from '../logic/forms.ts';

type LimitsApi = Pick<AdminApi, 'budgets' | 'setBudget' | 'priorityRules' | 'setPriority' | 'resolveLimits' | 'removeRule'>;

/** The limits page's state. */
export class LimitsStore {
  readonly #api: LimitsApi;
  readonly budgets = new Loaded<readonly BudgetView[]>();
  readonly priorities = new Loaded<readonly PriorityRule[]>();
  readonly resolved = new Loaded<ResolvedLimits>();
  readonly save = new Task();
  readonly remove = new Task();

  constructor(api: LimitsApi) {
    this.#api = api;
  }

  async load(quiet = false): Promise<void> {
    await Promise.all([this.#loadBudgets(quiet), this.#loadPriorities(quiet)]);
  }

  async saveBudget(body: BudgetBody): Promise<TaskResult<{ id: string }>> {
    const result = await this.save.run(() => this.#api.setBudget.call(body), "Couldn't save the budget.");
    if (result.ok) { void this.#loadBudgets(true); }
    return result;
  }

  async savePriority(body: PriorityBody): Promise<TaskResult<{ id: string }>> {
    const result = await this.save.run(() => this.#api.setPriority.call(body), "Couldn't save the priority rule.");
    if (result.ok) { void this.#loadPriorities(true); }
    return result;
  }

  async removeBudget(id: BudgetId): Promise<boolean> {
    const result = await this.remove.run(() => this.#api.removeRule.call({ kind: 'budget', id }), "Couldn't remove the budget.");
    if (result.ok) { this.budgets.set((this.budgets.value.value ?? []).filter((b) => b.id !== id)); }
    return result.ok;
  }

  async removePriority(id: PriorityRuleId): Promise<boolean> {
    const result = await this.remove.run(() => this.#api.removeRule.call({ kind: 'priority', id }), "Couldn't remove the priority rule.");
    if (result.ok) { this.priorities.set((this.priorities.value.value ?? []).filter((p) => p.id !== id)); }
    return result.ok;
  }

  /** Work out the limits for a person, in a chat when given. */
  async resolve(user: ActorId, session?: SessionId): Promise<void> {
    await this.resolved.load(() => this.#api.resolveLimits.call({ user, ...(session === undefined ? {} : { session }) }), "Couldn't work out the limits.");
  }

  #loadBudgets(quiet: boolean): Promise<void> {
    return this.budgets.load(() => this.#api.budgets.call({}), "Couldn't load budgets.", quiet);
  }

  #loadPriorities(quiet: boolean): Promise<void> {
    return this.priorities.load(() => this.#api.priorityRules.call({}), "Couldn't load priority rules.", quiet);
  }
}
