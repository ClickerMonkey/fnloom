/**
 * Live: the agent loop on a real free OpenRouter model (risk 2's proof of concept, kept small). The model is asked a
 * question only a tool can answer; the tool call suspends the prompt and becomes a run on a connected system; the
 * next iteration continues from the saved transcript with the result and answers. Every call goes through the hub
 * AI's hooks, so the interactions and spend are saved. A rate-limited model (429) is skipped with a note rather
 * than failing. Run with `npm run test:live`.
 */
import { agent, fn, g, system } from '@harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { liveModels } from '@harness/sdk/server/testing';
import { modelEnv } from '../boot/env.ts';
import { messageOf } from './errors.ts';
import { openRouterProviders } from './providers.ts';
import { replyText } from './wire.ts';
import { AGENT, ALICE, executionRig, SESSION, testSettings, type ExecutionRig } from './testing.ts';

const SECRET = 'violet-heron-42';
const vault = system('vault', { description: 'A vault.' }).with({
  fns: { open: fn({ description: 'Open the vault and read the secret word inside it.', args: g.obj({ vault: g.text() }), returns: g.text(), tags: ['read'] }) },
});
const guard = agent({
  description: 'Answers questions about the vault.', args: g.obj({}), returns: g.text(), tools: [vault.fns.open], maxIterations: 4,
  instructions: 'You can only learn what is in a vault by calling the vault__open tool. Answer with just the secret word.',
});

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); });

describe('the agent loop (live)', () => {
  const key = modelEnv.get('OPENROUTER_API_KEY');
  it.skipIf(key === undefined)('suspends on a tool call, runs it, and answers in the next iteration', async () => {
    const models = liveModels();
    const tried: string[] = [];
    for (const model of models) {
      rig = await executionRig({
        settings: testSettings({ HARNESS_TURN_COST: 0.05 }, {}, model),
        llm: { providers: openRouterProviders(key) },
      });
      rig.catalog.add('vault', 'open', fn({ description: 'Open the vault and read the secret word inside it.', args: g.obj({ vault: g.text() }), returns: g.text(), tags: ['read'] }));
      rig.catalog.add('tools', 'helper', guard);
      await rig.module.start();
      const opened: string[] = [];
      rig.connect('vault').behaviour.run = (request) => { opened.push(JSON.stringify(request.args)); return Promise.resolve({ status: 'done', result: `The secret word is ${SECRET}.` }); };
      await rig.session();
      const turn = await rig.turn({ session: SESSION, text: 'What is the secret word in the blue vault?' });
      const { run } = await rig.module.agents.start({
        kind: 'hub/llm', fn: 'tools/helper', args: {}, turn: turn.id, session: SESSION, key: 'answer', actor: ALICE, caller: AGENT, priority: 'interactive', background: false, handlers: [],
      });
      const settled = await rig.module.runs.wait(run);
      const interactions = (await rig.store.table('llmInteractions').find({ where: { run }, limit: 10 })).items;
      if (settled.status === 'failed' && /429|rate|unavailable|provider/i.test(settled.error.message)) {
        tried.push(`${model}: ${settled.error.message}`);
        await rig.module.stop();
        rig = undefined;
        continue;
      }
      expect(settled, settled.status === 'failed' ? settled.error.message : '').toMatchObject({ status: 'done' });
      expect(opened.length).toBeGreaterThanOrEqual(1);
      expect(settled.status === 'done' ? replyText(settled.result, 5) : '').toContain(SECRET);
      expect(interactions.length).toBeGreaterThanOrEqual(2);
      expect(interactions.every((i) => i.status === 'done')).toBe(true);
      const transcript = (await rig.store.table('sessions').get(SESSION))?.transcript ?? [];
      expect(transcript.map((m) => m.role)).toEqual(expect.arrayContaining(['user', 'assistant', 'tool']));
      console.info('live.agent.answered', { model, iterations: interactions.length, cost: interactions.reduce((sum, i) => sum + i.cost, 0) });
      return;
    }
    console.warn('live.agent.unavailable', { tried: tried.map((t) => messageOf(t)) });
  });
});
