/**
 * The `compute` authoring step (docs/plans/schedule-system.md, "How the model writes the args"): args that change with
 * each run come in plain words ("from: the run's day minus 7 days; to: the run's day"), and this small authoring agent,
 * on `ctx.ai()` and the shared program tools (`@harness/sdk/program`, the code system's), turns them into the gin
 * program a schedule keeps as its `args`. The chat model never writes gin.
 *
 * - **inspect:** `examples` shows how an args program is written, with worked examples.
 * - **set → check → fix:** each draft is checked against the target's args with `fire` and `previous` in scope
 *   (`checkArgs`, the same check the kind runs when the schedule is saved), then run for the next three runs, so the
 *   agent sees each run's args. Fixed values must come out as they were given.
 * - **return:** the clean program is kept for the caller (`schedule/add` or `change`), which saves the schedule; the
 *   step itself saves nothing.
 *
 * There is no `find` stage: the step is handed the fn it writes args for.
 */
import type { ExprDef } from '@aeye/gin';
import { a, type Bound } from '@aeye/schema';
import { HarnessGrammar, Json, type QualifiedName } from '@harness/core';
import { ProgramAuthoring, previewText, programTools, type ProgramHost, type ProgramLookups, type ProgramSession } from '@harness/sdk/program';
import { authoringAgent, type AuthoredFn, type ShowArgs } from '@harness/sdk/server';
import { schedule } from '../shared/index.ts';
import type { Fire, PreviousFiring } from '../shared/types.ts';
import { clockWords, dayWords } from '../shared/when.ts';
import { ArgsFailed, checkArgs, evaluateArgs, fireType, previousType, type TargetSignature } from './args.ts';

/** A draft as the agent writes it: the program alone (the signature is the target's). */
export interface ArgsDraft {
  readonly program: ExprDef;
}

/** One run the draft is tried on, and the args it gave. */
export interface ArgsPreview {
  /** The run in words: "Mon, Nov 30 9:00 am". */
  readonly run: string;
  readonly args: Json;
}

/** What one compute step works on: the fn the args are for, the words, the fixed values and the runs to try. */
export interface ComputeInput {
  readonly host: ProgramHost;
  readonly lookups: ProgramLookups;
  readonly target: QualifiedName;
  readonly signature: TargetSignature;
  /** How the args that change are worked out, in plain words. */
  readonly asked: string;
  /** Values given as they are: the program must give each of them unchanged. */
  readonly fixed?: { readonly [key: string]: Json } | undefined;
  /** The next runs, as `fire` reads them: the draft is run for each. */
  readonly firings: readonly Fire[];
  /** The last run that ran, as `previous` reads it, when there was one. */
  readonly previous?: PreviousFiring | undefined;
}

/** One compute step's state: the program world (the target's types and `fire`), and what it was asked. */
export class ArgsAuthoring extends ProgramAuthoring {
  readonly input: ComputeInput;

  constructor(input: ComputeInput) {
    super({ host: input.host, kind: schedule.kinds.schedule.name, guide: ARGS_GUIDE, signature: { args: input.signature.args, returns: input.signature.returns } });
    this.input = input;
  }

  /** The target's types and `fire`'s bound in the session, so drafts parse against them. */
  async prepare(): Promise<void> {
    await this.preload({ types: [this.input.signature.args, this.input.signature.returns, fireType(), previousType(this.input.signature.returns)], programs: [] });
  }
}

type Session = ProgramSession<ArgsAuthoring, ArgsDraft>;

const num = (value: number) => ({ kind: 'new', type: { name: 'num' }, value });
const fire = (...path: Array<{ prop: string } | { args: Record<string, unknown> }>) => ({ kind: 'get', path: [{ prop: 'fire' }, ...path] });
const RANGE = { name: 'obj', props: { from: { type: { name: 'text' } }, to: { type: { name: 'text' } }, limit: { type: { name: 'num' } } } };
const TITLED = { name: 'obj', props: { title: { type: { name: 'text' } } } };

/** The worked examples `examples` shows, each a whole args program for its args type. */
export const ARGS_EXAMPLES = {
  /** `from`: the run's day minus 7 days; `to`: the run's day; `limit` fixed at 50. */
  lastWeek: {
    args: RANGE,
    program: { kind: 'new', type: RANGE, value: { from: fire({ prop: 'date' }, { prop: 'addDays' }, { args: { days: num(-7) } }, { prop: 'toText' }, { args: {} }), to: fire({ prop: 'day' }), limit: num(50) } },
  },
  /** `title`: "Notes for " and the run's day. */
  titled: {
    args: TITLED,
    program: { kind: 'new', type: TITLED, value: { title: { kind: 'template', template: 'Notes for {day}', params: fire() } } },
  },
};

