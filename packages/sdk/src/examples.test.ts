/**
 * Every fn has at least one example. A static fn's author writes it (the build and `serve` refuse a contract without:
 * `checkExamples`, `LinkHost`); a kind works one out from its payload's args with `sampleOf` / `sampleArgs`, whose
 * samples its own type accepts.
 */
import { describe, expect, it } from 'vitest';
import { agent } from './agent.ts';
import { type } from './declare.ts';
import { fn } from './fn.ts';
import { g, parseValue, sampleArgs, sampleOf, wireType, type GinType } from './gin.ts';
import { checkExamples, fnsMissingExamples, MissingExamplesError } from './manifest.ts';
import { LinkHost } from './server/host.ts';
import { system } from './system.ts';

describe('sampleOf', () => {
  const cases: Array<{ name: string; type: GinType }> = [
    { name: 'text', type: g.text() },
    { name: 'short text', type: g.text({ minLength: 10, maxLength: 12 }) },
    { name: 'num in range', type: g.num({ min: 3, max: 9, whole: true }) },
    { name: 'num below one', type: g.num({ max: 0 }) },
    { name: 'bool', type: g.bool() },
    { name: 'enum', type: g.enum(['day', 'week']) },
    { name: 'literal', type: g.literal('fixed') },
    { name: 'union', type: g.or([g.num(), g.text()]) },
    { name: 'list', type: g.list(g.text()) },
    { name: 'nullable', type: g.nullable(g.num()) },
    { name: 'obj', type: g.obj({ city: g.text(), nights: g.num({ min: 1, whole: true }), who: g.optional(g.list(g.text())) }) },
  ];

  it.each(cases)('gives a value its own type accepts: $name', ({ type: t }) => {
    expect(() => parseValue(t, sampleOf(wireType(t)))).not.toThrow();
  });

  it('gives a patterned text its hint, best effort (gin synthesizes nothing from a pattern either)', () => {
    expect(sampleOf(wireType(g.text({ pattern: '^[0-9]+$' })), 'code')).toBe('code');
  });

  it('fills required fields by name and leaves optional ones out', () => {
    expect(sampleOf(wireType(g.obj({ city: g.text(), nights: g.num({ min: 2, whole: true }), kind: g.enum(['hotel', 'tent']), note: g.optional(g.text()) }))))
      .toEqual({ city: 'city', nights: 2, kind: 'hotel' });
  });

  it('gives args only for an obj: open args are a call with nothing in it', () => {
    expect(sampleArgs(wireType(g.obj({ q: g.text() })))).toEqual({ q: 'q' });
    expect(sampleArgs({ name: 'any' })).toEqual({});
  });
});

/** A contract with one fn of each static sort, each with or without an example. */
function contractWith(examples: boolean) {
  const one = examples ? { examples: [{ args: { q: 'x' } }] } : {};
  return system('notes', { description: 'Notes.' }).with({
    types: { Note: type({ description: 'A note.', shape: g.obj({ id: g.text() }), display: { label: 'Note' }, methods: { pin: fn({ description: 'Pin.', args: g.obj({ q: g.text() }), returns: g.bool(), ...one }) } }) },
    fns: {
      find: fn({ description: 'Find.', args: g.obj({ q: g.text() }), returns: g.text(), ...one }),
      ask: agent({ description: 'Ask.', args: g.obj({ q: g.text() }), returns: g.text(), instructions: 'Answer.', ...one }),
    },
  });
}

describe('checkExamples', () => {
  it('passes a contract whose every static fn has an example', () => {
    expect(() => { checkExamples(contractWith(true)); }).not.toThrow();
  });

  it('refuses one without, naming native fns, agents and type methods', () => {
    expect(() => { checkExamples(contractWith(false)); }).toThrow(MissingExamplesError);
    expect(() => { checkExamples(contractWith(false)); }).toThrow(/system notes: every fn needs at least one example, and find, ask, Note\.pin have none/);
  });

  it('leaves fns of a system kind to their kind', () => {
    expect(fnsMissingExamples([
      { name: 'saved', kind: 'database/query' },
      { name: 'own', kind: 'native' },
      { name: 'agent', kind: 'hub/llm', examples: [] },
      { name: 'done', kind: 'native', examples: [{ args: {} }] },
    ])).toEqual(['own', 'agent']);
  });

  it('is what serving refuses, before anything connects', async () => {
    const contract = contractWith(false);
    await expect(new LinkHost({ signals: false }).start(contract, {
      fns: { find: { run: (_args, ctx) => Promise.resolve(ctx.done('found')) } },
      types: { Note: { pin: { run: (_self, _args, ctx) => Promise.resolve(ctx.done(true)) } } },
    }, { hub: 'ws://hub.test/link', state: 'unused', version: '1' })).rejects.toThrow(MissingExamplesError);
  });
});
