/**
 * Risk 5 (the `g` builder): every builder round-trips through gin JSON and tool schemas, and gin's compatibility
 * check accepts and refuses re-declared types as expected.
 */
import { createRegistry, type Type } from '@aeye/gin';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { encodeValue, g, json, parseValue, referencesOf, wireType } from './gin.ts';
import { system } from './system.ts';
import { type } from './declare.ts';

const samples: Array<{ name: string; type: Type; value: unknown }> = [
  { name: 'text', type: g.text({ minLength: 1, maxLength: 9, pattern: '^a' }), value: 'abc' },
  { name: 'num', type: g.num({ min: 0, max: 10, whole: true }), value: 3 },
  { name: 'bool', type: g.bool(), value: true },
  { name: 'list', type: g.list(g.text(), { maxLength: 3 }), value: ['a', 'b'] },
  { name: 'obj', type: g.obj({ a: g.text(), b: g.optional(g.num()) }), value: { a: 'x' } },
  { name: 'field docs', type: g.obj({ a: g.field(g.text(), { docs: 'The a.' }) }), value: { a: 'x' } },
  { name: 'nullable', type: g.nullable(g.text()), value: null },
  { name: 'enum', type: g.enum(['low', 'high']), value: 'low' },
  { name: 'literal', type: g.literal(true), value: true },
  { name: 'or', type: g.or([g.obj({ model: g.text() }), g.obj({ category: g.text() })]), value: { category: 'fast' } },
  { name: 'tuple', type: g.tuple([g.text(), g.num()]), value: ['a', 1] },
  { name: 'duration', type: g.duration(), value: 1500 },
  { name: 'json', type: json(), value: { any: ['thing', 1] } },
];

describe('gin types as the SDK uses them', () => {
  for (const sample of samples) {
    it(`${sample.name}: round-trips through its JSON definition and stays compatible with itself`, () => {
      const def = wireType(sample.type);
      const fresh = createRegistry().parse(JSON.parse(JSON.stringify(def)));
      expect(fresh.toJSON()).toEqual(def);
      expect(fresh.compatible(sample.type)).toBe(true);
      expect(sample.type.compatible(fresh)).toBe(true);
      expect(parseValue(fresh, sample.value)).toEqual(parseValue(sample.type, sample.value));
    });

    it(`${sample.name}: makes a value schema that converts to JSON schema and accepts the value`, () => {
      const schema = sample.type.toValueSchema({ includeDocs: 'all' });
      expect(schema.safeParse(encodeValue(sample.type, parseValue(sample.type, sample.value))).success).toBe(true);
      expect(() => z.toJSONSchema(schema, { unrepresentable: 'any' })).not.toThrow();
    });
  }

  it('checks values: a value that does not fit is refused', () => {
    expect(() => parseValue(g.num({ min: 0 }), -1)).toThrow();
    expect(() => parseValue(g.obj({ a: g.text() }), {})).toThrow();
  });

  it('gives fns plain values, with timestamps as Date', () => {
    const t = g.obj({ at: g.timestamp() });
    const value = parseValue(t, { at: '2026-11-07T09:30:00.000Z' });
    expect(value.at).toBeInstanceOf(Date);
    expect(encodeValue(t, value)).toEqual({ at: '2026-11-07T09:30:00.000Z' });
  });

  it('refuses a re-declared type that narrows what was accepted', () => {
    const before = g.obj({ a: g.text() });
    const added = g.obj({ a: g.text(), b: g.num() });
    const loosened = g.obj({ a: g.text(), b: g.optional(g.num()) });
    // every value of `loosened` is a valid `before`, and the new required field makes old values invalid
    expect(before.compatible(added)).toBe(true);
    expect(added.compatible(before)).toBe(false);
    expect(loosened.compatible(before)).toBe(true);
    expect(g.text().compatible(g.num())).toBe(false);
  });

  it('reports the named types a type refers to', () => {
    const shop = system('shop', { description: 's' }).with({
      types: { Product: type({ description: 'P', shape: g.obj({ sku: g.text() }), display: { label: 'Product', title: 'sku' } }) },
    });
    const order = g.obj({ items: g.list(shop.types.Product) });
    expect(referencesOf(order)).toContain('shop/Product');
    expect(referencesOf(g.obj({ a: g.text() }))).toEqual([]);
  });
});
