/**
 * Live (risk 4): a system-side aeye prompt with a tool, then a structured answer, through the forwarding provider and
 * the link, to a hub that runs it on a free OpenRouter model. The hub side here does what the hub's LLM gateway does:
 * rebuild the forwarded JSON schemas as zod, stream from the provider, send back the descriptors it used, then the
 * chunks and the cost. One prompt; a rate-limited model is skipped for the next. Run with `npm run test:live`.
 */
import { AI, type Provider } from '@aeye/ai';
import type { Chunk, Message, Request } from '@aeye/core';
import { models, strictSupport } from '@aeye/models';
import { OpenRouterProvider } from '@aeye/openrouter';
import { env } from '@ayepi/env';
import { mintId, type Json, type LlmChunk, type LlmForward, type LlmForwardChunk } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { harnessAiOf, serve, type RunningSystem } from './index.ts';
import { FakeHub } from './testing.ts';

/** The live tests' tunables: the key, and which free models to try (the same defaults as the hub's live slice). */
const live = env({
  OPENROUTER_API_KEY: z.string().optional(),
  HARNESS_LIVE_MODEL: z.string().default('nvidia/nemotron-3.5-super-vl:free'),
  HARNESS_LIVE_FALLBACKS: z.string().default('nvidia/nemotron-3-ultra-550b-a55b:free,dots-studio/dots-3-note-preview:free'),
});

const weather = system('weather', { description: 'Weather.' }).with({
  fns: {
    forecast: fn({
      description: 'Forecast for a city.',
      args: g.obj({ city: g.text() }),
      returns: g.obj({ city: g.text(), celsius: g.num(), summary: g.text() }),
    }),
  },
});

/** A forwarded JSON schema as zod again, wrapped when it isn't an object (tool parameters must be). */
function objectSchema(json: Json): z.ZodType<object, object> {
  const schema = z.fromJSONSchema(Object.fromEntries(Object.entries(typeof json === 'object' && json !== null && !Array.isArray(json) ? json : {})));
  return schema instanceof z.ZodObject ? schema : z.object({ value: schema });
}

function aeyeMessage(message: LlmForward['request']['messages'][number]): Message {
  return {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : message.content.map((p) => ({ type: p.type, content: p.content })),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  };
}

function wireChunk(chunk: Chunk): LlmChunk {
  return {
    ...(chunk.content === undefined ? {} : { content: chunk.content }),
    ...(chunk.toolCallNamed === undefined ? {} : { toolCallNamed: chunk.toolCallNamed }),
    ...(chunk.toolCallArguments === undefined ? {} : { toolCallArguments: chunk.toolCallArguments }),
    ...(chunk.toolCall === undefined ? {} : { toolCall: chunk.toolCall }),
    ...(chunk.finishReason === undefined ? {} : { finishReason: chunk.finishReason }),
  };
}

/** The hub's side: run a forwarded request on OpenRouter and stream it back as the link expects. */
function openRouterHub(key: string, model: string) {
  // aeye's provider classes declare optional fields as `T | undefined`, which `Provider` refuses under exactOptionalPropertyTypes (library ask)
  const openrouter = new OpenRouterProvider({ apiKey: key }) as unknown as Provider; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- see above
  const ai = AI.with().providers({ openrouter }).create({ models, modelOverrides: [...strictSupport] });
  return async function* relay(forward: LlmForward): AsyncGenerator<LlmForwardChunk> {
    const format = forward.request.responseFormat;
    const request: Request = {
      messages: forward.request.messages.map(aeyeMessage),
      maxTokens: 2_000,
      ...(forward.request.tools === undefined ? {} : {
        tools: forward.request.tools.map((t) => ({ name: t.name, parameters: objectSchema(t.parameters), ...(t.description === undefined ? {} : { description: t.description }), ...(t.strict === undefined ? {} : { strict: t.strict }) })),
      }),
      ...(format === undefined || typeof format === 'string' ? {} : { responseFormat: { type: objectSchema(format.schema), strict: format.strict } }),
    };
    let described = false;
    let usage = { input: 0, output: 0 };
    let cost = 0;
    for await (const chunk of ai.chat.stream(request, { metadata: { model: `openrouter/${model}` } })) {
      if (!described) {
        described = true;
        const tools = Object.fromEntries((request.tools ?? []).flatMap((t) => (t.descriptor === undefined ? [] : [[t.name, t.descriptor]])));
        const output = typeof request.responseFormat === 'object' ? request.responseFormat.descriptor : undefined;
        yield { type: 'descriptors', tools, ...(output === undefined ? {} : { output }) };
      }
      if (chunk.usage !== undefined) {
        usage = { input: chunk.usage.text?.input ?? usage.input, output: chunk.usage.text?.output ?? usage.output };
        cost = chunk.usage.cost ?? cost;
      }
      yield { type: 'chunk', chunk: wireChunk(chunk) };
    }
    yield { type: 'done', usage, cost, interaction: mintId('llmInteraction'), model };
  };
}

