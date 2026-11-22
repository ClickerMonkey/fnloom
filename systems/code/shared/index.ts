/**
 * The code system's contract (`shared/`), after product's code kind (build 9 design §5). A code fn is one gin program
 * over its args that may call other fns (`fns.<system>.<name>(…)`), kept in the hub as a `code/program` fn: the hub
 * searches it, shares it and versions it; nothing is stored here.
 *
 * - **The kind** `code/program` (payload `CodeFnSpec`): describing it reads the program for the fns it calls (its
 *   deps); running it binds `args` and those fns and runs it within the program runtime's limits (`programEnv`).
 * - **make_code** is an authoring fn: an agent on `ctx.ai()` searches the fns it may call, loads what it needs, declares
 *   the signature, writes the program against gin's typed schema, has it checked (and run with sample args when it
 *   calls no fn), and saves it with `hub/fns_save`. The chat gets the saved fn, never the working context.
 */
import { CODE_KIND, CODE_SYSTEM, CodeFnSpec } from '@harness/core';
import { context, fn, g, ginAs, hub, kind, system } from '@harness/sdk';
import { authoredFn } from '@harness/sdk/server';

/** A code fn's payload, as gin (`CodeFnSpec`'s type). */
export const CodePayload = ginAs(CodeFnSpec);

/** What `make_code` is asked. */
export const MakeCodeArgs = g.obj({
  request: g.field(g.text({ minLength: 1 }), { docs: 'The calculation, in plain words: its inputs (names and kinds), what it gives back, any fns it should call, and one example with the expected result. Describe the logic, not the person\'s data.' }),
  fn: g.field(g.optional(g.text({ minLength: 1 })), { docs: 'A code fn to change (`code/total_with_tax`); a new version of it is saved.' }),
});

/** How callers of `make_code` use it. */
const MAKE_USAGE = [
  'Use it when the person wants a calculation or a small piece of logic kept as a fn they can run again with new inputs: a formula (a price with tax, a split of a bill), reshaping a list, combining what other fns give.',
  'Don\'t use it for a one-off answer (work that out yourself), to keep the person\'s data (a code fn stores nothing: use a database table), or for an interactive page, game, app or screen (a code fn has no screen: it takes args and returns one value).',
  'Describe the calculation in `request`, not the data: the args (names and kinds: text, number, yes/no, a date, a list), what it returns, any fns it should call, and one example with its expected result. Keep it minimal: only the args the calculation needs and a small result.',
  'Another agent writes the program, checks it and saves it as a code/program fn; that can take a minute. It reuses a code fn that already does it. To change a code fn, pass it as `fn`: a new version is saved.',
  'It returns `fn` (the saved fn\'s name, like code/price_with_tax), `signature` (its args and result), `call` (how to call it), `preview` (what it gave for a sample, when it could run one) and `reused`.',
  'Then load that fn and call it by name with the person\'s values to give them the answer: never redo its work by hand. If it fails, tell the person it could not be written and why; don\'t call it again with the same request.',
].join(' ');

const status = (active: string, done: string, failed: string) => ({
  active: { one: active, many: active },
  retry: { one: active, many: active },
  done: { one: done, many: done },
  failed: { one: failed, many: failed },
});

