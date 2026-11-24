// Compile-time proof that a fn's args check is typed by its declaration: it may only name the fn's own deps, its
// implementation is required exactly when it is declared, and its ctx calls only the deps the check names.
// Nothing here runs.

import { expectType, fn, g, hub, system, type CheckProblems, type Equal, type SystemImpl } from '@harness/sdk';

const args = g.obj({ fn: g.fnName(), limit: g.num() });

// a check that reads `hub/fns_get`, and one that calls nothing
const add = fn({ description: 'Add.', args, returns: g.bool(), deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save }, check: { calls: ['getFn'] } });
expectType<Equal<typeof add.check, { readonly calls: readonly string[] } | undefined>>(true);
const plain = fn({ description: 'Plain.', args, returns: g.bool(), check: true });
const none = fn({ description: 'None.', args, returns: g.bool() });

// @ts-expect-error `getFns` is not one of the fn's deps
fn({ description: 'Add.', args, returns: g.bool(), deps: { getFn: hub.fns.fns_get }, check: { calls: ['getFns'] } });
// @ts-expect-error a fn with no deps can't name one for its check
fn({ description: 'Add.', args, returns: g.bool(), check: { calls: ['getFn'] } });

const checking = system('checking', { description: 'Checks its args.' }).with({ fns: { add, plain, none } });

export const impl: SystemImpl<(typeof checking)['defs']> = {
  fns: {
    add: {
      async run(_args, ctx) { return ctx.done(true); },
      async check(input, ctx) {
        expectType<Equal<typeof input.limit, number>>(true);
        const target = await ctx.fns.getFn({ fn: input.fn });
        // @ts-expect-error the check calls only the deps it names: saving is the run's
        void ctx.fns.saveFn;
        // @ts-expect-error a check makes no model calls
        void ctx.llm;
        const problems: CheckProblems = target.available ? [] : [{ path: 'fn', message: `${input.fn} can't run now.` }];
        return problems;
      },
    },
    plain: {
      async run(_args, ctx) { return ctx.done(true); },
      check: (input) => Promise.resolve(input.limit > 0 ? [] : [{ path: 'limit', message: 'more than 0' }]),
    },
    none: { async run(_args, ctx) { return ctx.done(true); } },
  },
};

export const missing: SystemImpl<(typeof checking)['defs']> = {
  fns: {
    // @ts-expect-error a fn that declares a check must implement it
    add: { async run(_args, ctx) { return ctx.done(true); } },
    plain: { async run(_args, ctx) { return ctx.done(true); }, check: () => Promise.resolve([]) },
    none: { async run(_args, ctx) { return ctx.done(true); } },
  },
};

export const extra: SystemImpl<(typeof checking)['defs']> = {
  fns: {
    add: { async run(_args, ctx) { return ctx.done(true); }, check: () => Promise.resolve([]) },
    plain: { async run(_args, ctx) { return ctx.done(true); }, check: () => Promise.resolve([]) },
    // @ts-expect-error a fn that declares no check has none to implement
    none: { async run(_args, ctx) { return ctx.done(true); }, check: () => Promise.resolve([]) },
  },
};

export const wrong: SystemImpl<(typeof checking)['defs']> = {
  fns: {
    add: {
      async run(_args, ctx) { return ctx.done(true); },
      // @ts-expect-error problems are { path, message }
      check: () => Promise.resolve(['limit is wrong']),
    },
    plain: { async run(_args, ctx) { return ctx.done(true); }, check: () => Promise.resolve([]) },
    none: { async run(_args, ctx) { return ctx.done(true); } },
  },
};
