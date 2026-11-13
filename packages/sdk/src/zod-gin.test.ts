import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseValue } from './gin.ts';
import { ApiServiceConfig, ClaudeInstanceConfig, McpServerConfig } from '@harness/core';
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

  it('flattens a union of objects into plain args, and reads them back through the schema', () => {
    const Either = z.discriminatedUnion('kind', [z.object({ kind: z.literal('a'), a: z.string() }), z.object({ kind: z.literal('b'), b: z.number(), note: z.string().optional() })]);
    const tool = toolArgsOf(Either);
    expect(parseValue(tool.args, { kind: 'b', b: 2 })).toEqual({ kind: 'b', b: 2 });
    expect(() => parseValue(tool.args, { b: 2 })).toThrow();
    expect(tool.read({ kind: 'b', b: 2 })).toEqual({ kind: 'b', b: 2 });
    expect(() => tool.read({ kind: 'a', b: 2 })).toThrow();
  });

  it('takes any other non-object schema as the args field input', () => {
    const tool = toolArgsOf(z.array(z.string()));
    expect(tool.read({ input: ['x'] })).toEqual(['x']);
    expect(() => tool.read(['x'])).toThrow();
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

describe('the build 9 instance configs read into gin', () => {
  const cases: ReadonlyArray<{ name: string; schema: z.ZodType; value: unknown; bad: unknown }> = [
    {
      name: 'an MCP server over stdio with env secrets',
      schema: McpServerConfig,
      value: { label: 'Files', transport: { type: 'stdio', command: 'npx', args: ['-y', 'server'], env: { API_KEY: 'k' } } },
      bad: { label: 'Files', transport: { type: 'pipe' } },
    },
    {
      name: 'an MCP server over HTTP with per-person OAuth',
      schema: McpServerConfig,
      value: { label: 'Linear', transport: { type: 'http', url: 'https://mcp.linear.app/mcp' }, auth: { kind: 'oauth', per: 'person', scopes: ['read'] }, approval: 'always' },
      bad: { label: 'Linear', transport: { type: 'sse', url: 'https://x.test/sse' }, auth: { kind: 'oauth', per: 'everyone' } },
    },
    {
      name: 'an API service with shared headers',
      schema: ApiServiceConfig,
      value: { label: 'Weather', baseUrl: 'https://api.weather.test/v1', auth: { kind: 'headers', per: 'shared', names: ['X-Key'], values: { 'X-Key': 's' } }, headers: { Accept: 'application/json' } },
      bad: { label: '', baseUrl: 'https://api.weather.test/v1' },
    },
    {
      name: 'a Claude machine',
      schema: ClaudeInstanceConfig,
      value: { folders: [{ path: 'C:/work', label: 'Work' }], permissionMode: 'acceptEdits', maxLive: 4, hubMcp: { url: 'http://127.0.0.1:4320/mcp', secret: 's' } },
      bad: { folders: [{ path: 'C:/work' }], maxLive: 0 },
    },
  ];

  it.each(cases)('$name: gin takes what zod takes, and zod reads the gin value', ({ schema, value, bad }) => {
    const type = ginOf(schema);
    expect(schema.parse(parseValue(type, value))).toEqual(schema.parse(value));
    expect(() => parseValue(type, bad)).toThrow();
  });
});
