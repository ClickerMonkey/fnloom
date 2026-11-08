import { describe, expect, it } from 'vitest';
import { choose, DETAIL_QUALITY, type Unit } from './choose.ts';
import { baseScore, METRIC_DEFAULTS, metricSettings, rbf, spread, wordShare, words } from './score.ts';
import { seeded } from './testing.ts';

const SHARES = { history: 0.45, context: 0.35, fns: 0.2 };

/** A unit with listed / signature / full at these costs. */
function unit(key: string, activation: number, costs: readonly [number, number, number], extra: Partial<Unit> = {}): Unit {
  return { key, pool: 'context', activation, levels: [{ detail: 'listed', cost: costs[0] }, { detail: 'signature', cost: costs[1] }, { detail: 'full', cost: costs[2] }], ...extra };
}

describe('scores', () => {
  it('rbf peaks at its target', () => {
    expect(rbf(1, 1, 4)).toBe(1);
    expect(rbf(0.5, 1, 4)).toBeLessThan(1);
    expect(rbf(0, 1, 4)).toBeLessThan(rbf(0.5, 1, 4));
  });

  it('a metric without a signal drops out of both sums; the score stays within the weight; weight 0 excludes', () => {
    const settings = metricSettings({});
    expect(baseScore({ embedding: 1 }, 1, settings)).toBe(1);
    expect(baseScore({ embedding: 1, words: undefined }, 1, settings)).toBe(1);
    expect(baseScore({}, 1, settings)).toBe(0);
    const score = baseScore({ embedding: 0.4, words: 0.1, turnsAgo: 3 }, 0.8, settings);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(0.8);
    expect(baseScore({ embedding: 1 }, 0, settings)).toBe(0);
  });

  it('session overrides replace a metric and keep the defaults of what they leave out', () => {
    const settings = metricSettings({ words: { weight: 2 } });
    expect(settings.words).toEqual({ weight: 2, target: METRIC_DEFAULTS.words.target, k: METRIC_DEFAULTS.words.k });
    expect(settings.embedding).toEqual(METRIC_DEFAULTS.embedding);
  });

  it('spreading with no damping is the base score, and reaches items only linked', () => {
    const base = new Map([['a', 1], ['b', 0]]);
    expect(spread(base, [{ from: 'a', to: 'c', weight: 1 }], 0, 2).get('c')).toBe(0);
    const spreadOut = spread(base, [{ from: 'a', to: 'c', weight: 1 }], 0.5, 2);
    expect(spreadOut.get('c')).toBeGreaterThan(0);
    expect(spreadOut.get('a')).toBeGreaterThanOrEqual(1);
  });

  it('a two-node cycle stays bounded, and an item with many links passes on no more than one with one', () => {
    const cycle = spread(new Map([['a', 1], ['b', 1]]), [{ from: 'a', to: 'b', weight: 1 }, { from: 'b', to: 'a', weight: 1 }], 0.5, 4);
    expect(cycle.get('a')).toBeLessThan(1 / (1 - 1.5 * 0.5));
    const many = spread(new Map([['hub', 1]]), Array.from({ length: 50 }, (_, i) => ({ from: 'hub', to: `x${i}`, weight: 1 })), 0.5, 1);
    const one = spread(new Map([['hub', 1]]), [{ from: 'hub', to: 'x0', weight: 1 }], 0.5, 1);
    const passed = [...many].filter(([k]) => k.startsWith('x')).reduce((s, [, v]) => s + v, 0);
    expect(passed).toBeLessThanOrEqual((one.get('x0') ?? 0) + 1e-9);
  });

  it('word share is the part of the query the text has', () => {
    const query = words('How do I read a file with fs?');
    expect(query.has('read')).toBe(true);
    expect(query.has('the')).toBe(false);
    expect(wordShare(query, 'Read a file.')).toBeCloseTo(2 / query.size);
    expect(wordShare(new Set(), 'x')).toBeUndefined();
  });
});

