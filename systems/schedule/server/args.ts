/**
 * A schedule's args program (docs/plans/schedule-system.md, "What a schedule is"): one gin program whose result is the
 * target fn's args, worked out at each firing. It reads `fire` (this firing: its instant, local day and time, zone,
 * count, how late it started, whether it is a "run now") and `previous` (the last firing that ran or failed, with its
 * result typed as the target's result), and calls no fns: a firing that needs another fn's data is a schedule of a code
 * fn that calls both. Fixed args are a constant program, so there is one field, checked the same way.
 *
 * It runs on the shared program runtime (`@harness/sdk/program`), the one the code and api systems use: checked against
 * the target's args type when the schedule is saved (and again when it runs, in case the target changed), and run with
 * the runtime's limits.
 */
import type { ExprDef, TypeDef } from '@aeye/gin';
import { checkGinValue, Json, type InputProblem, type QualifiedName } from '@harness/core';
import { ginAs } from '@harness/sdk';
import { checkProgram, fnCandidates, ProgramError, runProgram, storedProgramScope, type ProgramLookups } from '@harness/sdk/program';
import { Fire, PreviousFiring } from '../shared/types.ts';

/** The name the program reads this firing by. */
export const FIRE_SCOPE = 'fire';
/** The name the program reads the last firing by. */
export const PREVIOUS_SCOPE = 'previous';

/** A schedule fn's own args, as its kind describes them: `at`, the instant the timer planned it for; absent for "run now". */
export const RUN_ARGS: TypeDef = {
  name: 'obj',
  props: { at: { type: { name: 'optional', generic: { T: { name: 'timestamp' } } }, docs: 'The instant the run was planned for (the timer passes it); leave it out to run it now.' } },
};

/** The program's `args`: none (it reads `fire` and `previous`). */
const NO_ARGS: TypeDef = { name: 'obj', props: {} };

/**
 * `fire`'s type in the program: the `Fire` shape, plus `date`, its local `day` as a gin `date`, so a program can do
 * day arithmetic (`fire.date.addDays({ days: -7 }).toText()`); gin has no way to read a date out of text.
 */
export function fireType(): TypeDef {
  const base = ginAs(Fire).toJSON();
  const props = 'props' in base ? base.props : {};
  return { ...base, props: { ...props, date: { type: { name: 'date' }, docs: 'The firing\'s local day as a date, for day arithmetic: `addDays`, `addMonths`, `dayOfWeek`, then `toText` for YYYY-MM-DD.' } } };
}

/** The value the program reads as `fire`: the firing, with its day as a date too. */
export function fireValue(fire: Fire): Json {
  return Json.parse({ ...fire, date: fire.day });
}

/** `previous`'s type: optional (absent before the first firing), its `result` typed as the target's result. */
export function previousType(targetReturns: TypeDef): TypeDef {
  const base = ginAs(PreviousFiring).toJSON();
  const props = 'props' in base ? base.props : {};
  return { name: 'optional', generic: { T: { ...base, props: { ...props, result: { type: { name: 'optional', generic: { T: targetReturns } } } } } } };
}

/** The target fn's signature, as the kind's lookups give it. */
export interface TargetSignature {
  readonly args: TypeDef;
  readonly returns: TypeDef;
}

/** What checking an args program found: its problems, and the program as gin code when it parsed. */
export interface ArgsCheck {
  readonly problems: string[];
  readonly code?: string | undefined;
}

/** Lookups that offer named types only: the args program calls no fns. */
function typesOnly(lookups: ProgramLookups): ProgramLookups {
  return { types: (names) => lookups.types(names), fn: () => Promise.resolve(undefined) };
}

/** The program's world and its check against the target's args, with `fire` and `previous` in scope. */
async function checked(def: ExprDef, target: TargetSignature, lookups: ProgramLookups) {
  const program = await storedProgramScope({ types: [target.args, target.returns, fireType()], programs: [def] }, typesOnly(lookups));
  const owned = new Map([[FIRE_SCOPE, program.parse(fireType())], [PREVIOUS_SCOPE, program.parse(previousType(target.returns))]]);
  const check = checkProgram(program, def, { args: NO_ARGS, returns: target.args, owned, label: 'args' });
  return { program, check, owned };
}

/** The fns a program calls, in words, or nothing. */
function callProblems(def: ExprDef, target: QualifiedName): string[] {
  const calls = fnCandidates(def);
  if (calls.length === 0) { return []; }
  return [`args: it calls ${calls.join(', ')}; the args program reads only \`fire\` and \`previous\` and calls no fns. A run that needs another fn's data first is a schedule of a code fn that calls both (and then ${target}).`];
}

/**
 * Fixed args against the target's args type, the way the hub checks a call's args: each problem at its full path under
 * `args` with what was expected there (`checkGinValue`); none when they fit.
 */
export async function fixedProblems(fixed: Json, target: TargetSignature, lookups: ProgramLookups): Promise<InputProblem[]> {
  const program = await storedProgramScope({ types: [target.args], programs: [] }, typesOnly(lookups));
  const checked = checkGinValue(program.parse(target.args), fixed, { scope: program.scope, unknownKeys: 'refuse' });
  if (checked.ok) { return []; }
  return checked.problems.map((problem) => ({ path: problem.path === '' ? 'args' : `args.${problem.path}`, message: problem.message }));
}

/** Problems with an args program: it calls no fns and gives the target's args. Never throws. */
export async function checkArgs(def: ExprDef, target: TargetSignature, targetName: QualifiedName, lookups: ProgramLookups): Promise<ArgsCheck> {
  const calls = callProblems(def, targetName);
  if (calls.length > 0) { return { problems: calls }; }
  const { check } = await checked(def, target, lookups);
  return { problems: check.problems, code: check.code };
}

/** What one firing's program reads. */
export interface ArgsScope {
  readonly fire: Fire;
  readonly previous?: PreviousFiring | undefined;
}

/** The args program failed: it no longer checks, or it stopped (a limit) or threw. */
export class ArgsFailed extends Error {
  override readonly name = 'ArgsFailed';
}

/** Work out a firing's args: the program checked again against the target's args, then run with `fire` and `previous`. */
export async function evaluateArgs(def: ExprDef, target: TargetSignature, targetName: QualifiedName, lookups: ProgramLookups, scope: ArgsScope, signal?: AbortSignal): Promise<Json> {
  const calls = callProblems(def, targetName);
  if (calls.length > 0) { throw new ArgsFailed(calls.join(' ')); }
  const { program, check, owned } = await checked(def, target, lookups);
  if (check.expr === undefined || check.problems.length > 0) {
    throw new ArgsFailed(`Its args no longer fit ${targetName}: ${check.problems.join(' ')}`);
  }
  const fire = owned.get(FIRE_SCOPE);
  const previous = owned.get(PREVIOUS_SCOPE);
  if (fire === undefined || previous === undefined) { throw new ArgsFailed('The args program has no scope.'); }
  try {
    return await runProgram({
      program, expr: check.expr, args: NO_ARGS, returns: target.args, calls: [], signal,
      owned: { [FIRE_SCOPE]: fire.parse(fireValue(scope.fire)), [PREVIOUS_SCOPE]: previous.parse(scope.previous) },
      call: () => Promise.reject(new ArgsFailed('The args program calls no fns.')),
    }, {});
  } catch (error) {
    if (error instanceof ProgramError) { throw new ArgsFailed(`Working out its args failed: ${error.message}`); }
    throw error;
  }
}