/** How args programs are written, with the worked examples (`examples`). */
export const ARGS_GUIDE = [
  'An args program is one gin expression (JSON) whose value is the whole args object of the fn. It calls no fns. It reads two names:',
  '- `fire`, this run: `at` (the instant it was planned for, ms), `local` (that instant in the schedule\'s zone with its offset, text), `day` (its local day, YYYY-MM-DD text), `date` (the same day as a date: `addDays`, `addMonths`, `addYears`, `dayOfWeek`, `day`, `month`, `year`; `toText` gives YYYY-MM-DD), `time` (HH:mm, absent for a whole-day run), `zone`, `count` (runs before this one), `late` (ms it started late) and `manual` (true for a run started by hand).',
  '- `previous`, the last run that ran or failed, absent before the first: `at`, `status` ("ran" or "failed") and `result` (the fn\'s result).',
  'Read a field as {"kind":"get","path":[{"prop":"fire"},{"prop":"day"}]}. A method call is two steps: {"prop":"addDays"} then {"args":{"days":<expr>}}. A literal number is {"kind":"new","type":{"name":"num"},"value":-7}.',
  'Build the args with {"kind":"new","type":<the whole args obj type>,"value":{"<arg>":<expr>, …}}: each arg is an expression, a fixed value a literal such as {"kind":"new","type":{"name":"num"},"value":50}; the request gives each fixed value as its literal, to use exactly as given. `template` fills {name} placeholders from its params obj; `if` chooses.',
  '',
  `Example 1, args obj{from: text, to: text, limit: num}, "from: the run's day minus 7 days; to: the run's day", limit fixed at 50: ${JSON.stringify(ARGS_EXAMPLES.lastWeek.program)}`,
  `Example 2, args obj{title: text}, "title: Notes for and the run's day": ${JSON.stringify(ARGS_EXAMPLES.titled.program)}`,
].join('\n');

/** The agent's job, step by step; every example call is written as the model writes that tool's args (`ShowArgs`). */
const INSTRUCTIONS = (show: ShowArgs): string => [
  'You write one args program for a scheduled run of a fn: the args it is called with each time it runs, worked out from that run. The request names the fn and its args, says in plain words how the args that change from run to run are worked out, and gives the fixed values. Programs are written in gin, a JSON expression language: the examples tool shows how. You work only through your tools, in order, and finish by calling return.',
  '',
  `1. examples ${show('examples', {})} once, to see how args programs are written.`,
  '2. set {"draft":{"program":<one gin expression>}}: the whole args object. It is checked against the fn\'s args at once and run for the next three runs; the answer lists the problems, or each run\'s args. Fix only what a problem names and call set again with the whole program. Never send the same draft twice.',
  `3. When each run's args are what the request says, call return ${show('return', {})}. Answer in one line.`,
  'If the words ask for something the program can\'t know (data from another fn, anything but the run and the last run), stop and answer in one line saying what can\'t be worked out and why.',
].join('\n');

/** A run in words: "Mon, Nov 30 9:00 am". */
export function runWords(fire: Pick<Fire, 'day' | 'time'>): string {
  return fire.time === undefined ? dayWords(fire.day) : `${dayWords(fire.day)} ${clockWords(fire.time)}`;
}

/** What the agent is asked: the fn and its args, the words, the fixed values and the runs it is tried on. */
export function computeRequest(state: ArgsAuthoring): string {
  const { input } = state;
  const fixed = input.fixed === undefined || Object.keys(input.fixed).length === 0 ? 'none' : JSON.stringify(input.fixed);
  const props = input.signature.args.name === 'obj' && 'props' in input.signature.args ? input.signature.args.props : {};
  const literals = Object.entries(input.fixed ?? {}).map(([key, value]) => {
    const type = props[key]?.type;
    return `- ${key}: ${JSON.stringify(type === undefined ? value : { kind: 'new', type, value })}`;
  });
  return [
    `The fn: ${state.program.signature(input.target, input.signature.args, input.signature.returns)}`,
    `Its args type, for the program's \`new\`: ${JSON.stringify(input.signature.args)}`,
    `Worked out for each run: ${input.asked}`,
    `Fixed values, kept as given: ${fixed}`,
    ...(literals.length === 0 ? [] : ['Each as its literal:', ...literals]),
    `The next runs: ${input.firings.map(runWords).join('; ') || 'none'}.`,
  ].join('\n');
}