/** The code system's contract. */
export const code = system(CODE_SYSTEM, {
  description: 'Small programs kept as fns: each reads its args, may call other fns and gives a typed result. make_code writes one on request.',
  about: [
    'Small saved programs for calculations and bits of logic: a price with tax, a bill split, a total over what another fn returns, reshaping a list.',
    'It has one fn you call, code/make_code: give it a plain description of the calculation and another agent writes, checks and saves it as a fn of the code system\'s kind code/program, named for what it does (such as code/price_with_tax).',
    'That saved fn is the person\'s to run again by name with new inputs, and its program may call other fns.',
    'A code fn only works out a result from its args: it is not an interactive page, game, app or screen, it stores none of the person\'s data (use a database table for that), and it never runs by itself later.',
    'Reach for it when the person wants a calculation they will repeat; for a one-off answer, just work it out. Load code/guide before first use.',
  ].join(' '),
  groups: [{ name: 'code', title: 'Code', description: 'Write a code fn for a calculation or small piece of logic, and keep it to run again.' }],
  // the authoring agent is a model; code fns are hub fns it searches, reads and saves; a saved program calls fns by
  // name (its kind's deps), which the hub checks per call
  grants: { hub: ['ai', 'fns', 'search'], calls: [hub.fns.fns_get.name, hub.fns.fns_save.name] },
})
  .with({
    kinds: {
      program: kind({
        description: 'A code fn: a small saved program over its args that may call other fns and gives one typed result. Calling it by name with args runs the program; it stores nothing and shows no screen.',
        applicability: 'A calculation or small piece of logic the person will run again (a price with tax, a summary of what other fns give), written by code/make_code and then called by its name.',
        payload: CodePayload,
        // make_code keeps every fn it writes; what a program changes, it changes through fns that ask for themselves
        approveChanges: false,
        status: status('Running {fn}…', 'Ran {fn}', 'Running {fn} failed'),
      }),
    },
    fns: {
      make_code: fn({
        group: 'code',
        description: 'Have a calculation or small piece of logic written as a program, checked and saved as a code/program fn the person can run again (or reuse one that already does it); it gives back the new fn\'s name and signature.',
        instructions: MAKE_USAGE,
        args: MakeCodeArgs,
        returns: authoredFn,
        deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save },
        examples: [
          { args: { request: 'A price with tax: args amount (num) and rate (num, a percentage); returns the total rounded to cents. 100 at 8.25 gives 108.25.' }, note: 'A calculation with no other fns.' },
          { args: { request: 'Split a bill: args total (number, dollars), people (whole number, at least 1) and tipPercent (optional number, default 0); returns each person\'s share rounded to cents. 90 for 3 people with 10% tip gives 33.' }, note: 'An optional arg with a default.' },
          { args: { request: 'The forecast for a city as one line: arg city (text); call weather/forecast and give "<city>: <summary>".' }, note: 'A program that calls another fn.' },
          { args: { request: 'Also take a discount percentage, applied before tax.', fn: 'code/price_with_tax' }, note: 'Changing a code fn saves a new version.' },
        ],
        status: status('Writing code…', 'Wrote {output.fn}', 'Writing code failed'),
        // the agent is a model call of the run; it saves the fn it writes
        effects: { mode: 'write', free: false, registry: [{ thing: 'fns', action: 'create', kind: CODE_KIND }, { thing: 'fns', action: 'update', kind: CODE_KIND }] },
        tags: ['code', 'write'],
      }),
    },
  })
  .with(({ fns }) => ({
    context: {
      guide: context({
        description: 'How to keep a calculation or small piece of logic as a code fn the person can run again.',
        content: [
          '# Keeping a calculation as a code fn',
          '',
          'A code fn is a small saved program: it takes args, may call other fns, and returns one value. It is good for a calculation the person will repeat with new inputs.',
          'It is not a way to keep data (use a database table), to show a page, game or app (it has no screen), or to do something later on its own (nothing runs by itself).',
          '',
          'Steps:',
          '1. Look for one first: hub/fns_search with kinds ["code/program"] and a few words of what it does. If one fits, call it.',
          '2. Otherwise call code/make_code with `request`: the args (names and kinds), what it returns, any fns it should call, and one example with the expected result. Example args:',
          '   {"request":"A price with tax: args amount (num) and rate (num, a percentage); returns the total rounded to cents. 100 at 8.25 gives 108.25."}',
          '3. It answers with the saved fn: {"fn":"code/price_with_tax","signature":"code/price_with_tax(amount: num, rate: num) → num","call":"…","reused":false,…}. Writing takes up to a minute.',
          '4. Load that fn (hub/fns_load) and call it with the person\'s values, then give them the result. Never redo its work by hand.',
          '',
          'To change a code fn, call code/make_code with `fn` set to its name and `request` saying what to change; a new version is saved under the same name.',
          'If code/make_code fails, tell the person it could not be written and the reason it gave; don\'t send the same request again.',
        ].join('\n'),
        fns: [fns.make_code],
        tags: ['code'],
      }),
    },
  }));

/** The code contract's type. */
export type CodeContract = typeof code;
