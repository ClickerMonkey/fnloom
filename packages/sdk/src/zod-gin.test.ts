import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseValue } from './gin.ts';
import { ginOf, toolArgsOf } from './zod-gin.ts';

describe('gin types read off zod schemas', () => {
  const Shape = z.object({
    name: z.string().min(1).max(40).describe('What it is called.'),
    email: z.email(),
    count: z.number().int().min(0),
    ratio: z.number().max(1),
    on: z.boolean().optional(),
    mode: z.enum(['fast', 'slow']).default('fast'),
    one: z.literal('only'),
    tags: z.array(z.string()),
    scope: z.discriminatedUnion('scope', [z.object({ scope: z.literal('hub') }), z.object({ scope: z.literal('user'), user: z.string() })]),
    extra: z.record(z.string(), z.number()),
    note: z.string().nullable(),
    data: z.json(),
    when: z.string().transform((text) => text.length),
  });

  it('accepts what the schema accepts and refuses what it refuses', () => {
    const type = ginOf(Shape);
    const value = {
      name: 'a', email: 'a@b.co', count: 2, ratio: 0.5, one: 'only', tags: ['x'], scope: { scope: 'user', user: 'u' }, extra: { k: 1 }, note: null,
      data: { any: [1, 'two'] }, when: 'now',
    };
    expect(parseValue(type, value)).toMatchObject({ name: 'a', count: 2, scope: { scope: 'user', user: 'u' }, when: 'now' });
    expect(Shape.parse(parseValue(type, value)).when).toBe(3);
    for (const bad of [{ count: 1.5 }, { count: -1 }, { ratio: 2 }, { name: '' }, { mode: 'medium' }, { one: 'other' }, { scope: { scope: 'galaxy' } }, { tags: [1] }]) {
      expect(() => parseValue(type, { ...value, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });

  it('keeps a field description as its docs and whole numbers as whole', () => {
    const def = JSON.stringify(ginOf(Shape).toJSON());
    expect(def).toContain('"docs":"What it is called."');
    expect(def).toContain('"whole":true');
  });

  it('refuses a schema gin has no type for', () => {
    expect(() => ginOf(z.promise(z.string()))).toThrow(/no gin type/);
  });

  it('takes a non-object schema as the args field input, and reads it back through the schema', () => {
    const Either = z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]);
    const tool = toolArgsOf(Either);
    expect(parseValue(tool.args, { input: { b: 2 } })).toEqual({ input: { b: 2 } });
    expect(tool.read({ input: { b: 2 } })).toEqual({ b: 2 });
    expect(() => tool.read({ b: 2 })).toThrow();
    const plain = toolArgsOf(z.object({ a: z.string() }));
    expect(plain.read({ a: 'x' })).toEqual({ a: 'x' });
  });
});

describe('required fields', () => {
  it('reads `.required()` objects as fields that must be there', () => {
    const Limits = z.object({ window: z.number().int().optional(), output: z.number().int().default(256) }).required();
    const type = ginOf(Limits);
    expect(parseValue(type, { window: 4096, output: 512 })).toEqual({ window: 4096, output: 512 });
    expect(() => parseValue(type, { window: 4096 })).toThrow();
  });
});

describe('records', () => {
  const Metric = z.enum(['embedding', 'words']);
  const Weight = z.object({ weight: z.number().min(0), k: z.number().positive().optional() }).describe('A part of the score.');

  it('reads a partial record over an enum as an object of optional fields, one per key', () => {
    const type = ginOf(z.partialRecord(Metric, Weight));
    expect(parseValue(type, {})).toEqual({});
    expect(parseValue(type, { words: { weight: 2 } })).toEqual({ words: { weight: 2 } });
    expect(() => parseValue(type, { words: { weight: -1 } })).toThrow();
    expect(JSON.stringify(type.toJSON())).toContain('"docs":"A part of the score."');
  });

  it('reads a record over an enum as an object that needs every key', () => {
    const type = ginOf(z.record(Metric, z.number()));
    expect(parseValue(type, { embedding: 1, words: 2 })).toEqual({ embedding: 1, words: 2 });
    expect(() => parseValue(type, { embedding: 1 })).toThrow();
  });

  it('reads a record over literal keys as an object, and one over open or loose keys as any JSON', () => {
    expect(parseValue(ginOf(z.record(z.literal(['a', 'b']), z.boolean())), { a: true, b: false })).toEqual({ a: true, b: false });
    expect(ginOf(z.record(z.string(), z.number())).toJSON()).toEqual(ginOf(z.json()).toJSON());
    expect(ginOf(z.looseRecord(Metric, z.number())).toJSON()).toEqual(ginOf(z.json()).toJSON());
  });
});
