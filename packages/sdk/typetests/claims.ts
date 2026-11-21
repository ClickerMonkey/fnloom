// Compile-time proof that a fn's parallel claims are checked against its args, and that its claims hook is typed.
// Nothing here runs.

import { expectType, fn, g, system, type ClaimTokens, type Equal, type SystemImpl } from '@harness/sdk';

const args = g.obj({ path: g.text(), paths: g.list(g.text()), dir: g.optional(g.text()) });

expectType<Equal<ClaimTokens<{ path: string; dir?: string }>, 'args.path' | 'args.dir'>>(true);

// Claims that read real args compile; a list gives one claim per item, a fallback fills an arg left out.
const write = fn({ description: 'Write files.', args, returns: g.bool(), parallelClaims: ['file:{args.path}', 'file:{args.paths}', 'dir:{args.dir|.}'] });
expectType<Equal<typeof write.parallelClaims, readonly string[]>>(true);
expectType<Equal<typeof write.dynamicClaims, boolean>>(true);
// '*' runs alone, and a claim may have no tokens at all
fn({ description: 'Restart.', args: g.obj({}), returns: g.bool(), parallelClaims: ['*', 'restart'] });

// @ts-expect-error `paht` is not one of the args
fn({ description: 'Write a file.', args, returns: g.bool(), parallelClaims: ['file:{args.paht}'] });
// @ts-expect-error a claim reads only the args
fn({ description: 'Write a file.', args, returns: g.bool(), parallelClaims: ['file:{output.path}'] });

// Dynamic claims come from the implementation, typed by the fn's args and given the call's context.
const moving = system('moving', { description: 'Moves files.' }).with({
  fns: { move: fn({ description: 'Move a file.', args: g.obj({ from: g.text(), to: g.text() }), returns: g.bool(), dynamicClaims: true }) },
});
export const impl: SystemImpl<(typeof moving)['defs']> = {
  fns: {
    move: {
      async run(_args, ctx) { return ctx.done(true); },
      claims: (args, ctx) => [`file:${args.from}`, `file:${args.to}`, `chat:${ctx.session ?? 'none'}`],
    },
  },
};
export const wrong: SystemImpl<(typeof moving)['defs']> = {
  fns: {
    move: {
      async run(_args, ctx) { return ctx.done(true); },
      // @ts-expect-error claims are strings
      claims: (args) => [args.from.length],
    },
  },
};
