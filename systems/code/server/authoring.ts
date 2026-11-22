/**
 * The code authoring agent behind `make_code`, on the SDK's `authoringAgent` and the shared program tools (product's
 * code agent, ported): the chat model passes what the fn should do; this agent works through the forced workflow on
 * `ctx.ai()` and the chat gets back the saved fn, never the working context.
 *
 * - **find:** `search` lists fns the program may call and code fns that may already do it; `reuse` answers with one.
 * - **inspect:** `load` (fns and named types, a little at a time), `examples` (how programs are written) and
 *   `signature` (the new fn's args and result).
 * - **set → check → fix:** the draft (name, description, program, sample args) is checked with `checkProgram`; a
 *   program that calls no fn is run with the sample args, so the agent sees what a caller gets. `test` tries other args.
 * - **return:** the clean draft is kept with `hub/save_fn` as a `code/program` fn (a new version when changing one).
 */
import type { ExprDef } from '@aeye/gin';
import { CODE_KIND, CodeFnSpec, GinExprDef, Json, QualifiedName, splitName } from '@harness/core';
import { encodeValue, type Infer, type StoredFn } from '@harness/sdk';
import { checkProgram, previewText, ProgramAuthoring, ProgramError, programTools, runProgram, testTool, type ProgramCheck, type ProgramHost, type ProgramSession } from '@harness/sdk/program';
import { authoringAgent, type AuthoredFn } from '@harness/sdk/server';
import { z } from 'zod';
import { CodePayload } from '../shared/index.ts';

/** A draft as the agent writes it. */
export interface CodeDraft {
  readonly name: string;
  readonly description: string;
  readonly program: ExprDef;
  /** Args to check it with, by name. */
  readonly sample: Record<string, Json>;
}

/** A code fn being changed: its name and payload. */
export interface EditedCode {
  readonly fn: QualifiedName;
  readonly spec: CodeFnSpec;
}

/** What a code authoring run needs from its run besides the program host: reading and saving fns in the hub. */
export interface CodeAuthoringDeps {
  getFn(name: QualifiedName): Promise<Infer<typeof StoredFn>>;
  /** `hub/save_fn` with these args; the saved fn and its version. */
  saveFn(args: { name: string; description: string; payload: Json; examples: Array<{ args: Json; result?: Json }>; replace: boolean }): Promise<{ fn: string; version: number }>;
}

/** One code authoring run's state: the program world, the hub, and the fn being changed, if any. */
export class CodeAuthoring extends ProgramAuthoring {
  readonly deps: CodeAuthoringDeps;
  readonly editing: EditedCode | undefined;

  constructor(input: { host: ProgramHost; deps: CodeAuthoringDeps; editing?: EditedCode | undefined }) {
    super({
      host: input.host, kind: QualifiedName.parse(CODE_KIND), guide: CODE_GUIDE,
      ...(input.editing === undefined ? {} : { signature: { args: input.editing.spec.args, returns: input.editing.spec.returns } }),
    });
    this.deps = input.deps;
    this.editing = input.editing;
  }
}

type Session = ProgramSession<CodeAuthoring, CodeDraft>;

const num = { name: 'num' } as const;
const text = { name: 'text' } as const;
const arg = (name: string) => ({ kind: 'get', path: [{ prop: 'args' }, { prop: name }] });
const literal = (value: number) => ({ kind: 'new', type: num, value });
/** `<left>.<method>({ other: <right> })`, a num method call as two path steps. */
const method = (left: { kind: string; path: unknown[] }, name: string, other: unknown) => ({ kind: 'get', path: [...left.path, { prop: name }, { args: { other } }] });
const RESULT = { name: 'obj', props: { total: { type: num }, note: { type: text } } };

