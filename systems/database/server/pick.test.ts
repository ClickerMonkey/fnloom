/**
 * Picking the database a request is for: the one named, the only one, the decision model's pick, the scores when it
 * is off or failed, and the question for the person when it stays unclear.
 */
import type { DecideAnswer } from '@harness/core';
import { describe, expect, it } from 'vitest';
import type { FleetMember } from './impl.ts';
import { matchScore, pickDatabase, wordsOf } from './pick.ts';

const shop: FleetMember = { instance: 'main', label: 'Shop', tables: ['customers (people who buy)', 'orders (one per checkout)'] };
const billing: FleetMember = { instance: 'billing', label: 'Billing', tables: ['invoices (one per bill)', 'payments'] };
const limits = { min: 0.2, margin: 0.15 };

function input(description: string, answer: DecideAnswer, extra: { asked?: string; members?: FleetMember[] } = {}) {
  const asked: string[] = [];
  return {
    asked,
    input: {
      description, asked: extra.asked, members: extra.members ?? [shop, billing],
      decide: (question: string) => { asked.push(question); return Promise.resolve(answer); },
    },
  };
}

describe('picking a database', () => {
  it('scores by the request words the tables hold', () => {
    expect([...wordsOf('Overdue invoices by customer')]).toEqual(['overdue', 'invoice', 'by', 'customer'].filter((word) => word.length > 2));
    expect(matchScore(wordsOf('overdue invoices'), billing)).toBe(0.5);
    expect(matchScore(wordsOf('overdue invoices'), shop)).toBe(0);
  });

  it('takes the named database, or the only one, without asking the decision model', async () => {
    const named = input('paid orders', { by: 'off' }, { asked: 'database/main' });
    expect(await pickDatabase(named.input, limits)).toMatchObject({ database: 'main', by: 'asked' });
    expect(await pickDatabase(input('paid orders', { by: 'off' }, { asked: 'billing' }).input, limits)).toMatchObject({ database: 'billing', by: 'asked' });
    expect(await pickDatabase(input('x', { by: 'off' }, { asked: 'nope' }).input, limits)).toHaveProperty('invalid', expect.stringContaining('main (Shop), billing (Billing)'));
    const only = input('anything', { by: 'off' }, { members: [shop] });
    expect(await pickDatabase(only.input, limits)).toMatchObject({ database: 'main', by: 'only' });
    const inText = input('In the billing database: unpaid invoices', { by: 'off' });
    expect(await pickDatabase(inText.input, limits)).toMatchObject({ database: 'billing', by: 'asked' });
    expect(inText.asked).toEqual([]);
    expect(await pickDatabase(input('the Shop database or the Billing database', { by: 'off' }).input, limits)).toHaveProperty('ask');
    expect(named.asked).toEqual([]);
    expect(only.asked).toEqual([]);
    expect(await pickDatabase(input('x', { by: 'off' }, { members: [] }).input, limits)).toHaveProperty('invalid', expect.stringContaining('no database'));
  });

  it('goes with the decision model, and asks the person when it picks none', async () => {
    const picked = input('overdue invoices', { by: 'decision', picked: [{ id: 'billing', why: 'Invoices live in Billing.' }] });
    expect(await pickDatabase(picked.input, limits)).toEqual({ database: 'billing', label: 'Billing', by: 'decision', why: 'Invoices live in Billing.' });
    expect(picked.asked[0]).toContain('overdue invoices');
    expect(await pickDatabase(input('orders and invoices', { by: 'decision', picked: [] }).input, limits)).toEqual({ ask: 'Which database: Shop or Billing?', databases: ['main', 'billing'] });
  });

  it('goes by the scores when the decision model is off or failed, asking when no database leads clearly', async () => {
    expect(await pickDatabase(input('overdue invoices', { by: 'off' }).input, limits)).toMatchObject({ database: 'billing', by: 'score' });
    expect(await pickDatabase(input('overdue invoices', { by: 'failed', message: 'timeout' }).input, limits)).toMatchObject({ database: 'billing', by: 'score' });
    expect(await pickDatabase(input('everything from last week', { by: 'off' }).input, limits)).toMatchObject({ ask: 'Which database: Shop or Billing?' });
    expect(await pickDatabase(input('orders and invoices', { by: 'off' }).input, limits)).toHaveProperty('ask');
  });
});
