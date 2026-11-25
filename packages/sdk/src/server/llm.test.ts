import { LinkLimits, mintId, ModelForward, type ContentRef, type HubModelInfo, type LlmForward, type LlmForwardChunk, type ModelForwardResult } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { a } from '@aeye/core';
import { g } from '../gin.ts';
import { contentHash, type ContentTransfer } from './content.ts';
import type { HubAccess, HubLink } from './link.ts';
import { chunkFromWire } from './llm-wire.ts';
import { HarnessProvider, hubAiOf, HubLlm, HubLlmError, HubModelLink, HubModels, wireRequest } from './llm.ts';

/** Content kept in memory by hash, as the hub would keep it. */
class MemoryContent implements ContentTransfer {
  readonly stored = new Map<string, Uint8Array>();

  upload(bytes: Uint8Array, mime: string): Promise<ContentRef> {
    const ref = { hash: contentHash(bytes), size: bytes.length, mime };
    this.stored.set(ref.hash, bytes);
    return Promise.resolve(ref);
  }

  download(ref: ContentRef): Promise<Uint8Array> {
    const bytes = this.stored.get(ref.hash);
    return bytes === undefined ? Promise.reject(new Error(`no content ${ref.hash}`)) : Promise.resolve(bytes);
  }
}

/** What a scripted hub answers a forwarded non-chat call with (without the record fields it adds). */
type ModelAnswer = (forward: ModelForward) => ModelForwardResult;

/** Embeddings answered with each text's length, as the default non-chat answer. */
const embedLengths: ModelAnswer = (forward) => {
  if (forward.modality !== 'embed') { throw new Error(`no scripted ${forward.modality} answer`); }
  return { modality: 'embed', vectors: forward.texts.map((t) => [t.length]), call: mintId('modelCall'), cost: 0.001, model: 'vendor/embed' };
};

