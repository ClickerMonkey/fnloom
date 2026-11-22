/** The one LLM wire mapping, in both of its modes, and each direction's round trip. */
import type { Request } from '@aeye/core';
import { LlmRequest } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  applyDescriptors, ChunkReader, ChunkWriter, chunkFromWire, chunkToWire, descriptorsOf, LlmWire, messageFromWire, requestFromWire, UNSENDABLE_CONTENT, usageFromWire, usageToWire,
} from './llm-wire.ts';
import { LinkGap } from './wire.ts';

const refuse = new LlmWire({ unrepresentable: 'refuse' });
const placeholder = new LlmWire({ unrepresentable: 'placeholder' });

/** A message whose only part is a `Blob`, which the wire can't carry without reading it. */
const blobMessage: Request['messages'][number] = { role: 'user', content: [{ type: 'file', content: new Blob(['x']) }] };

describe('LlmWire', () => {
  it('writes in-memory bytes as data URLs with a MIME type from the format, in both modes', () => {
    const bytes = new Uint8Array([1, 2]);
    for (const wire of [refuse, placeholder]) {
      const parts = wire.message({
        role: 'user',
        content: [
          { type: 'image', content: bytes, format: 'png' },
          { type: 'file', content: bytes.buffer, format: 'application/pdf' },
          { type: 'file', content: new DataView(bytes.buffer) },
          { type: 'image', content: new URL('https://x.test/a.png') },
        ],
      }).content;
      expect(parts).toEqual([
        { type: 'image', content: 'data:image/png;base64,AQI=', format: 'png' },
        { type: 'file', content: 'data:application/pdf;base64,AQI=', format: 'application/pdf' },
        { type: 'file', content: 'data:application/octet-stream;base64,AQI=' },
        { type: 'image', content: 'https://x.test/a.png' },
      ]);
    }
  });

  it('refuses what the wire cannot carry when forwarding, and keeps a placeholder when recording', () => {
    expect(() => refuse.message(blobMessage)).toThrow(LinkGap);
    expect(placeholder.message(blobMessage).content).toEqual([{ type: 'file', content: UNSENDABLE_CONTENT }]);

    const bigint: Request = { messages: [], tools: [{ name: 't', parameters: z.object({ a: z.bigint() }) }] };
    expect(() => refuse.request(bigint)).toThrow();
    expect(placeholder.request(bigint).tools?.[0]?.parameters).toMatchObject({ type: 'object', properties: { a: {} } });
  });

  it('keeps strict policies as they are, leaves out an empty tool list, and narrows an allowed-tools choice', () => {
    const wire = refuse.request({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolChoice: { allowed: ['a'] },
      responseFormat: { type: z.object({ answer: z.string() }), strict: 2 },
      stop: 'END',
    });
    expect(LlmRequest.parse(wire)).toEqual(wire);
    expect(wire).not.toHaveProperty('tools');
    expect(wire.toolChoice).toBe('auto');
    expect(wire.stop).toEqual(['END']);
    expect(wire.responseFormat).toMatchObject({ strict: 2 });
  });

  it('round-trips a request: tool and output schemas back to zod, strict policies and choices intact', () => {
    const request: Request = {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'find', arguments: '{"q":"a"}' }] },
        { role: 'tool', content: 'found', toolCallId: 'c1', name: 'find' },
      ],
      tools: [{ name: 'find', description: 'Find.', parameters: z.object({ q: z.string() }), strict: 3 }],
      toolChoice: { tool: 'find' },
      responseFormat: { type: z.object({ answer: z.string() }), strict: true },
      temperature: 0.5,
      maxTokens: 100,
    };
    const wire = refuse.request(request);
    const rebuilt = requestFromWire(wire);
    // zod writes a rebuilt object schema with an explicit additionalProperties, so the schemas match rather than equal
    expect(refuse.request(rebuilt)).toMatchObject({ ...wire, tools: [{ ...wire.tools?.[0], parameters: { type: 'object', properties: { q: { type: 'string' } } } }] });
    expect(rebuilt.tools?.[0]?.parameters.parse({ q: 'x' })).toEqual({ q: 'x' });
    expect(rebuilt.tools?.[0]?.strict).toBe(3);
    expect(wire.messages.map(messageFromWire).map((m) => refuse.message(m))).toEqual(wire.messages);
  });

  it('refuses a rebuilt tool or output schema that does not describe an object', () => {
    expect(() => requestFromWire({ messages: [], tools: [{ name: 't', parameters: { type: 'string' } }] })).toThrow(/object/);
    expect(() => requestFromWire({ messages: [], responseFormat: { schema: { type: 'number' }, strict: false } })).toThrow(/object/);
  });
});

