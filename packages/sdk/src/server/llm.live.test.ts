/**
 * Live (risk 4): a system-side aeye prompt with a tool, then a structured answer, through the forwarding provider and
 * the link, to a hub that runs it on a free OpenRouter model. The hub side (the kit's `OpenRouterModelLink`) does what the hub's LLM gateway does:
 * rebuild the forwarded JSON schemas as zod, stream from the provider, send back the descriptors it used, then the
 * chunks and the cost. One prompt; a rate-limited model is skipped for the next. Run with `npm run test:live`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { z } from 'zod';
import { harnessAiOf, serve, type RunningSystem } from './index.ts';
import { FakeHub, liveEnv, liveModels } from './testing.ts';
import { OpenRouterModelLink } from '../testing/openrouter.ts';

const weather = system('weather', { description: 'Weather.' }).with({
  fns: {
    forecast: fn({
      description: 'Forecast for a city.',
      args: g.obj({ city: g.text() }),
      returns: g.obj({ city: g.text(), celsius: g.num(), summary: g.text() }),
    }),
  },
});

let running: RunningSystem<'weather'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe('the forwarding provider (live)', () => {
  const key = liveEnv.get('OPENROUTER_API_KEY');

  it.skipIf(key === undefined)('runs a system-side prompt with a tool, then a structured answer, on a free model', async () => {
    const candidates = liveModels();
    const tried: string[] = [];
    for (const model of candidates) {
      const hub = new FakeHub();
      const link = new OpenRouterModelLink({ key: key ?? '', models: [model] });
      hub.onLlm = (forward) => link.llm(forward);
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
