/**
 * Chat modes and contextors on the real stack.
 *
 * - The static toolset with a free OpenRouter model: the model is sent exactly the five fixed tools, runs `fs/read`
 *   by name through `run`, and the run in the tree is `fs/read` itself, never a wrapper. Each chat call is a
 *   `ModelCall` and an LLM interaction pointing at each other.
 * - The graph contextor with a model on the local Ollama (skipped when Ollama doesn't answer or has none of
 *   `HARNESS_E2E_OLLAMA_MODELS`): with a small window, every request the hub sends fits it. The planner's estimate
 *   stays within the budget it reports, Ollama's own count of the prompt (`prompt_eval_count`, the call's input
 *   tokens) stays within the window less the reply, and `maxTokens` is set on every request to the reply's reserve
 *   (its output, and for a reasoning model its thinking).
 */
import { QualifiedName, STATIC_TOOLS, type LlmInteraction, type ModelCall, type SessionId, type TurnId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { admin, ask, runsOf, SessionWatch, settings, settle, textOf } from './kit.ts';

const READ = QualifiedName.parse('fs/read');
const SMALL_AGENT = QualifiedName.parse('hub/chat_small');

let me: SignedIn;

beforeAll(async () => {
  me = await admin();
  await settle(me);
});

afterAll(() => { me.close(); });

/** The chat model calls of a turn's agent run, with their interactions. */
async function chatCallsOf(session: SessionId, turn: TurnId): Promise<Array<{ call: ModelCall; interaction: LlmInteraction }>> {
  const calls = (await me.hub.call('modelCalls', { session, modality: 'chat', limit: 50 })).items.filter((call) => call.turn === turn);
  return Promise.all(calls.map(async (call) => {
    if (call.interaction === undefined) { throw new Error(`model call ${call.id} has no interaction`); }
    return { call, interaction: await me.hub.call('llmCall', { id: call.interaction }) };
  }));
}

describe('the static toolset with a free model', () => {
  let session: SessionId;
  let watch: SessionWatch;

  beforeAll(async () => {
    session = (await me.hub.call('createSession', { title: 'e2e static' })).id;
    await me.hub.call('updateSession', { session, mode: { type: 'static', protocol: 'native', placement: 'system-end', loadDetail: 'full' }, contextor: { type: 'plain' } });
    watch = new SessionWatch(me, session);
  });

  afterAll(() => { watch.stop(); });

  it('runs fs/read by name with the run tool, as a run of fs/read itself', async () => {
    const { turn, answer } = await ask(me, watch, 'Use the run tool to run the fn fs/read with the args {"path": "README.md", "limit": 5}, then tell me the first heading of the file.', settings.HARNESS_E2E_TURN_TIMEOUT);
    expect(answer.status).toBe('done');
    expect(textOf(answer)).toMatch(/harness/i);
    const tree = await me.hub.call('tree', { turn });
    const runs = runsOf(tree).map((node) => node.run);
    expect(runs.some((run) => run.fn === READ && run.status === 'done')).toBe(true);
    expect(runs.map((run) => run.fn)).not.toContain('run');

    const calls = await chatCallsOf(session, turn);
    expect(calls.length).toBeGreaterThan(0);
    for (const { call, interaction } of calls) {
      // exactly the five fixed tools, whatever fns are loaded
      expect(interaction.request.tools?.map((tool) => tool.name).sort()).toEqual([...STATIC_TOOLS].sort());
      expect(interaction.modelCall).toBe(call.id);
      expect(call).toMatchObject({ modality: 'chat', status: 'done', session });
      expect(call.units.modality === 'chat' ? call.units.input : 0).toBeGreaterThan(0);
      expect(interaction.selection).toMatchObject({ mode: 'static', contextor: 'plain' });
    }
  });
});

/** What Ollama lists. */
const OllamaTags = z.object({ models: z.array(z.object({ name: z.string() })) });

/** The first configured local model Ollama has, or undefined when it doesn't answer. */
async function localModel(): Promise<string | undefined> {
  try {
    const tags = OllamaTags.parse(await (await fetch(`${settings.HARNESS_E2E_OLLAMA}/api/tags`)).json());
    const have = new Set(tags.models.map((m) => m.name));
    return settings.HARNESS_E2E_OLLAMA_MODELS.split(',').map((m) => m.trim()).find((m) => have.has(m));
  } catch {
    return undefined;
  }
}

const local = await localModel();

describe.skipIf(local === undefined)('the graph contextor on a small local model', () => {
  const model = `ollama/${local ?? ''}`;
  const OUTPUT = 512;
  let window = 0;
  let session: SessionId;
  let watch: SessionWatch;
  const turns: TurnId[] = [];

  beforeAll(async () => {
    await me.hub.call('configureProvider', { provider: 'ollama', baseURL: settings.HARNESS_E2E_OLLAMA });
    await waitFor(`${model} to be offered`, async () => ((await me.hub.call('capabilities', {})).models.some((m) => m.provider === 'ollama' && m.id === local) ? true : undefined), { timeout: 60_000 });
    // the window is what Ollama serves the model with (its probe); the reply gets a small share
    const [probed] = await me.hub.call('modelLimits', { model });
    window = probed?.limits.contextWindow ?? 0;
    await me.hub.call('setModelLimits', { model, limits: { maxOutputTokens: OUTPUT } });
    session = (await me.hub.call('createSession', { title: 'e2e graph', agent: SMALL_AGENT })).id;
    await me.hub.call('updateSession', { session, model: { model } });
    watch = new SessionWatch(me, session);
  });

  afterAll(() => { watch.stop(); });

  it('uses the static toolset and the graph contextor, within the model’s served window', async () => {
    expect(window).toBeGreaterThanOrEqual(1_024);
    expect(window).toBeLessThanOrEqual(32_768);
    const [limits] = await me.hub.call('modelLimits', { model });
    expect(limits?.limits.maxOutputTokens).toBe(OUTPUT);
    const preview = await me.hub.call('previewSelection', { session, text: 'How many lines does README.md have?' });
    expect(preview).toMatchObject({ mode: 'static', contextor: 'graph' });
    expect(preview.budget.estimate).toBeLessThanOrEqual(preview.budget.window - preview.budget.output - preview.budget.reasoning - preview.budget.margin);
  });

  for (const text of ['How many lines does README.md have? Use fs/read.', 'And what is the first heading in it?']) {
    it(`answers “${text}” with every request inside the window`, async () => {
      const { turn } = await ask(me, watch, text, settings.HARNESS_E2E_LOCAL_TURN_TIMEOUT);
      turns.push(turn);
      const calls = await chatCallsOf(session, turn);
      expect(calls.length).toBeGreaterThan(0);
      for (const { call, interaction } of calls) {
        const budget = interaction.selection?.budget;
        if (budget === undefined) { throw new Error(`interaction ${interaction.id} has no budget report`); }
        expect(budget.window).toBe(window);
        expect(budget.estimate).toBeLessThanOrEqual(budget.window - budget.output - budget.reasoning - budget.margin);
        // the reply's reserve is the output asked for (with half kept for thinking on a reasoning model) and its thinking
        expect(budget.output).toBeLessThanOrEqual(OUTPUT);
        expect(interaction.request.maxTokens).toBe(budget.output + budget.reasoning);
        // what Ollama itself counted, when it said
        const input = call.units.modality === 'chat' ? call.units.input : 0;
        expect(input).toBeLessThanOrEqual(window - budget.output - budget.reasoning);
        expect(interaction.selection).toMatchObject({ mode: 'static', contextor: 'graph' });
      }
    }, settings.HARNESS_E2E_LOCAL_TURN_TIMEOUT + 60_000);
  }
});
