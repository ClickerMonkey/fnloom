import { LinkLimits, mintId, type LlmForward, type LlmForwardChunk } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { g } from '../gin.ts';
import type { HubAccess, HubLink } from './link.ts';
import { aeyeChunk, harnessAi, HarnessProvider, HubLlm, HubLlmError, wireRequest } from './llm.ts';

/** A hub whose LLM forwards answer from a script, one per forward; embeds echo lengths. */
function scriptedHub(script: Array<(forward: LlmForward) => LlmForwardChunk[]>) {
  const forwards: LlmForward[] = [];
  const hub = {
    call: (name: string, data: LlmForward & { texts?: string[] }) => {
      if (name === 'embed') { return Promise.resolve({ vectors: (data.texts ?? []).map((t) => [t.length]), cost: 0.001 }); }
      forwards.push(data);
      const next = script[forwards.length - 1];
      if (next === undefined) { throw new Error('no more scripted answers'); }
      const chunks = next(data);
      return (async function* () { yield* chunks; })();
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the provider only uses `call('llm' | 'embed')`; this double answers those
  const link = hub as unknown as HubLink;
  const access: HubAccess = { ready: () => Promise.resolve(link), now: () => link, limits: () => LinkLimits.parse({ maxFrame: 1_024, maxChunk: 1_024, heartbeat: 1_000 }) };
  return { access, forwards };
}

const done = (cost = 0.002): LlmForwardChunk => ({ type: 'done', usage: { input: 10, output: 5 }, cost, interaction: mintId('llmInteraction'), model: 'vendor/model' });

describe('wireRequest', () => {
  it('turns zod tool and output schemas into JSON schema and keeps the conversation', () => {
    const wire = wireRequest({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', content: 'look' }, { type: 'image', content: new URL('https://x.test/a.png') }, { type: 'file', content: new Uint8Array([1, 2]), name: 'f.bin' }] },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'find', arguments: '{"q":"a"}' }] },
        { role: 'tool', content: 'found', toolCallId: 'c1' },
      ],
      tools: [{ name: 'find', description: 'Find.', parameters: z.object({ q: z.string() }), strict: true }, { name: 'loose', parameters: z.object({}), strict: 1 }],
      toolChoice: { allowed: ['find'], required: true },
      responseFormat: { type: z.object({ answer: z.string() }), strict: 1 },
      stop: 'END',
      temperature: 0.2,
    });
    expect(wire.tools?.[0]).toMatchObject({ name: 'find', strict: true, parameters: { type: 'object', properties: { q: { type: 'string' } } } });
    expect(wire.tools?.[1]?.strict).toBeUndefined();
    expect(wire.toolChoice).toBe('required');
    expect(wire.responseFormat).toMatchObject({ strict: false, schema: { type: 'object' } });
    expect(wire.stop).toEqual(['END']);
    const user = wire.messages[1]?.content;
    expect(Array.isArray(user) ? user.map((p) => p.content.slice(0, 22)) : user).toEqual(['look', 'https://x.test/a.png', 'data:application/octet']);
    expect(wire.messages[2]?.toolCalls).toEqual([{ id: 'c1', name: 'find', arguments: '{"q":"a"}' }]);
  });

  it('refuses a schema JSON schema cannot express, which would not survive the trip', () => {
    expect(() => wireRequest({ messages: [], tools: [{ name: 't', parameters: z.object({ a: z.bigint() }) }] })).toThrow();
  });

  it('maps wire chunks to aeye chunks', () => {
    expect(aeyeChunk({ content: 'a', reasoning: 'r', usage: { input: 1, output: 2, cached: 3, reasoning: 4 } })).toEqual({
      content: 'a', reasoning: { content: 'r' }, usage: { text: { input: 1, output: 2, cached: 3 }, reasoning: { output: 4 } },
    });
  });
});

describe('HarnessProvider', () => {
  it('runs an aeye prompt with a tool and a structured answer through the hub, with descriptors and real cost', async () => {
    const { access, forwards } = scriptedHub([
      () => [
        { type: 'descriptors', tools: { lookup: 'openai' } },
        { type: 'chunk', chunk: { toolCallNamed: { id: 't1', name: 'lookup', arguments: '' } } },
        { type: 'chunk', chunk: { toolCall: { id: 't1', name: 'lookup', arguments: '{"city":"Oslo"}' } } },
        { type: 'chunk', chunk: { finishReason: 'tool_calls' } },
        done(),
      ],
      () => [
        { type: 'chunk', chunk: { content: '{"answer":"cold in Oslo"}' } },
        { type: 'chunk', chunk: { finishReason: 'stop' } },
        done(0.003),
      ],
    ]);
    const ai = harnessAi({ hub: access, run: mintId('run') });
    const lookups: string[] = [];
    const lookup = ai.tool({
      name: 'lookup',
      description: 'Weather for a city.',
      instructions: 'Use lookup to get the weather.',
      schema: z.object({ city: z.string() }),
      call: (input: { city: string }) => { lookups.push(input.city); return 'cold'; },
    });
    const prompt = ai.prompt({
      name: 'weather',
      description: 'Answers about weather.',
      content: 'What is the weather in {{city}}?',
      input: (input: { city: string }) => ({ city: input.city }),
      tools: [lookup],
      schema: z.object({ answer: z.string() }),
    });
    const result = await prompt.get('result', { city: 'Oslo' });
    expect(result).toEqual({ answer: 'cold in Oslo' });
    expect(lookups).toEqual(['Oslo']);
    expect(forwards).toHaveLength(2);
    expect(forwards[0]?.request.tools?.[0]?.name).toBe('lookup');
    expect(forwards[0]?.request.responseFormat).toMatchObject({ schema: { type: 'object' } });
    expect(forwards[1]?.request.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('writes the descriptors the hub chose into the request, so strict tool args and output decode here', async () => {
    const { access } = scriptedHub([() => [{ type: 'descriptors', tools: { find: 'openai' }, output: 'openai' }, { type: 'chunk', chunk: { finishReason: 'stop' } }, done()]]);
    const request = {
      messages: [{ role: 'user' as const, content: 'x' }],
      tools: [{ name: 'find', parameters: z.object({ q: z.string() }) }],
      responseFormat: { type: z.object({ a: z.string() }), strict: true },
    };
    const stream = new HarnessProvider({ hub: access }).forward(request, undefined);
    while ((await stream.next()).done !== true) { /* drain */ }
    expect(request.tools[0]).toHaveProperty('descriptor', 'openai');
    expect(request.responseFormat).toHaveProperty('descriptor', 'openai');
  });

  it('answers as an executor too, and reports the hub as healthy only while connected', async () => {
    const { access } = scriptedHub([() => [{ type: 'chunk', chunk: { content: 'hi' } }, { type: 'chunk', chunk: { finishReason: 'stop' } }, done(0.5)]]);
    const provider = new HarnessProvider({ hub: access });
    const response = await provider.createExecutor()({ messages: [{ role: 'user', content: 'hey' }] }, {});
    expect(response.content).toBe('hi');
    expect(response.usage?.cost).toBe(0.5);
    expect(await provider.checkHealth()).toBe(true);
  });

  it('turns an error from the hub into a HubLlmError naming whose fault it was', async () => {
    const { access } = scriptedHub([() => [{ type: 'error', message: 'over budget', kind: 'limit' }]]);
    await expect(new HubLlm({ hub: access }).text({ prompt: 'x' })).rejects.toMatchObject({ name: 'HubLlmError', kind: 'limit' });
    expect(new HubLlmError('m', 'model').kind).toBe('model');
  });
});

describe('HubLlm (ctx.llm)', () => {
  it('asks for text with the model choice the system gave', async () => {
    const { access, forwards } = scriptedHub([() => [{ type: 'chunk', chunk: { content: 'hello' } }, { type: 'chunk', chunk: { finishReason: 'stop' } }, done()]]);
    expect(await new HubLlm({ hub: access }).text({ prompt: 'greet', system: 'Be nice.', model: { category: 'fast' } })).toBe('hello');
    expect(forwards[0]).toMatchObject({ model: { category: 'fast' }, stream: true });
    expect(forwards[0]?.request.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('asks for an object checked against a gin type', async () => {
    const { access } = scriptedHub([() => [{ type: 'chunk', chunk: { content: '{"value":{"n":3,"at":"2026-01-01T00:00:00.000Z"}}' } }, { type: 'chunk', chunk: { finishReason: 'stop' } }, done()]]);
    const value = await new HubLlm({ hub: access }).object({ prompt: 'count', output: g.obj({ n: g.num(), at: g.timestamp() }) });
    expect(value).toEqual({ n: 3, at: new Date('2026-01-01T00:00:00.000Z') });
  });

  it('streams text and embeds through the hub', async () => {
    const { access } = scriptedHub([() => [{ type: 'chunk', chunk: { content: 'a' } }, { type: 'chunk', chunk: { content: 'b' } }, { type: 'chunk', chunk: { finishReason: 'stop' } }, done()]]);
    const llm = new HubLlm({ hub: access });
    const parts: string[] = [];
    for await (const part of llm.stream({ prompt: 'x' })) { parts.push(part); }
    expect(parts).toEqual(['a', 'b']);
    expect(await llm.embed(['ab', 'c'])).toEqual([[2], [1]]);
  });
});
