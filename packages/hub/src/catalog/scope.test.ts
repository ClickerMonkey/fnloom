import { GinTypeDef } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { GinScopes } from './scope.ts';

describe('GinScopes', () => {
  const product = GinTypeDef.parse({ name: 'shop/Product', extends: 'obj', props: { sku: { type: { name: 'text' } } } });
  const order = GinTypeDef.parse({ name: 'list', generic: { V: { name: 'shop/Product' } } });
  const lookup = (name: string): GinTypeDef | undefined => (name === 'shop/Product' ? product : undefined);

  it('parses a definition naming another type, by its qualified name, once that type is bound', () => {
    const scopes = new GinScopes();
    const { type, missing } = scopes.one(order, lookup);
    expect(missing).toEqual([]);
    expect(type.parse([{ sku: 'a1' }]).toLogical()).toEqual([{ sku: 'a1' }]);
    expect(() => type.parse([{ sku: 1 }])).toThrow();
  });

  it('reports the qualified names a definition needs, mentions and depends on', () => {
    const scopes = new GinScopes();
    expect(scopes.problems([order], () => undefined)).toEqual(['refers to the unknown type shop/Product']);
    expect(scopes.problems([order], lookup)).toEqual([]);
    expect(scopes.references(order)).toEqual(['shop/Product']);
    expect(scopes.mentions(GinTypeDef.parse({ name: 'obj', props: { p: { type: product } } }))).toEqual(['shop/Product']);
    expect(scopes.closure(['shop/Product'], lookup)).toEqual({ order: ['shop/Product'], missing: [] });
    expect(scopes.closure(['shop/Missing'], lookup)).toEqual({ order: [], missing: ['shop/Missing'] });
  });

  it('refuses a definition gin cannot parse, naming the problem', () => {
    const scopes = new GinScopes();
    expect(scopes.problems([GinTypeDef.parse({ name: 'shop Product', extends: 'obj', props: {} })], lookup)).toEqual([expect.stringMatching(/type 'name' must match/)]);
  });
});
