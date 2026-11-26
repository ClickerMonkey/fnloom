import { describe, expect, it } from 'vitest';
import { CASE_SETS, CASES, FIXTURE_FILES, neededSystems, parseCaseIds, pickCases, stepNotes, wholeSet } from './cases.ts';
import { FIXTURES } from './fixtures/make.ts';

describe('the cases', () => {
  it('are numbered 1 to 80 in two sets of 40, each id once', () => {
    expect(CASES.map((c) => c.id)).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
    expect(CASE_SETS.first.map((c) => c.id)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(CASE_SETS.second.map((c) => c.id)).toEqual(Array.from({ length: 40 }, (_, i) => i + 41));
  });

  it('attach only files the fixtures make, and say what each step\'s other person knows', () => {
    for (const file of FIXTURE_FILES) { expect(FIXTURES[file]).toBeDefined(); }
    for (const played of CASES) {
      expect(played.good.length, `case ${played.id}`).toBeGreaterThan(20);
      for (const step of played.steps) {
        for (const file of step.files ?? []) { expect(FIXTURE_FILES).toContain(file); }
        if (step.as !== undefined) { expect(step.wants, `case ${played.id}`).toBeDefined(); }
        // a step sent while another runs goes to the same chat, by the same person
        if (step.whileRunning === true) { expect(step.as === undefined && step.newChat !== true, `case ${played.id}`).toBe(true); }
      }
    }
  });

  it('a plain run is the first 40; --cases takes ids, ranges and set names', () => {
    expect(pickCases(undefined).map((c) => c.id)).toEqual(CASE_SETS.first.map((c) => c.id));
    expect(parseCaseIds('41-43,45')).toEqual([41, 42, 43, 45]);
    expect(parseCaseIds('3, 1, 3')).toEqual([3, 1]);
    expect(parseCaseIds('second')).toEqual(CASE_SETS.second.map((c) => c.id));
    expect(parseCaseIds('all')).toHaveLength(80);
    expect(() => parseCaseIds('41-x')).toThrow(/not an id/);
    expect(() => pickCases([81])).toThrow(/no case 81/);
    expect(wholeSet(pickCases(undefined))).toBe(true);
    expect(wholeSet(pickCases(parseCaseIds('41-80')))).toBe(true);
    expect(wholeSet(pickCases([1, 2]))).toBe(false);
  });

  it('runs the schedule system only for the cases that need it', () => {
    expect(neededSystems(pickCases(undefined))).toEqual([]);
    expect(neededSystems(pickCases([59, 41]))).toEqual(['schedule']);
    const sara = CASES.find((c) => c.id === 44)?.steps[1];
    expect(sara === undefined ? '' : stepNotes(sara)).toContain('as Sara Parker');
  });
});
