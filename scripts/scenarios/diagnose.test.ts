/**
 * The diagnostician's leak check: a fix's proposedText goes into prompts that serve every request, so one that uses its
 * case's own words (its subject, names, places, amounts) is left out and recorded (Phil, 2026-11-23: "no llm guidance
 * on groceries as an example ... This system is meant to be general purpose").
 */
import { describe, expect, it } from 'vitest';
import { caseWords, iterationDiagnosisMarkdown, leakedWords, textStems, type IterationDiagnosis } from './diagnose.ts';

describe('the diagnostician\'s leak check', () => {
  it('finds a case\'s subject words, its data and the family in a fix, plurals and possessives included', () => {
    expect(leakedWords('Offer a table to log each grocery trip, such as Kroger, $172.48.', [2])).toEqual(['172.48', 'grocery', 'kroger', 'trip']);
    expect(leakedWords('Search memories before suggesting snacks: Leo\'s peanut allergy matters.', [28])).toEqual(['allergy', 'leo', 'peanut', 'snack']);
    expect(leakedWords('For Columbus, check the forecast.', [1])).toEqual(['columbu']);
  });

  it('lets general wording through: common words, the app\'s own words, years and another case\'s subject', () => {
    expect(leakedWords('When the person wants to keep track of entries of any kind (amounts, dates, notes), make a table with database/create_table, then its fns, and show them a way to add one each time.', [2])).toEqual([]);
    expect(leakedWords('Give both ends of a time window, such as 2026-11-01 to 2026-11-30 in 2026.', [3])).toEqual([]);
    expect(leakedWords('Groceries are not this case\'s subject.', [3])).toEqual([]);
  });

  it('counts a word of four letters or more, and a number of three digits or more that is not a year', () => {
    expect([...textStems('a cat, the dogs, 12 and 150, in 2026, a 16x25x1 filter')].sort()).toEqual((['150', '16x25x1', 'dog', 'filter']).sort());
    expect(caseWords(5).has('furnace')).toBe(true);
    expect(caseWords(5).has('when')).toBe(false);
  });

  it('lists the fixes it left out in the iteration\'s markdown', () => {
    const result: IterationDiagnosis = {
      iteration: 'iter-x', writtenAt: '2026-11-23T00:00:00Z', model: 'm', diagnosed: 1, failed: [], causes: {}, byVariant: [], fixes: [], merges: [],
      leaked: [{ where: 'context:hub/saved_fns', words: ['grocery'], proposedText: 'Log each grocery trip.', from: [{ case: 2, rep: 1 }] }],
      cost: { cases: 0, merge: 0 }, rootCauses: [],
    };
    const markdown = iterationDiagnosisMarkdown(result);
    expect(markdown).toContain('## Fixes left out: they used their cases\' own words (1)');
    expect(markdown).toContain('`context:hub/saved_fns` from [2/r1](rep-1/cases/case-02.md) (grocery): Log each grocery trip.');
  });
});
