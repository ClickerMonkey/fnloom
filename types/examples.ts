// Compile-time checks that the station SDK types do what docs/harness.md promises. Nothing here runs; `npm run
// typecheck` fails if an expectation breaks. Each `@ts-expect-error` is a mistake an author must not be able to make.
import { station, fn, handler, serve, g, type Infer, type FnOutcome } from './harness.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const expect = <T extends true>(_: T): void => undefined;

// ── shared/: the contract ──────────────────────────────────────────────────────
const FileInfo = g.obj({ path: g.text(), size: g.num({ min: 0, whole: true }), note: g.optional(g.text()) });
expect<Equal<Infer<typeof FileInfo>, { path: string; size: number; note?: string }>>(true);

const fsDemo = station('fs', {
  description: 'Files and a shell.',
  types: { FileInfo },
  fns: {
    stat: fn({ description: 'Stat a path.', args: g.obj({ path: g.text() }), returns: FileInfo }),
    copy: fn({
      description: 'Copy a file.',
      args: g.obj({ from: g.text(), to: g.text() }),
      returns: g.obj({ bytes: g.num() }),
      progress: { type: 'steps', steps: [{ name: 'read', title: 'Read' }, { name: 'write', title: 'Write' }] },
      handlers: { overwrite: handler({ description: 'Target exists: overwrite?', args: g.obj({ path: g.text() }), returns: g.bool(), required: true }) },
      undo: g.obj({ path: g.text() }),
    }),
  },
});

// refs carry qualified names and types
expect<Equal<typeof fsDemo.fns.stat.name, 'fs/stat'>>(true);
expect<Equal<typeof fsDemo.types.FileInfo.name, 'fs/FileInfo'>>(true);

// another station depends on fs and calls it
const backup = station('backup', {
  description: 'Backs things up.',
  fns: {
    snapshot: fn({
      description: 'Copy a file next to itself.',
      args: g.obj({ path: g.text() }),
      returns: g.obj({ copy: g.text() }),
      deps: { stat: fsDemo.fns.stat, copy: fsDemo.fns.copy },
    }),
  },
});

// ── server/: the implementation ────────────────────────────────────────────────
void serve(backup, {
  snapshot: {
    async run(args, ctx): Promise<FnOutcome<{ copy: string }, never, never>> {
      const info = await ctx.fns.stat({ path: args.path }).result;
      expect<Equal<typeof info.size, number>>(true);
      // @ts-expect-error copy declares a required handler, so it can't be called without one
      ctx.fns.copy({ from: args.path, to: `${args.path}.bak` });
      const done = await ctx.fns.copy({ from: args.path, to: `${args.path}.bak` }, { handlers: { overwrite: async () => true } }).result;
      // @ts-expect-error not a dep
      ctx.fns.remove({ path: args.path });
      return { status: 'done', result: { copy: `${args.path}.bak (${done.bytes} bytes)` } };
    },
  },
}, { hub: 'ws://localhost:4100', stateDir: '.station' });

void serve(fsDemo, {
  stat: { async run(args) { return { status: 'done', result: { path: args.path, size: 0 } }; } },
  copy: {
    async run(args, ctx) {
      ctx.progress.step('read', 'active');
      // @ts-expect-error not a declared step
      ctx.progress.step('verify', 'active');
      const ok = await ctx.handlers.overwrite({ path: args.to });
      return ok ? { status: 'done', result: { bytes: 1 }, undo: { path: args.to } } : { status: 'cancelled' };
    },
    // copy declares an undo type, so undo is required (leaving it out is an error)
    async undo(payload) { return { status: 'undone', summary: `removed ${payload.path}` }; },
  },
}, { hub: 'ws://localhost:4100', stateDir: '.station' });

// @ts-expect-error every fn in the contract must be implemented
void serve(fsDemo, { stat: { async run(args) { return { status: 'done', result: { path: args.path, size: 0 } }; } } }, { hub: '', stateDir: '' });

// @ts-expect-error copy declares an undo type, so its impl must have undo
void serve(fsDemo, { stat: { async run(args) { return { status: 'done', result: { path: args.path, size: 0 } }; } }, copy: { async run() { return { status: 'cancelled' }; } } }, { hub: '', stateDir: '' });

// an optional handler may be missing, so it must be checked before calling
const asker = station('asker', {
  description: 'Asks optionally.',
  fns: { go: fn({ description: 'Go.', args: g.obj({}), returns: g.bool(), handlers: { confirm: handler({ description: 'Sure?', args: g.obj({}), returns: g.bool(), required: false }) } }) },
});
void serve(asker, {
  go: {
    async run(_args, ctx) {
      // @ts-expect-error confirm is optional: it may be undefined
      await ctx.handlers.confirm({});
      const ok = ctx.handlers.confirm ? await ctx.handlers.confirm({}) : true;
      return { status: 'done', result: ok };
    },
  },
}, { hub: '', stateDir: '' });
// calling a fn whose only handler is optional needs no options
const caller = station('caller', { description: 'Calls asker.', fns: { run: fn({ description: 'Run.', args: g.obj({}), returns: g.bool(), deps: { go: asker.fns.go } }) } });
void serve(caller, { run: { async run(_args, ctx) { return { status: 'done', result: await ctx.fns.go({}).result }; } } }, { hub: '', stateDir: '' });