/** A hub whose LLM forwards answer from a script, one per forward; non-chat calls answer with `model` (embeds echo lengths). */
function scriptedHub(script: Array<(forward: LlmForward) => LlmForwardChunk[]>, model: ModelAnswer = embedLengths, listed: HubModelInfo[] = []) {
  const forwards: LlmForward[] = [];
  const models: ModelForward[] = [];
  const hub = {
    call: (name: string, data: LlmForward) => {
      if (name === 'models') { return Promise.resolve(listed); }
      if (name === 'model') {
        const forward = ModelForward.parse(data);
        models.push(forward);
        return Promise.resolve(model(forward));
      }
      forwards.push(data);
      const next = script[forwards.length - 1];
      if (next === undefined) { throw new Error('no more scripted answers'); }
      const chunks = next(data);
      return (async function* () { yield* chunks; })();
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the provider only uses `call('llm' | 'model')`; this double answers those
  const link = hub as unknown as HubLink;
  const access: HubAccess = { ready: () => Promise.resolve(link), now: () => link, limits: () => LinkLimits.parse({ maxFrame: 1_024, maxChunk: 1_024, heartbeat: 1_000 }) };
  return { access, forwards, models };
}

const done = (cost = 0.002): LlmForwardChunk => ({ type: 'done', usage: { input: 10, output: 5 }, cost, interaction: mintId('llmInteraction'), model: 'vendor/model' });

describe('wireRequest', () => {
  it('turns tool and output schemas into their lenient JSON schema and keeps the conversation', () => {
    const wire = wireRequest({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', content: 'look' }, { type: 'image', content: new URL('https://x.test/a.png') }, { type: 'file', content: new Uint8Array([1, 2]), name: 'f.bin' }] },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'find', arguments: '{"q":"a"}' }] },
        { role: 'tool', content: 'found', toolCallId: 'c1' },
      ],
      tools: [{ name: 'find', description: 'Find.', parameters: a.object({ q: a.string() }).bind(), strict: true }, { name: 'loose', parameters: a.object({}).bind(), strict: 1 }],
      toolChoice: { allowed: ['find'], required: true },
      responseFormat: { type: a.object({ answer: a.string() }).bind(), strict: 1 },
      stop: 'END',
      temperature: 0.2,
    });
    expect(wire.tools?.[0]).toMatchObject({ name: 'find', strict: true, parameters: { type: 'object', properties: { q: { type: 'string' } } } });
    // a numeric strict policy (prefer strict, with a priority) crosses as it is
    expect(wire.tools?.[1]?.strict).toBe(1);
    expect(wire.toolChoice).toBe('required');
    expect(wire.responseFormat).toMatchObject({ strict: 1, schema: { type: 'object' } });
    expect(wire.stop).toEqual(['END']);
    const user = wire.messages[1]?.content;
    expect(Array.isArray(user) ? user.map((p) => p.content.slice(0, 22)) : user).toEqual(['look', 'https://x.test/a.png', 'data:application/octet']);
    expect(wire.messages[2]?.toolCalls).toEqual([{ id: 'c1', name: 'find', arguments: '{"q":"a"}' }]);
  });

  it('maps wire chunks to aeye chunks', () => {
    expect(chunkFromWire({ content: 'a', reasoning: 'r', usage: { input: 1, output: 2, cached: 3, reasoning: 4 } })).toEqual({
      content: 'a', reasoning: { content: 'r' }, usage: { text: { input: 1, output: 2, cached: 3 }, reasoning: { output: 4 } },
    });
  });
});

describe('HarnessProvider', () => {
  it('runs an aeye prompt with a tool and a structured answer through the hub, with the real cost', async () => {
    const { access, forwards } = scriptedHub([
      () => [
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
    const ai = await hubAiOf({ hub: access, content: new MemoryContent(), run: mintId('run') });
    const lookups: string[] = [];
    const lookup = ai.tool({
      name: 'lookup',
      description: 'Weather for a city.',
      instructions: 'Use lookup to get the weather.',
      schema: a.object({ city: a.string() }),
      call: (input: { city: string }) => { lookups.push(input.city); return 'cold'; },
    });
    const prompt = ai.prompt({
      name: 'weather',
      description: 'Answers about weather.',
      content: 'What is the weather in {{city}}?',
      input: (input: { city: string }) => ({ city: input.city }),
      tools: [lookup],
      schema: a.object({ answer: a.string() }),
    });
    const result = await prompt.get('result', { city: 'Oslo' });
    expect(result).toEqual({ answer: 'cold in Oslo' });
    expect(lookups).toEqual(['Oslo']);
    expect(forwards).toHaveLength(2);
    expect(forwards[0]?.request.tools?.[0]?.name).toBe('lookup');
    expect(forwards[0]?.request.responseFormat).toMatchObject({ schema: { type: 'object' } });
    expect(forwards[1]?.request.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('answers a call the hub found invalid with the hub\'s message, without running the tool', async () => {
    const said = 'At "city": expected a string, got 3.';
    const { access, forwards } = scriptedHub([
      () => [
        { type: 'chunk', chunk: { toolCallNamed: { id: 't1', name: 'lookup', arguments: '' } } },
        { type: 'chunk', chunk: { toolCall: { id: 't1', name: 'lookup', arguments: '{"city":3}', invalid: said } } },
        { type: 'chunk', chunk: { finishReason: 'tool_calls' } },
        done(),
      ],
      () => [{ type: 'chunk', chunk: { content: 'sorry' } }, { type: 'chunk', chunk: { finishReason: 'stop' } }, done()],
    ]);
    const ai = await hubAiOf({ hub: access, content: new MemoryContent(), run: mintId('run') });
    const lookups: string[] = [];
    const lookup = ai.tool({
      name: 'lookup', description: 'Weather for a city.', schema: a.object({ city: a.string() }),
      call: (input: { city: string }) => { lookups.push(input.city); return 'cold'; },
    });
    const prompt = ai.prompt({ name: 'weather', description: 'Answers about weather.', content: 'Weather?', tools: [lookup] });
    expect(await prompt.get('result', {})).toBe('sorry');
    expect(lookups).toEqual([]);
    const reply = forwards[1]?.request.messages.find((m) => m.role === 'tool');
    expect(reply?.content).toContain(`Error parsing tool arguments: ${said}`);
  });

  it('answers as an executor too, and reports the hub as healthy only while connected', async () => {
    const { access } = scriptedHub([() => [{ type: 'chunk', chunk: { content: 'hi' } }, { type: 'chunk', chunk: { finishReason: 'stop' } }, done(0.5)]]);
    const provider = new HarnessProvider({ hub: access, content: new MemoryContent() });
    const response = await provider.createExecutor()({ messages: [{ role: 'user', content: 'hey' }] }, {});
    expect(response.content).toBe('hi');
    expect(response.usage?.cost).toBe(0.5);
    expect(await provider.checkHealth()).toBe(true);
  });

  it('turns an error from the hub into a HubLlmError naming whose fault it was', async () => {
    const { access } = scriptedHub([() => [{ type: 'error', message: 'over budget', kind: 'limit' }]]);
    await expect(new HubLlm({ hub: access, content: new MemoryContent() }).text({ prompt: 'x' })).rejects.toMatchObject({ name: 'HubLlmError', kind: 'limit' });
    expect(new HubLlmError('m', 'model').kind).toBe('model');
  });

  // OpenAI refused the program authoring agents' `signature` tool in strict mode (a gin record's propertyNames)
  it('turns a provider\'s refusal of a tool schema into aeye\'s schema rejection, so the prompt can fall back', async () => {
    const message = 'Invalid schema for function \'signature\': In context=(\'properties\', \'props\', \'anyOf\', \'0\'), \'propertyNames\' is not permitted.';
    const { access } = scriptedHub([() => [{ type: 'error', message, kind: 'provider' }]]);
    const request = { messages: [{ role: 'user' as const, content: 'x' }], tools: [{ name: 'signature', parameters: a.object({ q: a.string() }).bind() }] };
    const stream = new HarnessProvider({ hub: access, content: new MemoryContent() }).forward(request, undefined);
    await expect(stream.next()).rejects.toMatchObject({ name: 'SchemaRejectedError', target: { kind: 'tool', name: 'signature' } });
  });
});

describe('the hub\'s real models (ctx.ai / hubAi)', () => {
  const said = (text: string) => (): LlmForwardChunk[] => [{ type: 'chunk', chunk: { content: text } }, { type: 'chunk', chunk: { finishReason: 'stop' } }, done()];
  const small: HubModelInfo = {
    id: 'meta/small', provider: 'openrouter', name: 'Small', capabilities: ['chat', 'streaming', 'telepathy'], tier: 'efficient',
    pricing: { input: 0.1, output: 0.2 }, contextWindow: 8_000, roles: ['chat'],
  };
  const big: HubModelInfo = {
    id: 'big', provider: 'openai', name: 'Big', capabilities: ['chat', 'streaming', 'tools', 'structured'], tier: 'flagship',
    pricing: { input: 5, output: 15 }, contextWindow: 128_000, maxOutputTokens: 16_000, roles: [],
  };

  it('lists the hub\'s models and roles as aeye models, with aeye\'s capability names only', async () => {
    const { access } = scriptedHub([], embedLengths, [small, big]);
    const ai = await hubAiOf({ hub: access });
    const models = new Map(ai.models.list().map((m) => [m.id, m]));
    expect([...models.keys()].sort()).toEqual(['openai/big', 'openrouter/meta/small', 'role/chat']);
    expect(models.get('openrouter/meta/small')).toMatchObject({ provider: 'hub', tier: 'efficient', contextWindow: 8_000, pricing: { text: { input: 0.1, output: 0.2 } } });
    expect([...(models.get('openrouter/meta/small')?.capabilities ?? [])]).toEqual(['chat', 'streaming']);
    expect(models.get('openai/big')?.maxOutputTokens).toBe(16_000);
  });

  it('forwards the model aeye picks or the call names, a role as its model, and lets the hub pick with none listed', async () => {
    const { access, forwards } = scriptedHub([said('a'), said('b'), said('c')], embedLengths, [small, big]);
    const ai = await hubAiOf({ hub: access });
    await ai.chat.get({ messages: [{ role: 'user', content: 'hi' }] });
    await ai.chat.get({ messages: [{ role: 'user', content: 'hi' }] }, { metadata: { model: 'role/chat' } });
    await ai.chat.get({ messages: [{ role: 'user', content: 'hi' }] }, { metadata: { model: 'openai/big' } });
    expect(forwards.map((f) => f.model)).toEqual([{ model: 'openrouter/meta/small' }, { model: 'openrouter/meta/small' }, { model: 'openai/big' }]);

    const none = scriptedHub([said('d')]);
    await (await hubAiOf({ hub: none.access })).chat.get({ messages: [{ role: 'user', content: 'hi' }] });
    expect(none.forwards[0]?.model).toBeUndefined();
  });
});

describe('HubLlm (ctx.llm)', () => {
  it('asks for text with the model choice the system gave', async () => {
    const { access, forwards } = scriptedHub([() => [{ type: 'chunk', chunk: { content: 'hello' } }, { type: 'chunk', chunk: { finishReason: 'stop' } }, done()]]);
    expect(await new HubLlm({ hub: access, content: new MemoryContent() }).text({ prompt: 'greet', system: 'Be nice.', model: { category: 'fast' } })).toBe('hello');
    expect(forwards[0]).toMatchObject({ model: { category: 'fast' }, stream: true });
    expect(forwards[0]?.request.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('asks for an object checked against a gin type', async () => {
    const { access } = scriptedHub([() => [{ type: 'chunk', chunk: { content: '{"value":{"n":3,"at":"2026-01-01T00:00:00.000Z"}}' } }, { type: 'chunk', chunk: { finishReason: 'stop' } }, done()]]);
    const value = await new HubLlm({ hub: access, content: new MemoryContent() }).object({ prompt: 'count', output: g.obj({ n: g.num(), at: g.timestamp() }) });
    expect(value).toEqual({ n: 3, at: new Date('2026-01-01T00:00:00.000Z') });
  });

  it('streams text and embeds through the hub', async () => {
    const { access } = scriptedHub([() => [{ type: 'chunk', chunk: { content: 'a' } }, { type: 'chunk', chunk: { content: 'b' } }, { type: 'chunk', chunk: { finishReason: 'stop' } }, done()]]);
    const llm = new HubLlm({ hub: access, content: new MemoryContent() });
    const parts: string[] = [];
    for await (const part of llm.stream({ prompt: 'x' })) { parts.push(part); }
    expect(parts).toEqual(['a', 'b']);
    expect(await llm.embed(['ab', 'c'])).toEqual([[2], [1]]);
  });
});

describe('every other modality through the hub (`model`)', () => {
  const run = mintId('run');
  const call = mintId('modelCall');

  /** A hub that makes images, hears audio and speaks, storing outputs in `content`. */
  function modalHub(content: MemoryContent) {
    const image = new Uint8Array([137, 80, 78, 71]);
    const speech = new Uint8Array([73, 68, 51]);
    let imageRef: ContentRef | undefined;
    let speechRef: ContentRef | undefined;
    void content.upload(image, 'image/png').then((ref) => { imageRef = ref; });
    void content.upload(speech, 'audio/mpeg').then((ref) => { speechRef = ref; });
    const answer: ModelAnswer = (forward) => {
      switch (forward.modality) {
        case 'embed': return embedLengths(forward);
        case 'image': return { modality: 'image', images: Array.from({ length: forward.count ?? 1 }, () => imageRef ?? fail()), call, cost: 0.04, model: 'vendor/painter' };
        case 'transcribe': return { modality: 'transcribe', text: 'hello there', segments: [{ start: 0, end: 1.5, text: 'hello there' }], call, cost: 0.01, model: 'vendor/ears' };
        case 'speech': return { modality: 'speech', audio: speechRef ?? fail(), call, cost: 0.02, model: 'vendor/voice' };
        case 'decide': return {
          modality: 'decide', answers: Object.fromEntries(Object.keys(forward.questions).map((name) => [name, { type: 'predicate', probability: 0.75 }])), call, cost: 0.003, model: 'vendor/judge',
        };
      }
    };
    return { answer, image, speech };
  }

  function fail(): never {
    throw new Error('content was not stored yet');
  }

  it('sends each modality with the run, and gives back the record id, cost and model (ctx.llm)', async () => {
    const content = new MemoryContent();
    const { answer } = modalHub(content);
    const { access, models } = scriptedHub([], answer);
    const llm = new HubLlm({ hub: access, content, run });
    const audio = await content.upload(new Uint8Array([1, 2, 3]), 'audio/wav');

    expect(await llm.embed(['abc', 'de'])).toEqual([[3], [2]]);
    expect(await llm.embed([])).toEqual([]);
    const images = await llm.image({ prompt: 'a red fox', size: '512x512', count: 2, model: { category: 'images' } });
    expect(images).toMatchObject({ call, cost: 0.04, model: 'vendor/painter' });
    expect(images.images).toHaveLength(2);
    expect(await llm.transcribe({ audio, language: 'en' })).toMatchObject({ text: 'hello there', segments: [{ start: 0, end: 1.5 }] });
    expect((await llm.speak({ text: 'hi', voice: 'alloy', format: 'mp3' })).audio.mime).toBe('audio/mpeg');

    expect(models.map((m) => m.modality)).toEqual(['embed', 'image', 'transcribe', 'speech']);
    expect(models.every((m) => m.run === run)).toBe(true);
    expect(models[1]).toMatchObject({ prompt: 'a red fox', size: '512x512', count: 2, model: { category: 'images' } });
    expect(models[2]).toMatchObject({ audio, language: 'en' });
  });

  it('answers aeye image, transcription, speech and embedding calls in aeye shapes (harnessAi)', async () => {
    const content = new MemoryContent();
    const { answer, image, speech } = modalHub(content);
    const { access, models } = scriptedHub([], answer);
    const provider = new HarnessProvider({ hub: access, content, run });
    const ctx = { metadata: { harness: { model: { model: 'vendor/painter' } } } };

    const made = await provider.generateImage({ prompt: 'fox', n: 1 }, ctx);
    expect(made.images).toEqual([{ b64_json: Buffer.from(image).toString('base64') }]);
    expect(made).toMatchObject({ model: 'vendor/painter', usage: { cost: 0.04 } });
    expect(models[0]).toMatchObject({ modality: 'image', model: { model: 'vendor/painter' }, count: 1 });

    const heard = await provider.transcribe({ audio: new Uint8Array([9, 9]), language: 'fr' }, {});
    expect(heard).toMatchObject({ text: 'hello there', segments: [{ id: '0', start: 0, end: 1.5, text: 'hello there' }], usage: { cost: 0.01 } });
    const uploaded = models[1];
    expect(uploaded?.modality === 'transcribe' ? content.stored.get(uploaded.audio.hash) : undefined).toEqual(new Uint8Array([9, 9]));

    const spoken = await provider.speech({ text: 'hi', responseFormat: 'opus' }, {});
    expect(models[2]).toMatchObject({ modality: 'speech', format: 'ogg' });
    const bytes = new Uint8Array(await new Response(spoken.audio).arrayBuffer());
    expect(bytes).toEqual(speech);
    await expect(provider.speech({ text: 'hi', responseFormat: 'flac' }, {})).rejects.toThrow(/mp3, wav or ogg/);

    const embedded = await (await hubAiOf({ hub: access, content, run })).embed.get({ texts: ['four'] });
    expect(embedded.embeddings).toEqual([{ embedding: [4], index: 0 }]);
  });

  it('answers aeye decision calls through the hub (ctx.ai().decide), text or a conversation, and refuses images', async () => {
    const content = new MemoryContent();
    const { answer } = modalHub(content);
    const { access, models } = scriptedHub([], answer);
    const provider = new HarnessProvider({ hub: access, content, run });
    const questions = { relevant: { type: 'predicate' as const, instructions: 'Is it about files?' } };

    const decided = await provider.decide({ input: 'read the readme', questions }, { metadata: { harness: { model: { model: 'vendor/judge' } } } });
    expect(decided).toEqual({ answers: { relevant: { type: 'predicate', probability: 0.75 } }, model: 'vendor/judge', usage: { cost: 0.003 } });
    expect(models[0]).toEqual({ modality: 'decide', input: 'read the readme', questions, model: { model: 'vendor/judge' }, run });

    // with no model named the hub's decide role answers; a conversation crosses as wire messages
    const ai = await hubAiOf({ hub: access, content, run });
    const viaAi = await ai.decide.get({ input: [{ role: 'user', content: 'hi' }], questions });
    expect(viaAi.answers).toEqual({ relevant: { type: 'predicate', probability: 0.75 } });
    expect(models[1]).toMatchObject({ modality: 'decide', input: [{ role: 'user', content: 'hi' }] });
    await expect(provider.decide({ input: 'x', questions, images: ['data:image/png;base64,AA=='] }, {})).rejects.toThrow(/no images/);
  });

  it('refuses an answer of another modality', async () => {
    const { access } = scriptedHub([], () => ({ modality: 'embed', vectors: [], call, cost: 0, model: 'x' }));
    await expect(new HubModels(new HubModelLink(access)).image({ prompt: 'x' })).rejects.toThrow(/image call with embed/);
  });
});
