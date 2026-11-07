// Compile-time proof that a fn's status templates are checked against its args and result. Nothing here runs.

import { expectType, fn, g, type Equal, type OneTokens, type PathsOf, type TokensOf } from '@harness/sdk';

const args = g.obj({ path: g.text(), range: g.optional(g.obj({ start: g.num() })) });
const returns = g.obj({ text: g.text(), lines: g.num() });

expectType<Equal<TokensOf<'Reading {args.path|a file} as {fn}…'>, 'args.path' | 'fn'>>(true);
expectType<Equal<PathsOf<{ path: string; range?: { start: number } }>, 'path' | 'range' | 'range.start'>>(true);
expectType<Equal<OneTokens<{ path: string }, { text: string }, 'active'>, 'fn' | 'args' | 'args.path'>>(true);
expectType<Equal<OneTokens<{ path: string }, { text: string }, 'done'>, 'fn' | 'args' | 'args.path' | 'output' | 'output.text'>>(true);

// Templates that name real paths compile.
fn({
  description: 'Read a file', args, returns,
  status: {
    active: { one: 'Reading {args.path}…', many: 'Reading {n} files…' },
    retry: { one: 'Retrying {args.path}…', many: 'Retrying {n} reads…' },
    done: { one: 'Read {args.path} ({output.lines} lines)', many: 'Read {n} files' },
    failed: { one: 'Reading {args.range.start|the file} failed', many: '{n} reads failed' },
  },
});

fn({
  description: 'Read a file', args, returns,
  status: {
    // @ts-expect-error `paht` is not one of the args
    active: { one: 'Reading {args.paht}…', many: 'Reading {n} files…' },
    retry: { one: 'Retrying…', many: 'Retrying {n}…' },
    done: { one: 'Read', many: 'Read {n}' },
    failed: { one: 'Failed', many: '{n} failed' },
  },
});

fn({
  description: 'Read a file', args, returns,
  status: {
    // @ts-expect-error the result exists only once the run is done
    active: { one: 'Reading {output.text}…', many: 'Reading {n} files…' },
    retry: { one: 'Retrying…', many: 'Retrying {n}…' },
    done: { one: 'Read', many: 'Read {n}' },
    failed: { one: 'Failed', many: '{n} failed' },
  },
});

fn({
  description: 'Read a file', args, returns,
  status: {
    // @ts-expect-error a group's runs had different args, so `many` names only {fn} and {n}
    active: { one: 'Reading…', many: 'Reading {args.path}…' },
    retry: { one: 'Retrying…', many: 'Retrying {n}…' },
    done: { one: 'Read', many: 'Read {n}' },
    failed: { one: 'Failed', many: '{n} failed' },
  },
});
