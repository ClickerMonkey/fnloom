/**
 * Risk 5 (the `g` builder): every builder round-trips through gin JSON and tool schemas, and gin's compatibility
 * check accepts and refuses re-declared types as expected.
 */
import { createRegistry, type Type } from '@aeye/gin';
import { describe, expect, it } from 'vitest';
import { checkGinValue, ginBundle } from '@harness/core';
import { LENIENT, OPENAI_STRICT } from '@aeye/schema';
import { encodeValue, g, json, parseValue, partialOf, referencesOf, wireType } from './gin.ts';
import { system } from './system.ts';
import { type } from './declare.ts';

/** A builder's type, and a value of it when it has plain values (fn, typ and iface values are code and types). */
const samples: Array<{ name: string; type: Type; value?: unknown }> = [
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
  { name: 'map', type: g.map(g.text(), g.num()), value: [{ key: 'a', value: 1 }] },
  { name: 'and', type: g.and([g.obj({ a: g.text() }), g.obj({ b: g.num() })]), value: { a: 'x', b: 1 } },
  { name: 'not', type: g.not(g.null()), value: 'x' },
  { name: 'date', type: g.date(), value: '2026-11-07' },
  { name: 'timestamp', type: g.timestamp(), value: '2026-11-07T09:30:00.000Z' },
  { name: 'color', type: g.color(), value: 0xff0000ff },
  { name: 'field default', type: g.obj({ mode: g.field(g.text(), { default: { kind: 'new', type: { name: 'text' }, value: 'fast' } }) }), value: { mode: 'slow' } },
  { name: 'fn with a generic', type: g.fn({ args: g.obj({ x: g.alias('T') }), returns: g.alias('T'), generic: { T: g.any() } }) },
  { name: 'typ', type: g.typ(g.text()) },
  { name: 'iface', type: g.iface({ props: { name: g.text() } }) },
];

describe('gin types as the SDK uses them', () => {
  for (const sample of samples) {
    it(`${sample.name}: round-trips through its JSON definition and stays compatible with itself`, () => {
      const def = wireType(sample.type);
      const fresh = createRegistry().parse(JSON.parse(JSON.stringify(def)));
      expect(fresh.toJSON()).toEqual(def);
      expect(fresh.compatible(sample.type)).toBe(true);
      expect(sample.type.compatible(fresh)).toBe(true);
      if (sample.value !== undefined) { expect(parseValue(fresh, sample.value)).toEqual(parseValue(sample.type, sample.value)); }
    });

    it(`${sample.name}: makes a value schema that renders for a strict model and accepts the value`, () => {
      const bound = ginBundle(sample.type, { includeDocs: 'all' }).bind(sample.type.registry);
      if (sample.value !== undefined) { expect(checkGinValue(sample.type, encodeValue(sample.type, parseValue(sample.type, sample.value))).ok).toBe(true); }
      expect(() => bound.render(OPENAI_STRICT).jsonSchema).not.toThrow();
    });
  }

  it('writes field docs into the tool schema only when asked for all docs', () => {
    const documented = g.obj({ path: g.field(g.text(), { docs: 'Where the file is.' }) });
    expect(ginBundle(documented, { includeDocs: 'all' }).bind(documented.registry).render(LENIENT).jsonSchema).toMatchObject({ properties: { path: { description: 'Where the file is.' } } });
  });

  it('fills a field default and round-trips dates and timestamps as Date', () => {
    const withDefault = g.obj({ mode: g.field(g.text(), { default: { kind: 'new', type: { name: 'text' }, value: 'fast' } }) });
    expect(createRegistry().parse(wireType(withDefault)).toJSON()).toEqual(wireType(withDefault));
    const dated = g.obj({ on: g.date(), at: g.timestamp() });
    const value = parseValue(dated, { on: '2026-11-07', at: '2026-11-07T09:30:00.000Z' });
    expect(value.on).toBeInstanceOf(Date);
    expect(value.at).toBeInstanceOf(Date);
    const fresh = createRegistry().parse(wireType(dated));
    expect(encodeValue(dated, parseValue(fresh, encodeValue(dated, value)))).toEqual({ on: '2026-11-07', at: '2026-11-07T09:30:00.000Z' });
  });

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
    // inside or, optional, nullable and map too
    expect(referencesOf(g.or([g.text(), shop.types.Product]))).toEqual(['shop/Product']);
    expect(referencesOf(g.obj({ p: g.optional(shop.types.Product), q: g.nullable(shop.types.Product) }))).toEqual(['shop/Product']);
    expect(referencesOf(g.map(g.text(), shop.types.Product))).toEqual(['shop/Product']);
  });

  it('follows references across systems to every type a receiver must load, in an order it can bind them', () => {
    const vendor = system('vendor', { description: 'v' }).with({
      types: { Price: type({ description: 'P', shape: g.obj({ amount: g.num(), currency: g.text() }), display: { label: 'Price', title: 'currency' } }) },
    });
    const store = system('store', { description: 's' }).with({
      types: { Item: type({ description: 'I', shape: g.obj({ sku: g.text(), price: vendor.types.Price }), display: { label: 'Item', title: 'sku' } }) },
    });
    const cart = g.obj({ items: g.list(store.types.Item), total: g.optional(vendor.types.Price) });
    // a type names only what it uses directly; its closure is everything, dependencies first
    expect([...referencesOf(cart)].sort()).toEqual(['store/Item', 'vendor/Price']);
    expect(referencesOf(store.types.Item)).toEqual(['vendor/Price']);
    const closure = cart.closure();
    expect(closure.order).toEqual(['vendor/Price', 'store/Item']);
    expect(closure.missing).toEqual([]);
    expect([...closure.defs.keys()].sort()).toEqual(['store/Item', 'vendor/Price']);

    // a receiver with only the closure's definitions, bound in order, can parse the type and its values
    const receiver = createRegistry();
    for (const name of closure.order) {
      const def = closure.defs.get(name);
      if (def !== undefined) { receiver.register(receiver.parse(def)); }
    }
    const parsed = receiver.parse(JSON.parse(JSON.stringify(cart.toDefinitionJSON())));
    // the bound definitions are really used: a price that is not a Price is refused
    expect(() => { parseValue(parsed, { items: [{ sku: 'a', price: 1 }] }); }).toThrow();
    const value = { items: [{ sku: 'a', price: { amount: 1, currency: 'EUR' } }] };
    expect(parseValue(parsed, value)).toEqual(parseValue(cart, value));
  });
});

describe('partialOf', () => {
  it('makes every field optional, keeping its docs, and leaves optional ones as they are', () => {
    const optional = g.optional(g.bool());
    const fields = partialOf({ a: g.text(), b: g.field(g.num(), { docs: 'A count.' }), c: optional });
    expect(fields.c).toBe(optional);
    const def = wireType(g.obj(fields));
    expect(def.props?.['a']?.type.name).toBe('optional');
    expect(def.props?.['b']).toMatchObject({ type: { name: 'optional', generic: { T: { name: 'num' } } }, docs: 'A count.' });
    expect(parseValue(g.obj(fields), {})).toEqual({});
  });
});
