/** The one LLM wire mapping, in both of its modes, each direction's round trip, and the hub-side decoding of answers. */
import { a, LENIENT, planRequest, prepareRequest, type Chunk, type Request, type ToolDefinition } from '@aeye/core';
import { LlmRequest } from '@harness/core';
import { describe, expect, it } from 'vitest';
import {
  AnswerDecoder, ChunkReader, ChunkWriter, chunkFromWire, chunkToWire, isObjectSchema, lenientJson, LlmWire, messageFromWire, requestFromWire, schemaFromWire, UNSENDABLE_CONTENT,
  usageFromWire, usageToWire,
} from './llm-wire.ts';
import { LinkGap } from './wire.ts';

const refuse = new LlmWire({ unrepresentable: 'refuse' });
const placeholder = new LlmWire({ unrepresentable: 'placeholder' });

/** A message whose only part is a `Blob`, which the wire can't carry without reading it. */
const blobMessage: Request['messages'][number] = { role: 'user', content: [{ type: 'file', content: new Blob(['x']) }] };

/** A model with OpenAI's strict dialect for tools and structured output. */
const OPENAI = { id: 'gpt-4o', provider: 'openai', capabilities: ['tools', 'toolsStrict', 'structured', 'json'] };

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
  });

  it('keeps strict policies as they are, leaves out an empty tool list, and narrows an allowed-tools choice', () => {
    const wire = refuse.request({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolChoice: { allowed: ['a'] },
      responseFormat: { type: a.object({ answer: a.string() }).bind(), strict: 2 },
      stop: 'END',
    });
    expect(LlmRequest.parse(wire)).toEqual(wire);
    expect(wire).not.toHaveProperty('tools');
    expect(wire.toolChoice).toBe('auto');
    expect(wire.stop).toEqual(['END']);
    expect(wire.responseFormat).toMatchObject({ strict: 2 });
  });

  it('round-trips a request: schemas back to bound schemas, strict policies, error formats and choices intact', () => {
    const request: Request = {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'find', arguments: '{"q":"a"}' }] },
        { role: 'tool', content: 'found', toolCallId: 'c1', name: 'find' },
      ],
      tools: [{ name: 'find', description: 'Find.', parameters: a.object({ q: a.string(), near: a.string().optional() }).bind(), strict: 3, errorFormat: 'summary' }],
      toolChoice: { tool: 'find' },
      responseFormat: { type: a.object({ answer: a.string() }).bind(), strict: true, errorFormat: { maxErrors: 2 }, schemaDelivery: 'prompt' },
      errorFormat: 'list',
      temperature: 0.5,
      maxTokens: 100,
    };
    const wire = refuse.request(request);
    // the code shape: an optional field is left out of `required`, not sent as nullable
    expect(wire.tools?.[0]?.parameters).toMatchObject({ type: 'object', properties: { q: { type: 'string' }, near: { type: 'string' } }, required: ['q'] });
    expect(LlmRequest.parse(wire)).toEqual(wire);
    const rebuilt = requestFromWire(wire);
    expect(refuse.request(rebuilt)).toEqual(wire);
    const tool = rebuilt.tools?.[0];
    expect(tool?.parameters.render(LENIENT).parse({ q: 'x' })).toMatchObject({ ok: true, value: { q: 'x' } });
    expect(tool?.parameters.render(LENIENT).parse({ q: 1 }).ok).toBe(false);
    expect(tool).toMatchObject({ strict: 3, errorFormat: 'summary' });
    expect(rebuilt.responseFormat).toMatchObject({ strict: true, errorFormat: { maxErrors: 2 }, schemaDelivery: 'prompt' });
    expect(rebuilt.errorFormat).toBe('list');
    expect(wire.messages.map(messageFromWire).map((m) => refuse.message(m))).toEqual(wire.messages);
  });

  it('refuses a rebuilt tool or output schema that does not describe an object', () => {
    expect(() => requestFromWire({ messages: [], tools: [{ name: 't', parameters: { type: 'string' } }] })).toThrow(/object/);
    expect(() => requestFromWire({ messages: [], responseFormat: { schema: { type: 'number' }, strict: false } })).toThrow(/object/);
  });

  it('tells object schemas apart: bound schemas by their root (through refs), zod ones by their definition', () => {
    expect(isObjectSchema(a.object({}).bind())).toBe(true);
    expect(isObjectSchema(a.record(a.number()).bind())).toBe(true);
    expect(isObjectSchema(a.string().bind())).toBe(false);
    expect(isObjectSchema(schemaFromWire({ $ref: '#/$defs/Node', $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } } }))).toBe(true);
  });

  it('records a planned request as the model was sent it, and one not planned in the code shape', async () => {
    const sentWire = new LlmWire({ unrepresentable: 'placeholder', schemas: 'sent' });
    const request: Request = {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'find', parameters: a.object({ q: a.string(), near: a.string().optional() }).bind() }],
      responseFormat: { type: a.object({ answer: a.string().optional() }).bind(), strict: true },
    };
    expect(sentWire.request(request).tools?.[0]?.parameters).toEqual(refuse.request(request).tools?.[0]?.parameters);
    await prepareRequest(request, OPENAI);
    const saved = sentWire.request(request);
    // OpenAI's strict dialect: every field required, an optional one nullable
    expect(saved.tools?.[0]).toMatchObject({ name: 'find', strict: true, parameters: { required: ['q', 'near'] } });
    expect(JSON.stringify(saved.tools?.[0]?.parameters)).toContain('null');
    expect(saved.responseFormat).toMatchObject({ strict: true, schemaDelivery: 'structured', schema: { required: ['answer'] } });
  });
});

