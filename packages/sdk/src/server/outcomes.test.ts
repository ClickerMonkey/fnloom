/**
 * Outcomes beyond done and failed, against the in-memory hub: args that don't fit the fn's type and `ctx.invalid` both
 * settle `invalid-input` with problems by path (the caller's mistake, which an agent retries), and `ctx.expose` sends
 * the fns a result shows the agent along with it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidInput, type OutcomeWire } from '@harness/core';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { type } from '../declare.ts';
import { serve, type RunningSystem } from './index.ts';
import { FakeHub } from './testing.ts';

const Span = type({
  description: 'A span of lines.',
  shape: g.obj({ from: g.num({ min: 1, whole: true }), to: g.num({ min: 1, whole: true }) }),
  display: { label: 'Span' },
  methods: { width: fn({ description: 'How many lines.', args: g.obj({ step: g.num({ min: 1 }) }), returns: g.num() }) },
});

const lines = system('lines', { description: 'Lines for tests.' })
  .with({ types: { Span } })
  .with(({ types }) => ({
    fns: {
      read: fn({ description: 'Read lines.', args: g.obj({ path: g.text(), span: g.optional(types.Span) }), returns: g.text() }),
      open: fn({ description: 'Open a file.', args: g.obj({ path: g.text() }), returns: g.text() }),
    },
  }))
  .with(({ fns }) => ({
    fns: {
      search: fn({
        description: 'Search.',
        args: g.obj({ query: g.text() }),
        returns: g.list(g.text()),
        examples: [{ args: { query: 'todo' }, note: 'Every line with a todo.' }],
        deps: { read: fns.read },
      }),
    },
  }));

let running: RunningSystem<'lines'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function start(hub: FakeHub): Promise<void> {
  running = await serve(lines, {
    fns: {
      read: {
        async run(args, ctx) {
          if (args.path.startsWith('/')) { return ctx.invalid([{ path: 'path', message: 'Give a path inside the root.' }]); }
          if (args.span !== undefined && args.span.to < args.span.from) { return ctx.invalid('The span ends before it starts.'); }
          return ctx.done(`lines of ${args.path}`);
        },
      },
      open: { async run(args, ctx) { return ctx.done(args.path); } },
      search: {
        async run(args, ctx) {
          ctx.expose(lines.fns.read, 'full');
          ctx.expose(lines.fns.open);
          // the last detail asked for a fn wins
          ctx.expose(lines.fns.open, 'listed');
          return ctx.done([args.query]);
        },
      },
    },
    types: { Span: { width: { async run(self, args, ctx) { return ctx.done((self.to - self.from + 1) / args.step); } } } },
  }, { hub: 'ws://hub.test/link', state: 'unused', version: '1.0.0' }, hub.host());
  await running.ready();
}

function invalid(outcome: OutcomeWire): InvalidInput {
  if (outcome.status !== 'invalid-input') { throw new Error(`expected invalid-input, got ${JSON.stringify(outcome)}`); }
  return InvalidInput.parse(outcome.invalid);
}

describe('invalid input', () => {
  it('refuses args that do not fit the args type before the fn runs, with each problem at its path', async () => {
    const hub = new FakeHub();
    await start(hub);
    const refused = invalid(await hub.run('lines/read', { path: 7, span: { from: 0, to: 2 } }));
    expect(refused.source).toBe('schema');
    expect(refused.problems.map((p) => p.path).sort()).toEqual(['path', 'span.from']);
    expect(refused.problems.every((p) => p.message.length > 0)).toBe(true);
  });

  it('refuses a method\'s value or args the same way', async () => {
    const hub = new FakeHub();
    await start(hub);
    expect(await hub.run('lines/Span.width', { self: { from: 1, to: 4 }, step: 2 })).toEqual({ status: 'done', result: 2 });
    const refused = invalid(await hub.run('lines/Span.width', { self: { from: 1, to: 4 }, step: 0 }));
    expect(refused).toMatchObject({ source: 'schema', problems: [{ path: 'step' }] });
  });

  it('lets a fn refuse args its types allow, by path or with a message', async () => {
    const hub = new FakeHub();
    await start(hub);
    expect(invalid(await hub.run('lines/read', { path: '/etc/passwd' }))).toEqual({
      source: 'validation', problems: [{ path: 'path', message: 'Give a path inside the root.' }],
    });
    expect(invalid(await hub.run('lines/read', { path: 'a.md', span: { from: 5, to: 2 } }))).toEqual({
      source: 'validation', problems: [{ path: '', message: 'The span ends before it starts.' }],
    });
    expect(await hub.run('lines/read', { path: 'a.md' })).toEqual({ status: 'done', result: 'lines of a.md' });
  });
});

describe('exposing fns', () => {
  it('sends the fns a result shows the agent, one per fn at the last detail asked', async () => {
    const hub = new FakeHub();
    await start(hub);
    expect(await hub.run('lines/search', { query: 'todo' })).toEqual({
      status: 'done', result: ['todo'], expose: [{ fn: 'lines/read', detail: 'full' }, { fn: 'lines/open', detail: 'listed' }],
    });
    // a fn that exposes nothing sends no list
    expect(await hub.run('lines/open', { path: 'a' })).toEqual({ status: 'done', result: 'a' });
  });

  it('puts the examples in the manifest, encoded with the args type', async () => {
    const hub = new FakeHub();
    await start(hub);
    const search = hub.manifests.at(-1)?.fns.find((f) => f.name === 'search');
    expect(search?.examples).toEqual([{ args: { query: 'todo' }, note: 'Every line with a todo.' }]);
    expect(hub.manifests.at(-1)?.fns.find((f) => f.name === 'open')).not.toHaveProperty('examples');
  });
});
