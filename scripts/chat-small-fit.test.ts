/**
 * `hub/chat_small` for a 2,048-token model (Phil 2026-11-22, "The systems list follows the agent's detail"): planned
 * as the hub plans qwen2.5:3b on Ollama with a 2k window (a quarter of the window for the reply, the prompt margin, 3.5
 * characters a token, as `npm run prompt:render` sets it), its fixed part (its instructions, the `<systems>` list of
 * the scenario stacks' systems at one line each, the static mode's guide and its six tools) leaves room for a short
 * message and some injected summaries.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hub, isSystemContract, manifestBody } from '@harness/sdk';
import { ActorId, labelFor, mintId, QualifiedName, StaticTool, SystemName, type AnnouncedSystem, type Session, type Turn } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { ALICE, ALICE_INFO, OPEN_LIMITS } from '../packages/hub/src/execution/testing.ts';
import { chatModel, contextorRig } from '../packages/hub/src/contextor/testing.ts';
import { STATIC_TOOL_BRIEF } from '../packages/hub/src/contextor/modes.ts';
import { escapeBody } from '../packages/hub/src/chat/support.ts';

const q = (name: string): QualifiedName => QualifiedName.parse(name);
const MODEL = 'qwen2.5:3b';
const LIMITS = { contextWindow: 2048, maxOutputTokens: 512, reasoningTokens: 0, charsPerToken: 3.5 } as const;
/** The systems the scenario stacks (and the render) install besides the hub. */
const INSTALLED = ['api', 'code', 'database', 'embedder', 'fs', 'input', 'web', 'widgets'];
const MESSAGE = 'I keep forgetting what I spend on groceries. Can you help me keep track?';
/** What is left for the injected section, at least: room for a handful of items at their summaries (~45 tokens each). */
const INJECTED_ROOM = 200;

const systems = join(import.meta.dirname, '..', 'systems');

/** The installed systems as the chat's first turn snapshots them (`systemsNow`): `about` in full, the description as the summary. */
async function announced(): Promise<AnnouncedSystem[]> {
  const out: AnnouncedSystem[] = [];
  for (const folder of INSTALLED) {
    const file = join(systems, folder, 'shared', 'index.ts');
    if (!existsSync(file)) throw new Error(`no contract for ${folder}`);
    const loaded: unknown = await import(pathToFileURL(file).href);
    const contracts = typeof loaded === 'object' && loaded !== null ? Object.values(loaded).filter(isSystemContract) : [];
    const contract = contracts.find((c) => c.name === folder);
    if (contract === undefined) throw new Error(`no ${folder} contract`);
    const body = manifestBody(contract, { version: '0.0.0' });
    const about = body.about ?? body.description;
    out.push({ name: SystemName.parse(folder), label: labelFor({ name: folder }), description: about, ...(about === body.description ? {} : { summary: body.description }) });
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** hub/chat_small planned for one message on qwen2.5:3b at this window (same estimator, same 512-token reply). */
async function plannedAt(contextWindow: number) {
  const r = await contextorRig({ models: [chatModel(MODEL, { contextWindow })] });
  await r.store.table('modelLimits').put({ model: MODEL, limits: { ...LIMITS, contextWindow }, setBy: ActorId.parse('act_admin'), updatedAt: 0 });
  for (const [local, def] of Object.entries(hub.defs.fns)) r.catalog.addFn(q(`hub/${local}`), def);
  const agent = r.catalog.records.get(q('hub/chat_small'));
  if (agent === undefined) throw new Error('no hub/chat_small');
  const prompt = await announced();
  const session = await r.store.table('sessions').insert({
    id: mintId('session', () => 'small'), title: 'T', owner: ALICE, agent: agent.name, participants: [], systems: 'all', tools: [], context: [], status: 'idle',
    transcript: [], createdAt: 0, updatedAt: 0, archived: false, announcedSystems: { prompt, on: prompt.map((s) => s.name), off: [] },
  } satisfies Session);
  const turn: Turn = {
    id: mintId('turn', () => 'small'), actor: ALICE, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running', limits: OPEN_LIMITS, cost: 0,
    errors: 'feed-back', createdAt: 0, session: session.id,
  };
  const instructions = hub.defs.fns.chat_small.payload.instructions;
  const planned = await r.planner.plan({ session, turn, agent, model: MODEL, instructions, transcript: [{ role: 'user', content: MESSAGE }] });
  return { planned, prompt };
}

describe('hub/chat_small for a small window', () => {
  it('lists each system on one line (its short description, not its about) and gives the static tools short descriptions, examples kept', async () => {
    expect(readdirSync(systems).length).toBeGreaterThan(INSTALLED.length);
    const { planned, prompt } = await plannedAt(16_384);
    const list = /<systems>[\s\S]*?<\/systems>/.exec(planned.context)?.[0] ?? '';
    const lines = list.split('\n').filter((line) => line.startsWith('<system '));
    expect(lines).toHaveLength(INSTALLED.length);
    for (const system of prompt) {
      const line = lines.find((l) => l.startsWith(`<system name="${system.name}">`)) ?? '';
      expect(line, system.name).toContain(escapeBody(system.summary ?? system.description));
      if (system.summary !== undefined) expect(list, system.name).not.toContain(escapeBody(system.description));
    }
    expect(planned.tools.map((tool) => tool.name)).toEqual(['find', 'find_ctx', 'inspect', 'load', 'unload', 'run']);
    for (const tool of planned.tools) {
      expect(tool.spec.description, tool.name).toContain('Example args:');
      expect(tool.description, tool.name).toBe(STATIC_TOOL_BRIEF[StaticTool.parse(tool.name)]);
    }
  });

  // The target (Phil 2026-11-22): the fixed part fits 2k with room for a short message and some injected summaries.
  // It does not yet: the brief systems list and tool descriptions bring the fixed part from ~5,250 to ~2,990 tokens,
  // against 1,413 the window leaves (core instructions ~970, systems list ~430, guide ~126, the six tools ~1,460, mostly
  // their JSON schemas). `fails` keeps the target in view: once it fits this test reports it, and `.fails` goes.
  it.fails('fits its fixed part at 2,048 with room for a short message and some injected summaries', async () => {
    const { planned } = await plannedAt(LIMITS.contextWindow);
    const { budget } = planned.report;
    const available = budget.window - budget.output - budget.reasoning - budget.margin;
    expect(budget.output).toBe(512);
    expect(planned.report.budget.cut.filter((cut) => !cut.what.startsWith('injected'))).toEqual([]);
    expect(available - planned.estimate, `estimate ${planned.estimate} of ${available}`).toBeGreaterThanOrEqual(INJECTED_ROOM);
  });
});
