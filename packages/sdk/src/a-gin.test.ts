/**
 * `ginOfA` reads an `@aeye/schema` schema (an MCP tool's JSON Schema, read with `a.fromJSONSchema`) as the gin type a
 * fn declares: the same rules as `ginOf` for zod, refs followed, recursion and what gin can't say as any JSON.
 */
import { a } from '@aeye/schema';
import { describe, expect, it } from 'vitest';
import { ginOfA } from './a-gin.ts';
import { parseValue, wireType } from './gin.ts';

describe('gin types read off @aeye/schema schemas', () => {
  it('maps objects with docs, texts, numbers, enums, lists, unions, optional and nullable', () => {
    const type = ginOfA(a.object({
      path: a.string().min(1).describe('Where the file is.'),
      count: a.int().min(0).max(9).optional(),
      mode: a.enum(['read', 'write']),
      tags: a.array(a.string()),
      either: a.union([a.number(), a.boolean()]),
      note: a.nullable(a.string()),
      kind: a.literal('file'),
    }));
    expect(wireType(type)).toMatchObject({
      name: 'obj',
      props: {
        path: { docs: 'Where the file is.', type: { name: 'text', options: { minLength: 1 } } },
        count: { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true, min: 0, max: 9 } } } } },
        mode: { type: { name: 'enum' } },
        tags: { type: { name: 'list', generic: { V: { name: 'text' } } } },
        either: { type: { name: 'or' } },
        note: { type: { name: 'nullable' } },
        kind: { type: { name: 'literal' } },
      },
    });
    expect(parseValue(type, { path: 'a.txt', mode: 'read', tags: [], either: 2, note: null, kind: 'file' })).toMatchObject({ path: 'a.txt' });
  });

  it('reads an imported JSON Schema: records, a closed-key record, refs, and recursion as any JSON', () => {
    const read = a.fromJSONSchema({
      type: 'object',
      properties: {
        scores: { type: 'object', additionalProperties: { type: 'number' } },
        owner: { $ref: '#/$defs/Person' },
        tree: { $ref: '#/$defs/Node' },
      },
      required: ['owner'],
      $defs: {
        Person: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        Node: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/$defs/Node' } } } },
      },
    });
    const def = wireType(ginOfA(read.root, read.defs));
    expect(def).toMatchObject({
      name: 'obj',
      props: {
        scores: { type: { name: 'optional', generic: { T: { name: 'record', generic: { V: { name: 'num' } } } } } },
        owner: { type: { name: 'obj', props: { name: { type: { name: 'text' } } } } },
        tree: { type: { name: 'optional', generic: { T: { name: 'obj', props: { kids: { type: { name: 'optional', generic: { T: { name: 'list' } } } } } } } } },
      },
    });
    // the ref back into Node is any JSON: a gin type here has no name to recur by
    expect(JSON.stringify(def)).not.toContain('Node');
    expect(wireType(ginOfA(a.record(a.enum(['x', 'y']), a.number())))).toMatchObject({ name: 'obj', props: { x: { type: { name: 'optional' } }, y: { type: { name: 'optional' } } } });
  });
});
