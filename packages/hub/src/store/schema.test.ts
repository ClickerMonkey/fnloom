import { Actor, HUB_TABLES, Json, QualifiedName, Run, Timestamp } from '@harness/core';
import { expectType, type Equal } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RowCodec, decodeCell, encodeCell } from './codec.ts';
import { StoreError } from './errors.ts';
import {
  type ScalarKey, KEY_COLUMN, TABLE_DEFS, TABLE_INDEXES, TABLE_NAMES, columnKind, indexName, isTableName, layoutOf, tableIndexes, tableLayout,
} from './schema.ts';

describe('columnKind', () => {
  it.each([
    ['string', z.string(), 'text'],
    ['url', z.url(), 'text'],
    ['email', z.email(), 'text'],
    ['branded id', z.string().brand<'X'>(), 'text'],
    ['template literal', QualifiedName, 'text'],
    ['string enum', z.enum(['a', 'b']), 'text'],
    ['string literal', z.literal('a'), 'text'],
    ['whole number', Timestamp, 'integer'],
    ['int32', z.int32(), 'integer'],
    ['number', z.number(), 'real'],
    ['number literal', z.literal(1.5), 'real'],
    ['whole literal', z.literal(3), 'integer'],
    ['ints and reals', z.union([z.literal(1), z.number()]), 'real'],
    ['boolean', z.boolean(), 'bool'],
    ['boolean literal', z.literal(true), 'bool'],
    ['optional string', z.string().optional(), 'text'],
    ['defaulted number', z.number().int().default(1), 'integer'],
    ['readonly bool', z.boolean().readonly(), 'bool'],
    ['union of strings', z.union([z.literal('a'), z.string()]), 'text'],
    ['nullable string', z.string().nullable(), 'json'],
    ['mixed union', z.union([z.string(), z.number()]), 'json'],
    ['mixed literals', z.literal(['a', 1]), 'json'],
    ['object', z.object({ a: z.string() }), 'json'],
    ['array', z.array(z.string()), 'json'],
    ['json', Json, 'json'],
    ['record', z.record(z.string(), z.string()), 'json'],
  ] as const)('stores %s as %s', (_name, schema, kind) => {
    expect(columnKind(schema)).toBe(kind);
  });
});

describe('layoutOf', () => {
  it('takes the union of a union row’s fields', () => {
    const layout = layoutOf('actors', Actor);
    expect(Object.fromEntries(layout)).toEqual({
      id: 'text', name: 'text', about: 'text', createdAt: 'integer', disabled: 'bool', kind: 'text', email: 'text', role: 'text', timeZone: 'text',
      fn: 'text', system: 'text', mcp: 'text',
    });
  });

  it('stores objects and arrays as JSON', () => {
    const layout = layoutOf('runs', Run);
    expect(layout.get('args')).toBe('json');
    expect(layout.get('errors')).toBe('json');
    expect(layout.get('status')).toBe('text');
    expect(layout.get('cost')).toBe('real');
    expect(layout.get('attempt')).toBe('integer');
    expect(layout.get('background')).toBe('bool');
  });

  it('refuses a row that is not an object, or uses the key column', () => {
    expect(() => layoutOf('x', z.string())).toThrow(StoreError);
    expect(() => layoutOf('x', z.object({ [KEY_COLUMN]: z.string() }))).toThrow(/reserved/);
  });

  it('derives a layout for every hub table', () => {
    expect(TABLE_NAMES).toEqual(Object.keys(HUB_TABLES));
    for (const name of TABLE_NAMES) expect(tableLayout(name).size).toBeGreaterThan(0);
    expect(isTableName('runs')).toBe(true);
    expect(isTableName('nope')).toBe(false);
    expect(isTableName('toString')).toBe(false);
  });

  it('indexes only scalar columns', () => {
    for (const name of TABLE_NAMES) {
      for (const columns of tableIndexes(name)) {
        for (const column of columns) expect(tableLayout(name).get(column), `${name}.${column}`).not.toBe('json');
      }
    }
    expect(tableIndexes('secrets')).toEqual([]);
    expect(TABLE_INDEXES.messages).toContainEqual(['session', 'createdAt']);
    expect(indexName('messages', ['session', 'createdAt'])).toBe('ix_messages__session__createdAt');
  });

  it('finds scalar keys at the type level', () => {
    expectType<Equal<ScalarKey<{ a: string; b?: number; c: boolean | undefined; d: string[]; e: { x: 1 }; f: Json }>, 'a' | 'b' | 'c'>>(true);
    // null and mixed unions are stored as JSON, as columnKind says
    expectType<Equal<ScalarKey<{ a: string | null; b: string | number; c?: 'x' | 'y'; d: 1 | 2.5; e: true }>, 'c' | 'd' | 'e'>>(true);
    expectType<Equal<ScalarKey<z.infer<typeof Actor>>, 'id' | 'name' | 'about' | 'createdAt' | 'disabled' | 'kind'>>(true);
  });
});

describe('codec', () => {
  const codec = new RowCodec('actors', TABLE_DEFS.actors, tableLayout('actors'));

  it('round-trips a row through cells', () => {
    const row = { id: 'act_1', kind: 'user', name: 'A', about: '', createdAt: 1, disabled: true, email: 'a@b.c', role: 'admin' } as const;
    const { cells, key } = codec.encode(row);
    expect(key).toBe('act_1');
    expect(cells).toMatchObject({ [KEY_COLUMN]: 'act_1', disabled: 1, timeZone: null, fn: null });
    expect(codec.decode(cells)).toEqual(row);
  });

  it('refuses stored cells the schema refuses', () => {
    expect(() => codec.decode({ id: 'act_1', kind: 'robot' })).toThrow(StoreError);
  });

  it('encodes and decodes each kind of cell', () => {
    expect(encodeCell('json', { a: [1] }, 'x')).toBe('{"a":[1]}');
    expect(encodeCell('bool', false, 'x')).toBe(0);
    expect(encodeCell('integer', 3, 'x')).toBe(3);
    expect(encodeCell('text', undefined, 'x')).toBeNull();
    expect(() => encodeCell('text', 3, 'x')).toThrow(/text column/);
    expect(() => encodeCell('bool', 'yes', 'x', 'bad-query')).toThrow(expect.objectContaining({ code: 'bad-query' }));
    expect(decodeCell('json', '[1,2]')).toEqual([1, 2]);
    expect(decodeCell('bool', 1)).toBe(true);
    expect(decodeCell('bool', 0n)).toBe(false);
    expect(decodeCell('integer', 5n)).toBe(5);
    expect(decodeCell('text', 7)).toBe('7');
    expect(decodeCell('real', null)).toBeUndefined();
    expect(decodeCell('json', 3)).toBeUndefined();
  });
});
