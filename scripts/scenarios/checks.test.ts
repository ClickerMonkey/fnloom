import { describe, expect, it } from 'vitest';
import { argMistakes, argMistakesLine, brokenRun, callTrouble, hardChecks } from './checks.ts';
import type { CaseRecord, ToolRun } from './records.ts';
import { runLine } from './transcript.ts';

const run = (over: Partial<ToolRun>): ToolRun => ({ run: 'r', fn: 'fs/read', depth: 1, status: 'done', args: '{}', outcome: '"ok"', cost: 0, ...over });

describe('tool call trouble', () => {
  it('keeps the model’s arg mistakes apart from real failures and refusals', () => {
    expect(callTrouble(run({ status: 'failed', outcome: 'failed: disk full' }))).toBe('tool-failure');
    expect(callTrouble(run({ status: 'invalid-input', outcome: 'invalid input: {"source":"schema","problems":[]}' }))).toBe('model-arg-mistake');
    expect(callTrouble(run({ status: 'invalid-input', outcome: 'invalid input: {"source":"json","raw":"Stopped by the hub: …"}' }))).toBe('model-arg-mistake');
    expect(callTrouble(run({ status: 'invalid-input', outcome: 'invalid input: {"source":"unavailable","problems":[]}' }))).toBe('refusal');
    expect(callTrouble(run({ status: 'done', repairs: 1 }))).toBe('model-arg-mistake');
    expect(callTrouble(run({ run: '(no run)', status: 'tool-error', outcome: 'There is no tool named fs__wrte.' }))).toBe('model-arg-mistake');
    expect(callTrouble(run({ run: '(no run)', status: 'tool-error', outcome: 'Error parsing tool arguments: Unexpected end' }))).toBe('model-arg-mistake');
    expect(callTrouble(run({ run: '(no run)', status: 'tool-error', outcome: 'Stopped by the hub: these arguments ran into 2000 blank characters' }))).toBe('model-arg-mistake');
    expect(callTrouble(run({ run: '(no run)', status: 'tool-error', outcome: 'Error executing tool: boom' }))).toBe('tool-failure');
    expect(callTrouble(run({ run: '(no run)', status: 'tool-error', outcome: 'Refused: not this folder' }))).toBe('refusal');
    // an older record's stray call
    expect(callTrouble(run({ run: '(no run)', status: 'no-run', outcome: 'Tool not found: x' }))).toBe('model-arg-mistake');
    expect(callTrouble(run({}))).toBeUndefined();
    expect(brokenRun(run({ status: 'invalid-input', outcome: 'invalid input: {"source":"schema"}' }))).toBe(false);
    expect(brokenRun(run({ status: 'failed', outcome: 'failed: x' }))).toBe(true);
  });

  it('counts a mistake recovered when a later call of the same fn went through', () => {
    const bad = run({ status: 'invalid-input', outcome: 'invalid input: {"source":"schema"}' });
    expect(argMistakes([bad, run({})])).toEqual({ total: 1, recovered: 1 });
    expect(argMistakes([bad, run({ fn: 'fs/write' })])).toEqual({ total: 1, recovered: 0 });
    expect(argMistakes([run({ fn: 'fs__wrte', run: '(no run)', status: 'tool-error', outcome: 'There is no tool named fs__wrte.' }), run({ fn: 'fs/write' })])).toEqual({ total: 1, recovered: 1 });
    expect(argMistakes([run({ repairs: 2 })])).toEqual({ total: 1, recovered: 1 });
    expect(argMistakesLine({ total: 2, recovered: 2 })).toMatch(/^2 model arg mistakes, both recovered/);
    expect(argMistakesLine({ total: 3, recovered: 1 })).toMatch(/1 recovered, 2 not/);
  });

  it('no-run-errors counts only real failures and refusals, and names the recovered mistakes apart', () => {
    const record: Pick<CaseRecord, 'entries'> = {
      entries: [{ type: 'tools', turn: 't', runs: [run({ status: 'invalid-input', outcome: 'invalid input: {"source":"validation"}' }), run({})] }],
    };
    const check = hardChecks(record).find((c) => c.name === 'no-run-errors');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain('1 model arg mistake, recovered');
  });

  it('marks a model arg mistake on its transcript line', () => {
    expect(runLine(run({ status: 'invalid-input', outcome: 'invalid input: {"source":"schema"}' }), 'short')).toContain('model arg mistake: sent back for the model to fix; not a failure');
    expect(runLine(run({ status: 'failed', outcome: 'failed: x' }), 'short')).not.toContain('model arg mistake');
  });
});