describe('choosing details', () => {
  it('picks the best value per token, and takes a short form when only that fits', () => {
    const choice = choose([unit('big', 1, [5, 60, 2_000]), unit('small', 0.5, [5, 20, 80])], SHARES, 200, 0.1);
    expect(choice.chosen.get('small')).toBe(2);
    expect(choice.chosen.get('big')).toBe(1);
    expect(choice.total).toBeLessThanOrEqual(200);
  });

  it('charges forced units first, stepping them down to fit and saying so', () => {
    const choice = choose([unit('always', 0, [5, 50, 500], { forced: 2 }), unit('other', 1, [5, 10, 20])], SHARES, 100, 0.1);
    expect(choice.chosen.get('always')).toBe(1);
    expect(choice.cut.map((c) => c.what)).toEqual(['always']);
    expect(choose([unit('huge', 0, [500, 600, 700], { forced: 0 })], SHARES, 100, 0.1).chosen.has('huge')).toBe(false);
  });

  it('leaves out units below the threshold unless forced', () => {
    const choice = choose([unit('weak', 0.05, [1, 2, 3]), unit('loaded', 0.05, [1, 2, 3], { forced: 1 })], SHARES, 1_000, 0.1);
    expect(choice.chosen.has('weak')).toBe(false);
    expect(choice.chosen.get('loaded')).toBe(2);
  });

  it('breaks ties toward last cycle\'s items, then higher activation', () => {
    const tie = choose([unit('a', 1, [10, 20, 30]), unit('b', 1, [10, 20, 30], { last: 0 })], SHARES, 10, 0.1);
    expect([...tie.chosen.keys()]).toEqual(['b']);
  });

  it('gives a pool\'s unused share to the others', () => {
    const choice = choose([unit('ctx', 1, [10, 100, 900])], SHARES, 1_000, 0.1);
    expect(choice.chosen.get('ctx')).toBe(2);
  });

  it('property: never over budget, and no upgrade that would fit is left out (500 seeded pools)', () => {
    const random = seeded(42);
    for (let round = 0; round < 500; round++) {
      const units: Unit[] = Array.from({ length: 1 + Math.floor(random() * 30) }, (_, i) => {
        const listed = 1 + Math.floor(random() * 20);
        const signature = listed + Math.floor(random() * 200);
        const full = signature + Math.floor(random() * 2_000);
        const pool = (['history', 'context', 'fns'] as const)[Math.floor(random() * 3)] ?? 'context';
        return unit(`u${i}`, random(), [listed, signature, full], { pool, ...(random() < 0.1 ? { forced: Math.floor(random() * 3) } : {}) });
      });
      const budget = Math.floor(random() * 6_000);
      const shares = { history: random(), context: random(), fns: random() };
      const choice = choose(units, shares, budget, 0.15);
      const total = units.reduce((sum, u) => { const level = choice.chosen.get(u.key); return sum + (level === undefined ? 0 : u.levels[level]?.cost ?? 0); }, 0);
      expect(total).toBe(choice.total);
      expect(total).toBeLessThanOrEqual(budget);
      const left = budget - total;
      for (const u of units) {
        if (u.forced === undefined && u.activation < 0.15) continue;
        const level = choice.chosen.get(u.key);
        const nextLevel = level === undefined ? 0 : level + 1;
        const to = u.levels[nextLevel];
        if (to === undefined) continue;
        const extra = to.cost - (level === undefined ? 0 : u.levels[level]?.cost ?? 0);
        expect(extra).toBeGreaterThan(left);
      }
    }
  });

  it('values detail by quality', () => {
    expect(DETAIL_QUALITY.listed).toBeLessThan(DETAIL_QUALITY.signature);
    expect(DETAIL_QUALITY.signature).toBeLessThan(DETAIL_QUALITY.full);
  });
});