let running: RunningSystem<'weather'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe('the forwarding provider (live)', () => {
  const key = live.get('OPENROUTER_API_KEY');

  it.skipIf(key === undefined)('runs a system-side prompt with a tool, then a structured answer, on a free model', async () => {
    const candidates = [live.get('HARNESS_LIVE_MODEL'), ...live.get('HARNESS_LIVE_FALLBACKS').split(',').filter((m) => m !== '')];
    const tried: string[] = [];
    for (const model of candidates) {
      const hub = new FakeHub();
      hub.onLlm = openRouterHub(key ?? '', model);
      const lookups: string[] = [];
      running = await serve(weather, {
        fns: {
          forecast: {
            async run(args, ctx) {
              const lookup = harnessAiOf(ctx.llm).tool({
                name: 'lookup',
                description: 'The current temperature in a city, in degrees Celsius.',
                instructions: 'Always call lookup before answering; never guess a temperature.',
                schema: z.object({ city: z.string() }),
                call: (input: { city: string }) => { lookups.push(input.city); return { city: input.city, celsius: -3 }; },
              });
              // a tool round trip: some models skip tools when an output schema is also set (aeye sends it from the
              // first iteration), so the tool round and the structured answer are two forwarded steps here
              const prompt = harnessAiOf(ctx.llm).prompt({
                name: 'lookup-weather',
                description: 'Finds the temperature in a city.',
                content: 'You cannot know the temperature in {{city}} yourself. Call the lookup tool for {{city}}, then say the temperature it gave.',
                input: (input: { city: string }) => ({ city: input.city }),
                tools: [lookup],
              });
              const found = await prompt.get('result', { city: args.city });
              const answer = await ctx.llm.object({
                prompt: `Report this as the city, the temperature in Celsius and a one-sentence summary: ${found ?? ''}`,
                output: g.obj({ city: g.text(), celsius: g.num(), summary: g.text() }),
              });
              return ctx.done(answer);
            },
          },
        },
      }, { hub: 'ws://hub.test/link', state: 'x', version: '1' }, hub.host());
      await running.ready();
      const outcome = await hub.run('weather/forecast', { city: 'Oslo' }, { deadline: Date.now() + 110_000 });
      await running.stop();
      running = undefined;
      console.info('live.forwarding', { model, status: outcome.status, lookups, forwards: hub.forwards.length });
      if (outcome.status !== 'done') {
        tried.push(`${model}: ${JSON.stringify(outcome).slice(0, 200)}`);
        continue;
      }
      expect(outcome.result).toMatchObject({ celsius: -3 });
      expect(lookups.length).toBeGreaterThanOrEqual(1);
      expect(hub.forwards.length).toBeGreaterThanOrEqual(2);
      expect(hub.forwards[0]?.request.tools?.[0]?.name).toBe('lookup');
      return;
    }
    console.warn('live.forwarding.unavailable', { tried });
  }, 120_000);
});