describe('descriptors, usage and chunks', () => {
  it('carries the descriptors the provider chose back into the request a prompt holds', () => {
    const built: Request = {
      messages: [],
      tools: [{ name: 'a', parameters: z.object({}), descriptor: 'openai' }, { name: 'b', parameters: z.object({}) }],
      responseFormat: { type: z.object({}), strict: true, descriptor: 'openai' },
    };
    const descriptors = descriptorsOf(built);
    expect(descriptors).toEqual({ tools: { a: 'openai' }, output: 'openai' });
    const local: Request = { messages: [], tools: [{ name: 'a', parameters: z.object({}) }, { name: 'b', parameters: z.object({}) }], responseFormat: { type: z.object({}), strict: true } };
    applyDescriptors(local, descriptors);
    expect(descriptorsOf(local)).toEqual(descriptors);
    expect(descriptorsOf({ messages: [], responseFormat: 'json' })).toEqual({ tools: {} });
  });

  it('meters usage one way and gives it back with the real cost the other', () => {
    const wire = usageToWire({ text: { input: 10, output: 5, cached: 2 }, reasoning: { output: 3 } });
    expect(wire).toEqual({ input: 10, output: 5, cached: 2, reasoning: 3 });
    expect(usageFromWire(wire, 0.01)).toEqual({ text: { input: 10, output: 5, cached: 2 }, reasoning: { output: 3 }, cost: 0.01 });
    expect(usageFromWire({ input: 1, output: 1 })).toEqual({ text: { input: 1, output: 1 } });
    expect(usageToWire(undefined)).toEqual({ input: 0, output: 0 });
  });

  it('round-trips a chunk', () => {
    const chunk = {
      content: 'a', reasoning: 'r', toolCallNamed: { id: 't', name: 'n', arguments: '' }, toolCallArguments: { id: 't', name: 'n', arguments: '{' },
      toolCall: { id: 't', name: 'n', arguments: '{}' }, finishReason: 'tool_calls' as const, refusal: 'no', usage: { input: 1, output: 2 },
    };
    expect(chunkToWire(chunkFromWire(chunk))).toEqual(chunk);
  });

  it('streams a tool call’s growing arguments as what is new, and reads them back whole on one call object', () => {
    const call = { id: 't', name: 'set', arguments: '{"a"' };
    const writer = new ChunkWriter();
    const wire = [writer.write({ toolCallNamed: call })];
    call.arguments += ':1';
    wire.push(writer.write({ toolCallArguments: call }));
    call.arguments += '}';
    wire.push(writer.write({ toolCallArguments: call }));
    wire.push(writer.write({ toolCall: call, finishReason: 'tool_calls' }));
    expect(wire).toEqual([
      { toolCallNamed: { id: 't', name: 'set', arguments: '{"a"' } },
      { toolCallMore: { id: 't', name: 'set', arguments: ':1' } },
      { toolCallMore: { id: 't', name: 'set', arguments: '}' } },
      { toolCall: { id: 't', name: 'set', arguments: '{"a":1}' }, finishReason: 'tool_calls' },
    ]);
    const reader = new ChunkReader();
    const read = wire.map((chunk) => reader.read(chunk));
    expect(read[2]?.toolCallArguments?.arguments).toBe('{"a":1}');
    // one object per call, as aeye's providers give it, so kept chunks share its arguments
    expect(read[1]?.toolCallArguments).toBe(read[0]?.toolCallNamed);
    expect(read[3]?.toolCall?.arguments).toBe('{"a":1}');
  });

  it('sends arguments whole when they don’t extend what went out, and reads a whole one as it is', () => {
    const writer = new ChunkWriter();
    writer.write({ toolCallNamed: { id: 't', name: 'n', arguments: '{"long"' } });
    expect(writer.write({ toolCallArguments: { id: 't', name: 'n', arguments: '{' } })).toEqual({ toolCallArguments: { id: 't', name: 'n', arguments: '{' } });
    expect(writer.write({ toolCallArguments: { id: 'u', name: 'm', arguments: '{}' } })).toEqual({ toolCallArguments: { id: 'u', name: 'm', arguments: '{}' } });
    const reader = new ChunkReader();
    reader.read({ toolCallNamed: { id: 't', name: 'n', arguments: '{"x"' } });
    expect(reader.read({ toolCallArguments: { id: 't', name: 'n', arguments: '{"y"' } }).toolCallArguments?.arguments).toBe('{"y"');
  });
});

describe('tool schemas that cross the wire', () => {
  it('keep their records as records, so OpenAI strict mode is sent pairs (gin type defs)', async () => {
    const { buildSchemas, createRegistry } = await import('@aeye/gin');
    const { OPENAI_STRICT, strictify, toJSONSchema } = await import('@aeye/core');
    const { Type } = buildSchemas(createRegistry());
    const parameters = z.toJSONSchema(z.object({ args: Type }), { io: 'input', unrepresentable: 'any' });
    const request = requestFromWire(LlmRequest.parse({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'signature', parameters }] }));
    const tool = request.tools?.[0];
    if (tool === undefined) { throw new Error('no tool'); }
    const sent = JSON.stringify(toJSONSchema(strictify(tool.parameters, OPENAI_STRICT), OPENAI_STRICT));
    expect(sent).not.toContain('propertyNames');
    expect(sent).toContain('"key"');
  });
});

// iteration 1, rep 3: every forwarded authoring step rebuilt its 50 KB gin program schema from JSON (10 to 20 ms) and
// the hub converted it back to JSON schema to save the interaction (110 ms), on the event loop, until it shed load
describe('schemas made once', () => {
  const big = z.object({ draft: z.object({ name: z.string(), steps: z.array(z.union([z.object({ kind: z.literal('a'), n: z.number() }), z.object({ kind: z.literal('b'), s: z.string() })])) }) });
  const json = refuse.jsonSchema(big);

  it('rebuilds the same JSON schema from the wire into the same zod schema, and a changed one anew', () => {
    const wire = (parameters: typeof json): LlmRequest => ({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'set', parameters }] });
    const first = requestFromWire(wire(json)).tools?.[0]?.parameters;
    const again = requestFromWire(wire(structuredClone(json))).tools?.[0]?.parameters;
    expect(again).toBe(first);
    const other = requestFromWire(wire(refuse.jsonSchema(z.object({ other: z.string() })))).tools?.[0]?.parameters;
    expect(other).not.toBe(first);
    expect(other?.safeParse({ other: 'x' }).success).toBe(true);
  });

  it('converts a zod schema to JSON schema once per schema', () => {
    const wire = new LlmWire({ unrepresentable: 'placeholder' });
    const request: Request = { messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'set', parameters: big }] };
    const once = wire.request(request).tools?.[0]?.parameters;
    expect(wire.request(request).tools?.[0]?.parameters).toBe(once);
    expect(once).toEqual(json);
  });
});