/** A request as a system sends it (its own schemas) and as the hub rebuilds it from the wire. */
function bothSides(request: Request): { system: Request; hub: Request } {
  return { system: request, hub: requestFromWire(refuse.request(request)) };
}

/** Every chunk a decoder sends for a stream. */
function decodeAll(request: Request, chunks: Chunk[]): Chunk[] {
  const decoder = new AnswerDecoder(request);
  return [...chunks.flatMap((chunk) => decoder.chunk(chunk)), ...decoder.end()];
}

describe('decoding the answer hub-side (AnswerDecoder)', () => {
  const Filter = a.object({ field: a.string(), limit: a.number().optional(), tags: a.record(a.string()) });

  it('decodes a strict call (nulls for optionals, pairs for records) to the code shape, which the system decodes as it is', async () => {
    const { system, hub } = bothSides({ messages: [], tools: [{ name: 'search', parameters: Filter.bind() }] });
    const prepared = await prepareRequest(hub, OPENAI);
    const value = { field: 'name', tags: { a: 'x', b: 'y' } };
    const call = (prepared.plan ?? planRequest(hub)).encodeCall('search', value);
    // what the model writes in OpenAI's strict dialect is not the code shape
    expect(JSON.stringify(call.args)).toContain('null');
    expect(JSON.stringify(call.args)).not.toContain('"tags":{');
    const [out] = decodeAll(hub, [{ toolCall: { id: 'c1', name: call.name, arguments: JSON.stringify(call.args) } }]);
    expect(out?.toolCall).toEqual({ id: 'c1', name: 'search', arguments: JSON.stringify(value) });
    // the system's own (lenient) plan takes the hub's arguments as they are
    expect(planRequest(system).decodeCall('search', JSON.parse(out?.toolCall?.arguments ?? ''))).toMatchObject({ ok: true, value });
  });

  it('forwards a call that does not fit with the model\'s arguments and the message the model is told', async () => {
    const { hub } = bothSides({ messages: [], tools: [{ name: 'search', parameters: Filter.bind() }] });
    await prepareRequest(hub, OPENAI);
    const [out] = decodeAll(hub, [{ toolCall: { id: 'c1', name: 'search', arguments: '{"field":3}' } }]);
    expect(out?.toolCall).toMatchObject({ id: 'c1', name: 'search', arguments: '{"field":3}' });
    expect(out?.toolCall?.invalid).toMatch(/field/);
    // not JSON at all: as it came, for the system's prompt to report; already judged further along: as it came
    expect(decodeAll(hub, [{ toolCall: { id: 'c2', name: 'search', arguments: '{"fie' } }])[0]?.toolCall).toEqual({ id: 'c2', name: 'search', arguments: '{"fie' });
    const judged = { id: 'c3', name: 'search', arguments: '{}', invalid: 'no' };
    expect(decodeAll(hub, [{ toolCall: judged }])[0]?.toolCall).toBe(judged);
  });

  it('holds a dispatcher call back and forwards it named and finished under the tool it reached', async () => {
    const tools: ToolDefinition[] = Array.from({ length: 130 }, (_, i) => ({ name: `tool_${String(i)}`, parameters: a.object({ n: a.number() }).bind() }));
    const { hub } = bothSides({ messages: [], tools });
    const prepared = await prepareRequest(hub, OPENAI);
    const plan = prepared.plan ?? planRequest(hub);
    expect(plan.dispatcher).toBeDefined();
    const call = plan.encodeCall('tool_129', { n: 7 });
    expect(call.name).toBe(plan.dispatcher?.name);
    const named = { id: 'd1', name: call.name, arguments: '' };
    const out = decodeAll(hub, [
      { toolCallNamed: named },
      { toolCallArguments: { ...named, arguments: '{"tool"' } },
      { toolCall: { ...named, arguments: JSON.stringify(call.args) }, finishReason: 'tool_calls' },
    ]);
    expect(out).toEqual([{
      toolCallNamed: { id: 'd1', name: 'tool_129', arguments: '{"n":7}' },
      toolCall: { id: 'd1', name: 'tool_129', arguments: '{"n":7}' },
      finishReason: 'tool_calls',
    }]);
    // a dispatcher call to no tool goes by the name it gave, so the system's prompt names the tools there are
    const lost = decodeAll(hub, [{ toolCall: { id: 'd2', name: call.name, arguments: '{"tool":"tool_999","args":{"n":1}}' } }])[0]?.toolCall;
    expect(lost).toMatchObject({ name: 'tool_999' });
    expect(lost?.invalid).toBeDefined();
  });

  it('holds a structured answer\'s text until it ends and forwards it decoded, or as written when it does not fit', async () => {
    const { system, hub } = bothSides({ messages: [], responseFormat: { type: a.object({ answer: a.string(), note: a.string().optional() }).bind(), strict: true } });
    await prepareRequest(hub, OPENAI);
    const out = decodeAll(hub, [{ content: '{"answer":"hi",' }, { content: '"note":null}' }, { finishReason: 'stop' }, { usage: { text: { input: 1 } } }]);
    expect(out).toEqual([{ content: '{"answer":"hi"}' }, { finishReason: 'stop' }, { usage: { text: { input: 1 } } }]);
    expect(planRequest(system).output?.parseText(out[0]?.content ?? '')).toMatchObject({ ok: true, value: { answer: 'hi' } });
    expect(decodeAll(hub, [{ content: '{"answer":3}' }])).toEqual([{ content: '{"answer":3}' }]);
    // text answers (no structured output) stream as they come
    expect(decodeAll({ messages: [] }, [{ content: 'a' }, { content: 'b', finishReason: 'stop' }])).toEqual([{ content: 'a' }, { content: 'b', finishReason: 'stop' }]);
  });
});

