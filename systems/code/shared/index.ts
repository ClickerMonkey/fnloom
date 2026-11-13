/**
 * The code system's contract (`shared/`), after product's code kind (build 9 design §5). A code fn is one gin program
 * over its args that may call other fns (`fns.<system>.<name>(…)`), kept in the hub as a `code/program` fn: the hub
 * searches it, shares it and versions it; nothing is stored here.
 *
 * - **The kind** `code/program` (payload `CodeFnSpec`): describing it reads the program for the fns it calls (its
 *   deps); running it binds `args` and those fns and runs it within the program runtime's limits (`programEnv`).
 * - **make_code** is an authoring fn: an agent on `ctx.ai()` searches the fns it may call, loads what it needs, declares
 *   the signature, writes the program against gin's typed schema, has it checked (and run with sample args when it
 *   calls no fn), and saves it with `hub/save_fn`. The chat gets the saved fn, never the working context.
 */
import { CODE_KIND, CODE_SYSTEM, CodeFnSpec } from '@harness/core';
import { context, fn, g, ginAs, hub, kind, system } from '@harness/sdk';
import { authoredFn } from '@harness/sdk/server';

/** A code fn's payload, as gin (`CodeFnSpec`'s type). */
export const CodePayload = ginAs(CodeFnSpec);

/** What `make_code` is asked. */
export const MakeCodeArgs = g.obj({
  request: g.field(g.text({ minLength: 1 }), { docs: 'What the fn should do, in plain words: its inputs, what it gives back, the fns it should use, and an example.' }),
  fn: g.field(g.optional(g.text({ minLength: 1 })), { docs: 'A code fn to change (`code/total_with_tax`); a new version of it is saved.' }),
});

/** How callers of `make_code` use it. */
const MAKE_USAGE = [
  'Use it when the person wants a calculation or a small piece of logic kept as a fn they can run again: a formula, reshaping data, combining what other fns give.',
  'Describe it in `request`: the args (names and types), what it returns, the fns it should call, and one example with its expected result.',
  'It searches for an existing code fn first and reuses it when one fits. To change a code fn, pass it as `fn`.',
  'Call the saved fn afterwards by its name with the args its signature shows.',
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
  groups: [{ name: 'code', title: 'Code', description: 'Write a code fn for a calculation or small piece of logic, and keep it to run again.' }],
  // the authoring agent is a model; code fns are hub fns it searches, reads and saves; a saved program calls fns by
  // name (its kind's deps), which the hub checks per call
  grants: { hub: ['ai', 'fns', 'search'], calls: [hub.fns.fn_get.name, hub.fns.save_fn.name] },
})
  .with({
    kinds: {
      program: kind({
        description: 'A code fn: a gin program over its args that may call other fns, giving a typed result.',
        applicability: 'A calculation or small piece of logic the person will run again (a price with tax, a summary of what other fns give), written by code/make_code.',
        payload: CodePayload,
        // make_code keeps every fn it writes; what a program changes, it changes through fns that ask for themselves
        approveChanges: false,
        status: status('Running {fn}…', 'Ran {fn}', 'Running {fn} failed'),
      }),
    },
    fns: {
      make_code: fn({
        group: 'code',
        description: 'Write a code fn (a small program that may call other fns) for what is asked, or reuse one that does it, and save it.',
        instructions: MAKE_USAGE,
        args: MakeCodeArgs,
        returns: authoredFn,
        deps: { getFn: hub.fns.fn_get, saveFn: hub.fns.save_fn },
        examples: [
          { args: { request: 'A price with tax: args amount (num) and rate (num, a percentage); returns the total rounded to cents. 100 at 8.25 gives 108.25.' }, note: 'A calculation with no other fns.' },
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
        description: 'How to keep a calculation or small piece of logic as a code fn.',
        content: [
          'When the person wants a calculation, a reshaping of data or a combination of what other fns give kept as a fn, call code/make_code with what it should do.',
          'It reuses a code fn that already does it. Then call the fn it gives by name; never redo its work by hand.',
        ].join(' '),
        fns: [fns.make_code],
        tags: ['code'],
      }),
    },
  }));

/** The code contract's type. */
export type CodeContract = typeof code;