/** The problems with a draft, and each run's args when it is clean. */
export async function checkCompute(program: ExprDef, state: ArgsAuthoring): Promise<{ problems: string[]; previews: ArgsPreview[]; code?: string | undefined }> {
  const { input } = state;
  const checked = await checkArgs(program, input.signature, input.target, input.lookups);
  if (checked.problems.length > 0) { return { problems: checked.problems, previews: [], code: checked.code }; }
  const problems: string[] = [];
  const previews: ArgsPreview[] = [];
  for (const fire of input.firings) {
    try {
      const args = await evaluateArgs(program, input.signature, input.target, input.lookups, { fire, previous: input.previous });
      previews.push({ run: runWords(fire), args });
      for (const [key, value] of Object.entries(input.fixed ?? {})) {
        const got = typeof args === 'object' && args !== null && !Array.isArray(args) ? args[key] : undefined;
        if (JSON.stringify(got) !== JSON.stringify(value)) { problems.push(`value.${key}: it was given as ${JSON.stringify(value)}; give it exactly that (the run on ${runWords(fire)} gave ${got === undefined ? 'nothing' : JSON.stringify(got)}).`); }
      }
    } catch (error) {
      if (!(error instanceof ArgsFailed)) { throw error; }
      problems.push(`For the run on ${runWords(fire)}: ${error.message}`);
    }
  }
  return { problems: [...new Set(problems)], previews, code: checked.code };
}

/** The draft: the args program, in gin's grammar over the session's types. */
const ArgsDraftSchema = HarnessGrammar.result<ArgsDraft>(a.object({
  program: a.ref('Expr').describe('The args program: one gin expression whose value is the fn\'s whole args object.'),
}));

/** The draft's schema for this session: the grammar bound over the types it has loaded. */
function draftSchema(session: Session): Bound<ArgsDraft> {
  return ArgsDraftSchema.bind(...session.state.program.grammar());
}

/** The program kept, as the step answers: what it is for and the first run's args. The schedule is saved by the caller. */
function kept(state: ArgsAuthoring, code: string | undefined, previews: readonly ArgsPreview[]): AuthoredFn {
  const first = previews[0];
  return {
    fn: state.input.target, version: 1, about: state.input.asked, reused: false,
    signature: code === undefined ? `args of ${state.input.target}` : code,
    call: `${state.input.target}(${first === undefined ? '{}' : previewText(first.args)})`,
    ...(first === undefined ? {} : { preview: Json.parse(previews.map((preview) => ({ run: preview.run, args: preview.args }))) }),
  };
}

/** The compute authoring agent. Run it with the run's `ctx.ai()`, `computeRequest(state)` and a prepared `ArgsAuthoring`. */
export const argsAuthoring = authoringAgent<ArgsAuthoring, ArgsDraft>({
  name: 'schedule_args_author',
  description: 'Write the args program of a scheduled run of a fn from plain words: how its args are worked out for each run.',
  instructions: INSTRUCTIONS,
  // handed the fn it writes args for: no search, and the signature is the fn's own
  stages: { find: false },
  tools: programTools<ArgsAuthoring, ArgsDraft>().filter((tool) => tool.name === 'examples'),
  toolNames: { draft: 'set', save: 'return' },
  draft: { description: 'the args program.', schema: draftSchema },
  async check(draft, session) {
    const { problems, previews, code } = await checkCompute(draft.program, session.state);
    const note = [
      code === undefined ? '' : `As code: ${code}`,
      previews.length === 0 ? '' : `Each run's args:\n${previews.map((preview) => `- ${preview.run}: ${previewText(preview.args)}`).join('\n')}`,
    ].filter((line) => line !== '').join('\n');
    return { problems, ...(previews.length === 0 ? {} : { preview: Json.parse(previews) }), ...(note === '' ? {} : { note }) };
  },
  async save(draft, session) {
    const { previews, code } = await checkCompute(draft.program, session.state);
    return kept(session.state, code, previews);
  },
});