describe('usage and chunks', () => {
  it('meters usage one way and gives it back with the real cost the other', () => {
    const wire = usageToWire({ text: { input: 10, output: 5, cached: 2 }, reasoning: { output: 3 } });
    expect(wire).toEqual({ input: 10, output: 5, cached: 2, reasoning: 3 });
    expect(usageFromWire(wire, 0.01)).toEqual({ text: { input: 10, output: 5, cached: 2 }, reasoning: { output: 3 }, cost: 0.01 });
    expect(usageFromWire({ input: 1, output: 1 })).toEqual({ text: { input: 1, output: 1 } });
    expect(usageToWire(undefined)).toEqual({ input: 0, output: 0 });
  });

  it('round-trips a chunk, a judged call\'s message included', () => {
    const chunk = {
      content: 'a', reasoning: 'r', toolCallNamed: { id: 't', name: 'n', arguments: '' }, toolCallArguments: { id: 't', name: 'n', arguments: '{' },
      toolCall: { id: 't', name: 'n', arguments: '{}', invalid: 'bad' }, finishReason: 'tool_calls' as const, refusal: 'no', usage: { input: 1, output: 2 },
    };
    expect(chunkToWire(chunkFromWire(chunk))).toEqual(chunk);
    expect(new ChunkReader().read({ toolCall: chunk.toolCall }).toolCall).toEqual(chunk.toolCall);
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

// iteration 1, rep 3: every forwarded authoring step rebuilt its 50 KB gin program schema from JSON (10 to 20 ms) and
// the hub converted it back to JSON schema to save the interaction (110 ms), on the event loop, until it shed load
describe('schemas made once', () => {
  const big = a.object({
    draft: a.object({ name: a.string(), steps: a.array(a.union([a.object({ kind: a.literal('a'), n: a.number() }), a.object({ kind: a.literal('b'), s: a.string() })])) }),
  }).bind();
  const json = lenientJson(big);

  it('rebuilds the same JSON schema from the wire into the same bound schema, and a changed one anew', () => {
    const wire = (parameters: typeof json): LlmRequest => ({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'set', parameters }] });
    const first = requestFromWire(wire(json)).tools?.[0]?.parameters;
    const again = requestFromWire(wire(structuredClone(json))).tools?.[0]?.parameters;
    expect(again).toBe(first);
    const other = requestFromWire(wire(lenientJson(a.object({ other: a.string() }).bind()))).tools?.[0]?.parameters;
    expect(other).not.toBe(first);
    expect(other?.render(LENIENT).parse({ other: 'x' }).ok).toBe(true);
  });

  it('writes a bound schema\'s JSON schema once per schema', () => {
    const wire = new LlmWire({ unrepresentable: 'placeholder' });
    const request: Request = { messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'set', parameters: big }] };
    const once = wire.request(request).tools?.[0]?.parameters;
    expect(wire.request(request).tools?.[0]?.parameters).toBe(once);
    expect(once).toEqual(json);
  });
});
