/**
 * The budget of one prompt. A request may hold `B = W − O − M` tokens: the window, less the reply reserve (the
 * answer plus a reasoning model's thinking), less a safety margin for estimate error (`max(64, ⌈share · W⌉)`). The
 * fixed part (instructions, the mode's tools, the current turn) is charged first; what is left is shared by history,
 * context and fns by water-filling: each pool gets at most its share, and what a pool leaves unused flows to the
 * pools still asking, in proportion to their shares.
 */
import type { BudgetShares, ResolvedModelLimits } from '@harness/core';
import type { BudgetPlan } from './index.ts';

/** The pools the flexible budget is shared by. */
export const POOLS = ['history', 'context', 'fns'] as const;
export type Pool = (typeof POOLS)[number];

/** Tokens per pool. */
export type PoolTokens = Readonly<Record<Pool, number>>;

/** The least margin a prompt keeps free, whatever its window. */
export const MIN_MARGIN = 64;

/** The margin kept free in a window. */
export function promptMargin(window: number, share: number): number {
  return Math.max(MIN_MARGIN, Math.ceil(share * window));
}

/** The reply reserve: the answer's tokens, capped by what the agent asks for, plus the model's thinking. */
export function replyReserve(limits: ResolvedModelLimits, maxOutput?: number): { output: number; reasoning: number } {
  return { output: Math.min(limits.maxOutputTokens, maxOutput ?? Number.POSITIVE_INFINITY), reasoning: limits.reasoningTokens };
}

/** Work out one prompt's budget before anything is chosen. */
export function budgetPlan(limits: ResolvedModelLimits, fixed: number, marginShare: number, maxOutput?: number): BudgetPlan {
  const margin = promptMargin(limits.contextWindow, marginShare);
  const { output, reasoning } = replyReserve(limits, maxOutput);
  const available = Math.max(0, limits.contextWindow - output - reasoning - margin);
  return { limits, margin, available, fixed, flexible: available - fixed, output, reasoning };
}

/**
 * Share `total` tokens between pools that ask for `asks`: each gets at most its ask; a pool's share of what is left
 * is in proportion to its weight among the pools still asking, repeated until nothing is left or nobody asks. The
 * result never sums to more than `total` and never gives a pool more than it asked. Pools with no share (all zero)
 * split evenly.
 */
export function waterFill(asks: PoolTokens, shares: BudgetShares, total: number): PoolTokens {
  const got: Record<Pool, number> = { history: 0, context: 0, fns: 0 };
  let left = Math.max(0, Math.floor(total));
  const hungry = (): Pool[] => POOLS.filter((pool) => got[pool] < asks[pool]);
  for (let round = 0; left > 0; round++) {
    const pools = hungry();
    if (pools.length === 0) break;
    const weights = pools.map((pool) => shares[pool]);
    const sum = weights.reduce((a, b) => a + b, 0);
    let given = 0;
    pools.forEach((pool, i) => {
      const weight = sum > 0 ? (weights[i] ?? 0) / sum : 1 / pools.length;
      const offer = round > 8 ? left - given : Math.floor(left * weight);
      const take = Math.min(asks[pool] - got[pool], Math.max(0, offer));
      got[pool] += take;
      given += take;
    });
    left -= given;
    // rounding gave nobody anything: hand the rest out one pool at a time, by share
    if (given === 0) {
      for (const pool of [...pools].sort((a, b) => shares[b] - shares[a])) {
        const take = Math.min(asks[pool] - got[pool], left);
        got[pool] += take;
        left -= take;
      }
      break;
    }
  }
  return got;
}
