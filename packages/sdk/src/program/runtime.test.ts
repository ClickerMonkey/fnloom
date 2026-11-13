/**
 * The gin program runtime: a program reads `args`, calls a loaded fn as `fns.<system>.<name>(…)` (its answer parsed
 * through the callee's return type), and is refused when it breaks a rule (an unloaded fn, a fn not called in place,
 * a while-loop, `recurse`, an unknown type, a result of the wrong type); a run stops at the call cap, the deadline and a
 * cancel, even mid-loop, without holding the thread; and a stored
 * program's world is rebuilt from its lookups.
 */
import type { ExprDef, TypeDef } from '@aeye/gin';
import { QualifiedName, type Json } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { programEnv } from './env.ts';
import { checkProgram, fnCandidates, ProgramError, ProgramScope, runProgram, storedProgramScope, type ProgramFn } from './runtime.ts';

const num = { name: 'num' } as const;
const text = { name: 'text' } as const;
const FORECAST: ProgramFn = {
  name: QualifiedName.parse('weather/forecast'), description: 'The forecast for a city.', mode: 'read',
  args: { name: 'obj', props: { city: { type: text } } }, returns: { name: 'weather/Forecast' },
};
const FORECAST_TYPE = { name: 'weather/Forecast', def: { name: 'obj', props: { summary: { type: text }, high: { type: num } } } };
const arg = (name: string): ExprDef => ({ kind: 'get', path: [{ prop: 'args' }, { prop: name }] });
const callForecast = (path: unknown[]): ExprDef => ({ kind: 'get', path: [{ prop: 'fns' }, { prop: 'weather' }, { prop: 'forecast' }, { args: { city: arg('city') } }, ...path] });
const CITY = { name: 'obj', props: { city: { type: text } } };

function world(): ProgramScope {
  const program = new ProgramScope();
  program.addTypes([FORECAST_TYPE]);
  program.addFn(FORECAST);
  return program;
}

afterEach(() => { programEnv.set({ HARNESS_PROGRAM_MAX_CALLS: '50', HARNESS_PROGRAM_TIMEOUT: '30000' }); });

/** `loop args.count { }`: as many rounds as the caller asks for. */
const COUNT_LOOP: ExprDef = { kind: 'loop', over: arg('count'), body: { kind: 'block', lines: [] } };
const COUNT = { name: 'obj', props: { count: { type: num } } };

describe('the program runtime', () => {
  it('stops a loop over a huge count at the deadline, and other work goes on meanwhile', async () => {
    programEnv.set({ HARNESS_PROGRAM_TIMEOUT: '100' });
    const program = world();
    const check = checkProgram(program, COUNT_LOOP, { args: COUNT, returns: { name: 'void' } });
    expect(check.problems).toEqual([]);
    if (check.expr === undefined) throw new Error('no expr');
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    try {
      const run = runProgram({ program, expr: check.expr, args: COUNT, returns: { name: 'void' }, calls: [], call: () => Promise.resolve(null) }, { count: 1e12 });
      await expect(run).rejects.toMatchObject({ reason: 'limit', message: 'The program ran past 100 ms.' });
    } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(2);
  });

  it('stops a running loop when the caller cancels', async () => {
    const program = world();
    const check = checkProgram(program, COUNT_LOOP, { args: COUNT, returns: { name: 'void' } });
    if (check.expr === undefined) throw new Error('no expr');
    const controller = new AbortController();
    setTimeout(() => { controller.abort(); }, 30);
    const run = runProgram({ program, expr: check.expr, args: COUNT, returns: { name: 'void' }, calls: [], call: () => Promise.resolve(null), signal: controller.signal }, { count: 1e12 });
    await expect(run).rejects.toMatchObject({ reason: 'limit', message: 'The run was stopped.' });
  });

  it('checks and runs a program that calls a fn, through its declared return type', async () => {
    const program = world();
    const def = callForecast([{ prop: 'summary' }]);
    const check = checkProgram(program, def, { args: CITY, returns: text });
    expect(check.problems).toEqual([]);
    expect(check.calls).toEqual(['weather/forecast']);
    expect(fnCandidates(def)).toEqual(['weather/forecast']);
    const calls: Array<{ fn: string; args: Json }> = [];
    if (check.expr === undefined) throw new Error('no expr');
    const out = await runProgram({
      program, expr: check.expr, args: CITY, returns: text, calls: check.calls,
      call: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ summary: 'Sunny', high: 21 }); },
    }, { city: 'Paris' });
    expect(out).toBe('Sunny');
    expect(calls).toEqual([{ fn: 'weather/forecast', args: { city: 'Paris' } }]);
  });

  it('refuses what breaks the rules, each in words the agent can act on', () => {
    const program = world();
    const problems = (def: ExprDef, returns: TypeDef = text) => checkProgram(program, def, { args: CITY, returns }).problems.join('\n');
    expect(problems({ kind: 'get', path: [{ prop: 'fns' }, { prop: 'weather' }, { prop: 'other' }, { args: {} }] })).toContain('is not a loaded fn');
    expect(problems({ kind: 'define', vars: [{ name: 'f', value: { kind: 'get', path: [{ prop: 'fns' }, { prop: 'weather' }, { prop: 'forecast' }] } }], body: arg('city') })).toContain('must be called in place');
    expect(problems({ kind: 'loop', over: { kind: 'new', type: { name: 'bool' }, value: true }, body: { kind: 'set', path: [{ prop: 'args' }, { prop: 'city' }], value: arg('city') } })).toContain('while-loop');
    expect(problems({ kind: 'get', path: [{ prop: 'recurse' }, { args: {} }] })).toContain('recurse');
    expect(problems({ kind: 'new', type: { name: 'shop/Nope' }, value: {} })).toContain('shop/Nope is not loaded');
    expect(problems(callForecast([{ prop: 'high' }]))).toContain('It produces `num` but `text` is expected');
  });

  it('stops a run past the call cap', async () => {
    programEnv.set({ HARNESS_PROGRAM_MAX_CALLS: '1' });
    const program = world();
    const twice: ExprDef = { kind: 'template', template: '{a} {b}', params: { kind: 'new', type: { name: 'obj', props: { a: { type: text }, b: { type: text } } }, value: { a: callForecast([{ prop: 'summary' }]), b: callForecast([{ prop: 'summary' }]) } } };
    const check = checkProgram(program, twice, { args: CITY, returns: text });
    expect(check.problems).toEqual([]);
    if (check.expr === undefined) throw new Error('no expr');
    const run = runProgram({ program, expr: check.expr, args: CITY, returns: text, calls: check.calls, call: () => Promise.resolve({ summary: 'Rain', high: 9 }) }, { city: 'Oslo' });
    await expect(run).rejects.toThrow(ProgramError);
    await expect(run).rejects.toThrow('more than 1 fn calls');
  });

  it('rebuilds a stored program\'s world from its lookups', async () => {
    const def = callForecast([{ prop: 'summary' }]);
    const program = await storedProgramScope({ types: [CITY, text], programs: [def] }, {
      fn: (name) => Promise.resolve(name === FORECAST.name ? FORECAST : undefined),
      types: (names) => Promise.resolve({ types: names.includes(QualifiedName.parse('weather/Forecast')) ? [FORECAST_TYPE] : [] }),
    });
    expect(program.fns.map((fn) => fn.name)).toEqual(['weather/forecast']);
    expect(checkProgram(program, def, { args: CITY, returns: text }).problems).toEqual([]);
  });
});
