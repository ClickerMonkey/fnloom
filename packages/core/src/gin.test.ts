import { endpoint, implement, jsonSchema, server, spec } from '@ayepi/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GinExprDef, GinObjTypeDef, GinTypeDef } from './gin.ts';

/** Every local `$ref` in a document that points nowhere in it, or at the whole document (`#`). */
function danglingRefs(doc: unknown): string[] {
  const dangling: string[] = [];
  const resolves = (ref: string): boolean => {
    let at: unknown = doc;
    for (const key of ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (typeof at !== 'object' || at === null || !(key in at)) return false;
      at = Reflect.get(at, key);
    }
    return true;
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object' || node === null) return;
    const ref = '$ref' in node ? node.$ref : undefined;
    if (ref === '#') dangling.push(ref); // a nested self-reference means the outer document, not the gin schema
    if (typeof ref === 'string' && ref.startsWith('#/') && !resolves(ref)) dangling.push(ref);
    Object.values(node).forEach(walk);
  };
  walk(doc);
  return dangling;
}

/** The part of an OpenAPI document these tests read. */
const Components = z.object({ components: z.object({ schemas: z.record(z.string(), z.unknown()).optional() }).optional() });

describe('gin wire schemas in the API documents', () => {
  it('document gin\'s own JSON Schema, not an open {}', () => {
    for (const schema of [GinTypeDef, GinObjTypeDef, GinExprDef]) {
      const json = jsonSchema(schema.describe('A gin value.'));
      expect(json['description']).toBe('A gin value.');
      expect(Object.keys(json).length).toBeGreaterThan(2);
      expect(danglingRefs(json)).toEqual([]);
    }
    expect(JSON.stringify(jsonSchema(GinObjTypeDef))).toContain('"const":"obj"');
  });

  it('merge into shared components across endpoints, every ref resolving', () => {
    const api = spec({
      endpoints: {
        put: endpoint({ method: 'POST', body: z.object({ type: GinTypeDef, check: GinExprDef.optional() }), response: z.object({ type: GinTypeDef }) }),
        get: endpoint({ response: z.object({ type: GinTypeDef, row: GinObjTypeDef }) }),
      },
    });
    const app = server(api, [implement(api).handlers({ put: () => ({ type: { name: 'num' } }), get: () => ({ type: { name: 'num' }, row: { name: 'obj' } }) })]);
    const doc = app.openapi();
    expect(danglingRefs(doc)).toEqual([]);
    const once = Object.keys(Components.parse(doc).components?.schemas ?? {}).length;
    expect(once).toBeGreaterThan(0);
    const twice = spec({ endpoints: { ...api.endpoints, more: endpoint({ response: z.object({ again: GinTypeDef }) }) } });
    const app2 = server(twice, [implement(twice).handlers({ put: () => ({ type: { name: 'num' } }), get: () => ({ type: { name: 'num' }, row: { name: 'obj' } }), more: () => ({ again: { name: 'num' } }) })]);
    expect(Object.keys(Components.parse(app2.openapi()).components?.schemas ?? {}).length).toBe(once); // a third use adds no copies
  });
});
