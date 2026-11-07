/**
 * The spend ledger. Before an LLM call the hub holds an estimate against every budget that applies to the turn and
 * against the turn's own cap; after it, the real cost is settled as a ledger line. A budget refuses a call that would
 * take it over by more than the allowed overrun (estimates are rough, so a small overrun beats blocking), or asks it
 * to wait for its window when its rule says so. Every line also adds to its turn's cost.
 */
import {
  BudgetId, mintId, type ActorId, type BudgetRule, type LedgerEntry, type ReservationId, type ResolvedLimits, type RunId, type TurnId, type Usd,
} from '@harness/core';
import type { Ledger } from './index.ts';
import type { ExecutionBase } from './ports.ts';
import { budgetLabel, TURN_LABEL, type SpendReader } from './spend.ts';

/** The id that stands for a turn's own cap (the lowest per-turn budget, or the hub default) in refusals. */
export const TURN_CAP = BudgetId.parse('bgt_turn');

/** An estimate held until its call settles. */
interface Hold {
  readonly budgets: readonly BudgetId[];
  readonly turn: TurnId;
  readonly estimate: Usd;
}

/**
 * The ledger on the hub store. Open holds are kept in memory too, and reservations are checked one at a time, so
 * concurrent calls see each other's holds.
 */
export class HubLedger implements Ledger {
  readonly #deps: Pick<ExecutionBase, 'store' | 'clock' | 'random' | 'settings'>;
  readonly #spend: SpendReader;
  readonly #holds = new Map<ReservationId, Hold>();
  /** The last reservation being checked; the next one starts after it. */
  #checking: Promise<unknown> = Promise.resolve();

  constructor(deps: Pick<ExecutionBase, 'store' | 'clock' | 'random' | 'settings'>, spend: SpendReader) {
    this.#deps = deps;
    this.#spend = spend;
  }

  spent(rule: BudgetRule, input: { actor?: ActorId | undefined; now: number }): Promise<Usd> {
    return this.#spend.spent(rule, input);
  }

  reserve(input: { limits: ResolvedLimits; estimate: Usd; run: RunId }): ReturnType<Ledger['reserve']> {
    const checked = this.#checking.then(() => this.#reserve(input));
    this.#checking = checked.catch(() => undefined);
    return checked;
  }

  async #reserve(input: { limits: ResolvedLimits; estimate: Usd; run: RunId }): ReturnType<Ledger['reserve']> {
    const { store, clock, settings } = this.#deps;
    const run = await store.table('runs').get(input.run);
    if (run === undefined) throw new Error(`no run ${input.run} to reserve budget for`);
    const now = clock();
    const overrun = 1 + settings.execution.HARNESS_BUDGET_OVERRUN;
    const turnSpent = await this.#turnSpent(run.turn);
    if (turnSpent + input.estimate > input.limits.turn.cost * overrun) {
      return { ok: false, budget: TURN_CAP, reason: `this message's budget of $${input.limits.turn.cost.toFixed(2)} is used up` };
    }
    const rules = await this.#rules(input.limits);
    for (const rule of rules) {
      const spent = await this.#counted(rule, run.actor, now);
      if (spent + input.estimate <= rule.maxCost * overrun) continue;
      const reason = `the ${budgetLabel(rule.target, rule.share)} of $${rule.maxCost.toFixed(2)} is used up`;
      return rule.onLimit === 'wait' && rule.period !== 'all-time'
        ? { ok: false, budget: rule.id, reason, wait: settings.execution.HARNESS_BUDGET_RECHECK }
        : { ok: false, budget: rule.id, reason };
    }
    const id = mintId('reservation', this.#deps.random);
    const budgets = rules.map((r) => r.id);
    this.#holds.set(id, { budgets, turn: run.turn, estimate: input.estimate });
    await store.table('reservations').insert({ id, budgets, estimate: input.estimate, createdAt: now });
    return { ok: true, reservation: id };
  }

  async settle(reservation: ReservationId, entry: Omit<LedgerEntry, 'id' | 'at'>): Promise<void> {
    const { store, clock } = this.#deps;
    const held = await store.table('reservations').get(reservation);
    if (held === undefined) throw new Error(`no reservation ${reservation}`);
    this.#holds.delete(held.id);
    if (held.settled !== undefined) return;
    const at = clock();
    await store.table('reservations').update(held.id, { settled: { cost: entry.cost, at } });
    await this.record(entry);
  }

  async record(entry: Omit<LedgerEntry, 'id' | 'at'>): Promise<void> {
    const { store, clock } = this.#deps;
    await store.table('ledger').insert({ ...entry, id: mintId('ledger', this.#deps.random), at: clock() });
    if (entry.cost === 0) return;
    const run = await store.table('runs').get(entry.run);
    if (run === undefined) return;
    await store.tx(async (tx) => {
      const turn = await tx.table('turns').get(run.turn);
      if (turn !== undefined) await tx.table('turns').update(turn.id, { cost: turn.cost + entry.cost });
    });
  }

  async remaining(limits: ResolvedLimits, who?: { turn: TurnId; actor: ActorId }): Promise<{ cost: Usd; limitedBy: string }> {
    const now = this.#deps.clock();
    let cost = limits.turn.cost - (who === undefined ? 0 : await this.#turnSpent(who.turn));
    let limitedBy = TURN_LABEL;
    for (const rule of await this.#rules(limits)) {
      const left = rule.maxCost - (await this.#counted(rule, who?.actor, now));
      if (left < cost) {
        cost = left;
        limitedBy = budgetLabel(rule.target, rule.share);
      }
    }
    return { cost: Math.max(0, cost), limitedBy };
  }

  /** What a turn has spent and holds. */
  async #turnSpent(turn: TurnId): Promise<Usd> {
    const row = await this.#deps.store.table('turns').get(turn);
    return (row?.cost ?? 0) + this.#held((hold) => hold.turn === turn);
  }

  /** What a budget counts: settled spend in its period plus what open calls hold against it. */
  async #counted(rule: BudgetRule, actor: ActorId | undefined, now: number): Promise<Usd> {
    return (await this.#spend.spent(rule, { actor, now })) + this.#held((hold) => hold.budgets.includes(rule.id));
  }

  #held(applies: (hold: Hold) => boolean): Usd {
    let sum = 0;
    for (const hold of this.#holds.values()) if (applies(hold)) sum += hold.estimate;
    return sum;
  }

  /** The window and all-time budgets a turn's limits name, as stored now (a rule removed since no longer counts). */
  async #rules(limits: ResolvedLimits): Promise<BudgetRule[]> {
    const table = this.#deps.store.table('budgets');
    const rules = await Promise.all(limits.budgets.map((b) => table.get(b.rule)));
    return rules.filter((r): r is BudgetRule => r !== undefined);
  }
}