/** The worked examples `examples` shows, each a whole program for its signature. */
export const CODE_EXAMPLES = {
  /** `(amount: num, rate: num) → obj{total, note}`: one `new` whose payload slots are expressions. */
  priceWithTax: {
    signature: { args: { name: 'obj', props: { amount: { type: num }, rate: { type: num } } }, returns: RESULT },
    program: {
      kind: 'new', type: RESULT,
      value: {
        total: method(arg('amount'), 'mul', method(method(arg('rate'), 'div', literal(100)), 'add', literal(1))),
        note: { kind: 'template', template: '{amount} at {rate}%', params: { kind: 'get', path: [{ prop: 'args' }] } },
      },
    },
  },
  /** The same with a local used twice: `define` binds it, and its body is the result. */
  withLocal: {
    signature: { args: { name: 'obj', props: { amount: { type: num }, rate: { type: num } } }, returns: RESULT },
    program: {
      kind: 'define',
      vars: [{ name: 'total', value: method(arg('amount'), 'mul', method(method(arg('rate'), 'div', literal(100)), 'add', literal(1))) }],
      body: { kind: 'new', type: RESULT, value: { total: { kind: 'get', path: [{ prop: 'total' }] }, note: { kind: 'get', path: [{ prop: 'total' }, { prop: 'toText' }, { args: {} }] } } },
    },
  },
  /** `(city: text) → text` calling the loaded `weather/forecast(city: text) → obj{summary: text}`. */
  callsFn: {
    signature: { args: { name: 'obj', props: { city: { type: text } } }, returns: text },
    program: {
      kind: 'template', template: '{city}: {summary}',
      params: {
        kind: 'new', type: { name: 'obj', props: { city: { type: text }, summary: { type: text } } },
        value: { city: arg('city'), summary: { kind: 'get', path: [{ prop: 'fns' }, { prop: 'weather' }, { prop: 'forecast' }, { args: { city: arg('city') } }, { prop: 'summary' }] } },
      },
    },
  },
};

/** How programs are written, with the worked examples (`examples`). */
export const CODE_GUIDE = [
  'A program is one gin expression (JSON). Its value is the fn\'s result. Read args as {"kind":"get","path":[{"prop":"args"},{"prop":"<name>"}]}.',
  '- A method call is two steps: {"prop":"mul"} then {"args":{"other":<expr>}}. A literal is {"kind":"new","type":{"name":"num"},"value":2}.',
  '- Build an obj with {"kind":"new","type":{"name":"obj","props":{…}},"value":{"<prop>":<expr>, …}}: the type slot holds the whole obj type, the value slot one entry per prop: a plain prop (text, num, bool, an enum) takes its value as is ("note":"fixed") or an expression; any other prop an expression.',
  '- `define` binds locals (each may use the ones before) and its body is the result; `block` runs lines and gives the last; `if` and `switch` choose.',
  '- A loop goes over a list (or another value whose type is known), never a bool; accumulate with `set` into a local defined outside it. Lists have methods (map, filter, …) that take a lambda.',
  '- Call a loaded fn as fns.<system>.<name> followed by its call step: {"kind":"get","path":[{"prop":"fns"},{"prop":"weather"},{"prop":"forecast"},{"args":{"city":<expr>}}]}. An instance\'s fn adds the instance: fns.database.main.orders. Only loaded fns can be called.',
  '- `template` fills {name} placeholders from its params obj.',
  '',
  `Example 1, signature (amount: num, rate: num) → obj{total: num, note: text}: ${JSON.stringify(CODE_EXAMPLES.priceWithTax.program)}`,
  `Example 2, the same with a local: ${JSON.stringify(CODE_EXAMPLES.withLocal.program)}`,
  `Example 3, signature (city: text) → text, after loading weather/forecast(city: text) → obj{summary: text}: ${JSON.stringify(CODE_EXAMPLES.callsFn.program)}`,
].join('\n');

/** The `set` call the instructions show, whole: its one arg `draft` holds every part. */
export const SET_EXAMPLE = { draft: { name: 'price_with_tax', description: 'The amount with tax at a percentage rate, and a note.', program: CODE_EXAMPLES.priceWithTax.program, sample: { amount: 100, rate: 8.25 } } };

