import { describe, expect, it } from 'vitest';
import { argMistakes, argMistakesLine, authoringChecks, brokenRun, callTrouble, hardChecks } from './checks.ts';
import type { CaseRecord, SeenSystem, SystemsSeen, ToolRun } from './records.ts';
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

describe('the checks of a case that writes a system', () => {
  const system = (over: Partial<SeenSystem>): SeenSystem => ({
    name: 'readings', status: 'connected', stage: 'live', versions: ['0.1.0'], instances: 1, keys: 1, hosted: true, hubInstalled: false, fns: ['readings/add', 'readings/summary'],
    pages: [], pageServed: false, recordsByVersion: { '0.1.0': 3 }, filesByVersion: {}, events: ['went live'], ...over,
  });
  const seen = (expect: SystemsSeen['expect'], systems: SeenSystem[]): SystemsSeen => ({ expect, systems, errors: [] });
  const installed = run({ fn: 'fs/install_system', status: 'done', outcome: '{"system":"readings","status":"connected"}' });
  const ok = (checks: ReturnType<typeof authoringChecks>): Record<string, boolean> => Object.fromEntries(checks.map((c) => [c.name, c.ok]));

  it('passes a system that is installed, live, with fns of which one ran', () => {
    expect(ok(authoringChecks(seen('new', [system({})]), [installed, run({ fn: 'readings/add' })]))).toEqual({ 'system-installed': true, 'system-fns': true, 'system-fn-ran': true });
    // installed by the hub's own fn (an admin fn) counts too
    const byHub = run({ fn: 'hub/install_system', status: 'done' });
    expect(ok(authoringChecks(seen('new', [system({ hosted: false, hubInstalled: true })]), [byHub, run({ fn: 'readings/add' })]))['system-installed']).toBe(true);
    // installed but never gone live, nothing of it ran
    expect(ok(authoringChecks(seen('new', [system({ stage: 'installed' })]), [installed]))).toEqual({ 'system-installed': false, 'system-fns': true, 'system-fn-ran': false });
    // no system at all: every check fails and says what the installs did
    const none = authoringChecks(seen('new', []), [run({ fn: 'fs/install_system', status: 'invalid-input', outcome: 'invalid input: shared/index.ts:3:1 error' })]);
    expect(none.every((c) => !c.ok)).toBe(true);
    expect(none[0]?.detail).toContain('invalid-input');
  });

  it('wants a page the hub lists and a client build that answers', () => {
    const page = authoringChecks(seen('page', [system({ pages: ['birds'], pageServed: true })]), [installed, run({ fn: 'readings/add' })]);
    expect(ok(page)['system-page']).toBe(true);
    expect(ok(authoringChecks(seen('page', [system({})]), [installed]))['system-page']).toBe(false);
  });

  it('wants an update in place: one system, one key, a new version, its data kept, a fn run after', () => {
    const updated = system({ versions: ['0.1.0', '0.2.0'], recordsByVersion: { '0.1.0': 2, '0.2.0': 3 } });
    const runs = [installed, run({ fn: 'readings/add' }), installed, run({ fn: 'readings/add' })];
    expect(ok(authoringChecks(seen('update', [updated]), runs))).toMatchObject({ 'one-system': true, 'updated-in-place': true, 'data-kept': true, 'fn-ran-after-update': true });
    // a second system, a new key, the data gone, nothing run after
    const lost = system({ versions: ['0.1.0', '0.2.0'], keys: 2, recordsByVersion: { '0.1.0': 2, '0.2.0': 0 } });
    expect(ok(authoringChecks(seen('update', [lost, system({ name: 'other' })]), [installed, run({ fn: 'readings/add' }), installed]))).toMatchObject({ 'one-system': false, 'updated-in-place': false, 'data-kept': false, 'fn-ran-after-update': false });
  });

  it('wants no new system when the ask needs none', () => {
    expect(ok(authoringChecks(seen('none', []), [run({ fn: 'database/main.create_table' })]))).toEqual({ 'no-new-system': true });
    expect(ok(authoringChecks(seen('none', [system({})]), [installed]))).toEqual({ 'no-new-system': false });
  });
});
