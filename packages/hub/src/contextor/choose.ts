/**
 * Choosing what goes in a prompt, and at what detail: a multiple-choice knapsack solved greedily by value per token.
 * Every unit (an item with what it hard-links, or an earlier exchange) has levels of rising cost and quality; a unit
 * at level `d` is worth `activation × quality(d)`. Forced units (always-items, `/command` items, loaded items) are
 * charged first at their forced level, stepping down when even that won't fit. Then, repeatedly, the upgrade with
 * the best value per extra token that fits is applied: first within each pool's water-filled share, then within
 * whatever is left of the whole budget, so no upgrade that would fit is ever left out and the total never exceeds it.
 */
import type { BudgetShares, Detail } from '@harness/core';
import { POOLS, waterFill, type Pool, type PoolTokens } from './budget.ts';

/** How much of an item's value each detail carries. */
export const DETAIL_QUALITY: Readonly<Record<Detail, number>> = { listed: 0.15, signature: 0.6, full: 1 };

/** One level of a unit: its detail and what the whole unit costs at it, in tokens. */
export interface Level {
  readonly detail: Detail;
  readonly cost: number;
}

/** Something that goes in the prompt whole, at one of its levels. */
export interface Unit {
  readonly key: string;
  readonly pool: Pool;
  readonly activation: number;
  /** From the least to the most detail. */
  readonly levels: readonly Level[];
  /** The level (index) it must have at least, charged before anything else. */
  readonly forced?: number | undefined;
  /** Its level last cycle (index), which wins ties so the prompt stays stable. */
  readonly last?: number | undefined;
}

/** What was cut to fit, and why. */
export interface Cut {
  readonly what: string;
  readonly why: string;
}

/** What `choose` decided. */
export interface Choice {
  /** Unit key → the level index chosen. Units left out are absent. */
  readonly chosen: ReadonlyMap<string, number>;
  /** Tokens each pool spent (forced units included). */
  readonly used: PoolTokens;
  /** What each pool asked for (everything eligible at its most detail). */
  readonly asked: PoolTokens;
  readonly total: number;
  readonly cut: readonly Cut[];
}

/** Choose levels for units within `budget` tokens shared by `shares`. Units below `threshold` are only taken when forced. */
export function choose(units: readonly Unit[], shares: BudgetShares, budget: number, threshold: number): Choice {
  const chosen = new Map<string, number>();
  const used: Record<Pool, number> = { history: 0, context: 0, fns: 0 };
  const asked: Record<Pool, number> = { history: 0, context: 0, fns: 0 };
  const cut: Cut[] = [];
  let left = Math.max(0, Math.floor(budget));
  const costAt = (unit: Unit, level: number | undefined): number => (level === undefined ? 0 : unit.levels[level]?.cost ?? 0);

  // forced units first, stepping down a level at a time until one fits
  for (const unit of units) {
    if (unit.forced === undefined) continue;
    let level: number | undefined = Math.min(unit.forced, unit.levels.length - 1);
    while (level !== undefined && costAt(unit, level) > left) level = level > 0 ? level - 1 : undefined;
    const wanted = unit.levels[Math.min(unit.forced, unit.levels.length - 1)]?.detail;
    if (level === undefined) { cut.push({ what: unit.key, why: `left out: even its shortest form does not fit the ${left} tokens left` }); continue; }
    const detail = unit.levels[level]?.detail;
    if (detail !== wanted && detail !== undefined) cut.push({ what: unit.key, why: `shown at ${detail} instead of ${wanted ?? detail} to fit` });
    chosen.set(unit.key, level);
    used[unit.pool] += costAt(unit, level);
    left -= costAt(unit, level);
  }

  const eligible = units.filter((unit) => unit.forced !== undefined || unit.activation >= threshold);
  for (const unit of eligible) asked[unit.pool] += Math.max(0, costAt(unit, unit.levels.length - 1) - costAt(unit, chosen.get(unit.key)));
  const caps = waterFill(asked, shares, left);
  const spent: Record<Pool, number> = { history: 0, context: 0, fns: 0 };

  const next = (unit: Unit): { level: number; extra: number; ratio: number } | undefined => {
    const current = chosen.get(unit.key);
    const level = current === undefined ? 0 : current + 1;
    const to = unit.levels[level];
    if (to === undefined) return undefined;
    const extra = to.cost - costAt(unit, current);
    const gain = unit.activation * (DETAIL_QUALITY[to.detail] - (current === undefined ? 0 : DETAIL_QUALITY[unit.levels[current]?.detail ?? 'listed']));
    return { level, extra, ratio: extra <= 0 ? Number.POSITIVE_INFINITY : gain / extra };
  };
  const better = (a: { unit: Unit; level: number; ratio: number }, b: { unit: Unit; level: number; ratio: number }): boolean => {
    if (Math.abs(a.ratio - b.ratio) > 1e-12 * Math.max(1, Math.abs(b.ratio))) return a.ratio > b.ratio;
    const stayA = (a.unit.last ?? -1) >= a.level;
    const stayB = (b.unit.last ?? -1) >= b.level;
    if (stayA !== stayB) return stayA;
    if (a.unit.activation !== b.unit.activation) return a.unit.activation > b.unit.activation;
    return a.unit.key < b.unit.key;
  };

  for (const phase of ['shares', 'rest'] as const) {
    for (;;) {
      let best: { unit: Unit; level: number; extra: number; ratio: number } | undefined;
      for (const unit of eligible) {
        const upgrade = next(unit);
        if (upgrade === undefined || upgrade.extra > left) continue;
        if (phase === 'shares' && spent[unit.pool] + upgrade.extra > caps[unit.pool]) continue;
        const candidate = { unit, ...upgrade };
        if (best === undefined || better(candidate, best)) best = candidate;
      }
      if (best === undefined) break;
      chosen.set(best.unit.key, best.level);
      used[best.unit.pool] += best.extra;
      spent[best.unit.pool] += best.extra;
      left -= best.extra;
    }
  }
  return { chosen, used, asked, total: POOLS.reduce((sum, pool) => sum + used[pool], 0), cut };
}
