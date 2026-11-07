import { GinTypeDef } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { fromGin, ginName, hubName, toGin } from './names.ts';
import { GinScopes } from './scope.ts';

describe('qualified names inside gin', () => {
  it('escapes what gin refuses and reads it back', () => {
    expect(ginName('fs/Entry')).toBe('fs_x2f_Entry');
    expect(ginName('my-sys/Thing')).toBe('my_x2d_sys_x2f_Thing');
    expect(ginName('text')).toBe('text');
    expect(hubName(ginName('my-sys/Thing.method'))).toBe('my-sys/Thing.method');
  });

  it('renames type names only, never field names or docs', () => {
    const def = GinTypeDef.parse({
      name: 'obj',
      props: { name: { type: { name: 'fs/Entry' }, docs: 'see fs/Entry' }, extends: { type: { name: 'shop/Product', extends: 'obj', satisfies: ['a/B'], props: {} } } },
    });
    const gin = toGin(def);
    expect(gin).toEqual({
      name: 'obj',
      props: { name: { type: { name: 'fs_x2f_Entry' }, docs: 'see fs/Entry' }, extends: { type: { name: 'shop_x2f_Product', extends: 'obj', satisfies: ['a_x2f_B'], props: {} } } },
    });
    expect(fromGin(gin)).toEqual(def);
  });

  it('parses a definition naming another type once that type is bound', () => {
    const scopes = new GinScopes();
    const product = GinTypeDef.parse({ name: 'obj', props: { sku: { type: { name: 'text' } } } });
    const order = GinTypeDef.parse({ name: 'list', generic: { V: { name: 'shop/Product' } } });
    const { type, missing } = scopes.one(order, (name) => (name === 'shop/Product' ? product : undefined));
    expect(missing).toEqual([]);
    expect(() => type.parse([{ sku: 1 }])).toThrow();
    expect(scopes.problems([order], () => undefined)).toEqual(['refers to the unknown type shop/Product']);
    expect(scopes.references(order)).toEqual(['shop/Product']);
    expect(scopes.closure(['shop/Product'], (name) => (name === 'shop/Product' ? product : undefined))).toEqual({ order: ['shop/Product'], missing: [] });
  });
});
