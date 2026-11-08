import { describe, expect, it } from 'vitest';
import { budgetPlan, MIN_MARGIN, POOLS, promptMargin, waterFill } from './budget.ts';
import { seeded } from './testing.ts';
import { CALIBRATION, contextTokens, Estimator, MEDIA_PART_TOKENS, MESSAGE_FRAMING, nextRatio, rawTokens, toolChars } from './tokens.ts';

const LIMITS = { contextWindow: 4_096, maxOutputTokens: 512, reasoningTokens: 0, charsPerToken: 4 };

describe('token estimates', () => {
  it('count characters over characters per token, plus framing per message, times the ratio', () => {
    const plain = new Estimator('m', LIMITS, 1);
    expect(plain.text('x'.repeat(10))).toBe(3);
    expect(plain.message({ role: 'user', content: 'x'.repeat(40) })).toBe(10 + MESSAGE_FRAMING);
    expect(plain.message({ role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'fs__read', arguments: '{"path":"a"}' }] })).toBe(rawTokens(8 + 12, 4) + MESSAGE_FRAMING);
    expect(plain.message({ role: 'user', content: [{ type: 'text', content: 'abcd' }, { type: 'image', content: 'https://x' }] })).toBe(1 + MEDIA_PART_TOKENS + MESSAGE_FRAMING);
    const calibrated = new Estimator('m', LIMITS, 1.5);
    expect(calibrated.text('x'.repeat(40))).toBe(15);
    expect(new Estimator('m', { ...LIMITS, charsPerToken: 3.5 }, 1).text('x'.repeat(35))).toBe(10);
  });

  it('price a tool by its serialized definition', () => {
    const tool = { name: 'run', description: 'Run a fn.', parameters: { type: 'object', properties: { fn: { type: 'string' } } } };
    expect(toolChars(tool)).toBe(3 + 9 + JSON.stringify(tool.parameters).length);
    expect(new Estimator('m', LIMITS, 1).tool(tool)).toBe(rawTokens(toolChars(tool), 4) + MESSAGE_FRAMING);
  });

  it('move the calibration toward what the provider measured, clamped', () => {
    expect(nextRatio(1, 100, 200)).toBeCloseTo(1 + CALIBRATION.rate * (2 - 1));
    expect(nextRatio(1.1, 110, 100)).toBeCloseTo(1.1 + CALIBRATION.rate * (1 - 1.1));
    let ratio: number = CALIBRATION.start;
    for (let i = 0; i < 100; i++) ratio = nextRatio(ratio, 100 * ratio, 1_000);
    expect(ratio).toBe(CALIBRATION.max);
    for (let i = 0; i < 100; i++) ratio = nextRatio(ratio, 100 * ratio, 1);
    expect(ratio).toBe(CALIBRATION.min);
    expect(nextRatio(1.2, 0, 50)).toBe(1.2);
  });

  it('size context records at the default characters per token', () => {
    expect(contextTokens({ content: 'x'.repeat(400), description: 'about', summary: 'y'.repeat(40) })).toEqual({ full: 100, summary: 10 });
    expect(contextTokens({ description: 'x'.repeat(8) })).toEqual({ full: 0, summary: 2 });
  });
});

describe('the budget', () => {
  it('is the window less the reply, the reasoning and the margin', () => {
    const plan = budgetPlan({ ...LIMITS, reasoningTokens: 256 }, 600, 0.06, undefined);
    expect(plan.margin).toBe(Math.ceil(0.06 * 4_096));
    expect(plan.available).toBe(4_096 - 512 - 256 - plan.margin);
    expect(plan.flexible).toBe(plan.available - 600);
    expect(budgetPlan(LIMITS, 0, 0.06, 128).output).toBe(128);
    expect(promptMargin(256, 0.06)).toBe(MIN_MARGIN);
  });

  it('water-fills: shares first, the rest to hungry pools, never more than asked or than there is', () => {
    expect(waterFill({ history: 1_000, context: 1_000, fns: 1_000 }, { history: 0.5, context: 0.3, fns: 0.2 }, 1_000)).toEqual({ history: 500, context: 300, fns: 200 });
    expect(waterFill({ history: 100, context: 1_000, fns: 0 }, { history: 0.5, context: 0.3, fns: 0.2 }, 1_000)).toEqual({ history: 100, context: 900, fns: 0 });
    expect(waterFill({ history: 0, context: 50, fns: 50 }, { history: 0, context: 0, fns: 0 }, 1_000)).toEqual({ history: 0, context: 50, fns: 50 });
  });

  it('water-filling conserves the total for any asks and shares (seeded)', () => {
    const random = seeded(7);
    for (let i = 0; i < 300; i++) {
      const asks = { history: Math.floor(random() * 3_000), context: Math.floor(random() * 3_000), fns: Math.floor(random() * 3_000) };
      const shares = { history: random(), context: random(), fns: random() };
      const total = Math.floor(random() * 5_000);
      const got = waterFill(asks, shares, total);
      const sum = POOLS.reduce((s, p) => s + got[p], 0);
      expect(sum).toBeLessThanOrEqual(total);
      for (const pool of POOLS) expect(got[pool]).toBeLessThanOrEqual(asks[pool]);
      // nothing left over while someone still asks
      if (POOLS.some((p) => got[p] < asks[p])) expect(sum).toBe(total);
    }
  });
});