/** The agent's job, step by step. */
const INSTRUCTIONS = [
  'You write one code fn for the request below: a small program over its args that may call other fns, saved so a person can run it again. Programs are written in gin, a JSON expression language: you see how with the examples tool. You work only through your tools, in order; each step unlocks the next, and you finish by calling return (or reuse).',
  '',
  '1. search {"text":"<what the fn needs, in a few words>"}: it lists fns the program may call and code fns that may already do it. If a code fn already does the whole request, call reuse {"fn":"<its name>"} and stop.',
  '2. load {"fns":["<system/name>",…]} for each fn the program will call (only loaded fns can be called), and {"types":[…]} only for named types a load or search listed. Call examples ({}) once to see how programs are written.',
  '3. signature {"args":<an obj type>,"returns":<a type>}: each arg a prop of the obj (an optional arg wrapped as {"name":"optional","generic":{"T":…}}). Keep it minimal: only the args the calculation needs, and a small result (a num or text is often enough).',
  '4. set the whole draft. The set tool takes ONE arg, `draft`, holding all four parts: {"draft":{"name":…,"description":…,"program":…,"sample":…}}.',
  '   name: snake_case, after what it does. description: one sentence, what it gives and what its args are for. program: one gin expression. sample: a value for every required arg, by name.',
  '   The draft is checked at once (and run with the sample when it calls no fn). If it lists problems, each names a path: fix only that part and call set again with the whole draft. Never send the same draft twice.',
  '   A wrong result type means the program or the signature is wrong: fix the one that is (declare the signature again if it changes).',
  '5. When it is clean, test {"args":{…}} other args if an edge case matters (a missing optional arg), then call return ({}). Answer in one line.',
  'If the request asks for something a program can\'t be (a page, a game, a screen, stored data) or the checks keep failing, stop and answer in one line saying what could not be written and why.',
  '',
  'Example. For "a price with tax: amount and rate (a percentage), 100 at 8.25 gives 108.25": search {"text":"price with tax"} finds nothing that fits; examples {};',
  `signature ${JSON.stringify(CODE_EXAMPLES.priceWithTax.signature)};`,
  `set ${JSON.stringify(SET_EXAMPLE)};`,
  'then return {}.',
].join('\n');

/** The fn's call as the chat model writes it. */
function callText(fn: string, args: Json): string {
  return `${fn}(${JSON.stringify(args)})`;
}

/** Check a draft against the signature; a clean one that calls no fn is run with its sample. */
async function checkDraft(draft: CodeDraft, session: Session): Promise<{ check: ProgramCheck; problems: string[]; result?: Json }> {
  const state = session.state;
  const signature = state.signature;
  if (signature === undefined) { return { check: { problems: [], calls: [] }, problems: ['Declare the signature first (signature), then set the draft again.'] }; }
  const problems: string[] = [];
  const local = state.editing === undefined ? undefined : splitName(state.editing.fn).local;
  if (local !== undefined && draft.name !== local) problems.push(`Keep the name "${local}": this changes ${state.editing?.fn ?? local}.`);
  const check = checkProgram(state.program, draft.program, signature);
  problems.push(...check.problems);
  if (problems.length > 0 || check.expr === undefined || check.calls.length > 0) return { check, problems };
  try {
    const result = await runProgram({ program: state.program, expr: check.expr, args: signature.args, returns: signature.returns, calls: [], call: () => Promise.reject(new Error('A test run calls no fn.')) }, draft.sample);
    return { check, problems, result };
  } catch (error) {
    return { check, problems: [`Running it with the sample args failed: ${error instanceof ProgramError ? error.message : String(error)}`] };
  }
}

/** `test`: run the clean draft with other args. */
const codeTest = testTool<CodeAuthoring, CodeDraft>(async (draft, args, session) => {
  const { check, problems, result } = await checkDraft({ ...draft, sample: args }, session);
  if (problems.length > 0) return `It fails with these args:\n${problems.join('\n')}`;
  if (check.calls.length > 0) return `It calls ${check.calls.join(', ')}, so it is checked, not run, while writing it.`;
  return `It gives: ${result === undefined ? 'nothing' : previewText(result)}`;
});

/** The draft's args: the name, description, the program as gin's typed expression, and sample args. */
function draftSchema(session: Session): z.ZodType<CodeDraft> {
  return z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/).describe('snake_case, after what it does.'),
    description: z.string().min(1).describe('One sentence: what it gives and what its args are for.'),
    program: session.state.program.schemas().Expr.pipe(GinExprDef).describe('The program: one gin expression whose value is the result.'),
    sample: z.record(z.string(), Json).describe('Sample args to check it with: a value for every required arg.'),
  });
}

/** The saved or reused fn, as `make_code` answers. */
function authored(fn: string, version: number, spec: CodeFnSpec, about: string, state: CodeAuthoring, sample: Json, extra: { reused: boolean; preview?: Json | undefined }): AuthoredFn {
  return {
    fn, version, about, reused: extra.reused, signature: state.program.signature(fn, spec.args, spec.returns), call: callText(fn, sample),
    ...(extra.preview === undefined ? {} : { preview: extra.preview }),
  };
}

/** The code authoring agent. Run it with the run's `ctx.ai()` and a `CodeAuthoring`. */
export const codeAuthoring = authoringAgent<CodeAuthoring, CodeDraft>({
  name: 'code_author',
  description: 'Find or write one code fn (a gin program over its args that may call fns) for a request.',
  instructions: INSTRUCTIONS,
  tools: [...programTools<CodeAuthoring, CodeDraft>(), codeTest],
  toolNames: { draft: 'set', save: 'return' },
  draft: { description: 'a code fn: name, description, the program, and sample args.', schema: draftSchema },
  async check(draft, session) {
    const { check, problems, result } = await checkDraft(draft, session);
    const note = [
      check.code === undefined ? '' : `As code: ${check.code}`,
      check.produces === undefined ? '' : `It produces: ${check.produces}`,
      check.calls.length === 0 || problems.length > 0 ? '' : `It calls ${check.calls.join(', ')}, so it was checked, not run.`,
    ].filter((line) => line !== '').join('\n');
    return { problems, ...(result === undefined ? {} : { preview: result }), ...(note === '' ? {} : { note }) };
  },
  async save(draft, session) {
    const state = session.state;
    const signature = state.signature;
    if (signature === undefined) throw new Error('Declare the signature first.');
    const spec: CodeFnSpec = { args: signature.args, returns: signature.returns, program: draft.program };
    const preview = session.lastCheck?.preview;
    const saved = await state.deps.saveFn({
      name: draft.name, description: draft.description, payload: encodeValue(CodePayload, spec),
      examples: [{ args: draft.sample, ...(preview === undefined ? {} : { result: preview }) }], replace: state.editing !== undefined,
    });
    return authored(saved.fn, saved.version, spec, draft.description, state, draft.sample, { reused: false, preview });
  },
  async reuse(fn, session) {
    const state = session.state;
    const name = QualifiedName.safeParse(fn);
    if (!name.success || !session.disclosure.awareUnloaded('fn').concat(session.disclosure.loaded('fn')).includes(fn)) return `${fn} was not listed by search.`;
    const stored = await state.deps.getFn(name.data);
    const spec = CodeFnSpec.safeParse(stored.payload);
    if (stored.kind !== CODE_KIND || !spec.success) return `${fn} is not a code fn: only a code fn can be reused; write a new one that calls it instead.`;
    await state.loadTypes([...state.program.unresolved(spec.data.args), ...state.program.unresolved(spec.data.returns)].map((type) => QualifiedName.parse(type)));
    return authored(stored.fn, stored.version, spec.data, stored.description, state, {}, { reused: true });
  },
});
