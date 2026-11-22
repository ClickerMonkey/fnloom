/**
 * The one fn name everywhere the model reads (plan `injected-context-2026-11-22`, slice D): a full chat prompt (the
 * chat agent's instructions, its tools, the systems list and guide), a person's message carrying every block the hub
 * and hooks add, a tool reply and a background result, in tools mode and in static mode, hold no fn in its `system/name`
 * form, example fn names no fn holds included (`database/main.overdue_invoices`, by the rule). Context keys
 * (`database/guide`), kinds, types and hook tags keep theirs.
 */
import { agent, g, hub, manifestOf, type AnyFnDef } from '@harness/sdk';
import { IDS, isFnShaped, SystemName, mintId, modelFnName, QualifiedName, type ChatMessage, type LlmMessage, type Session, type Turn } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { ALICE, ALICE_INFO, OPEN_LIMITS } from '../execution/testing.ts';
import { chatWorld } from '../chat/testing.ts';
import { REPLACED_BY_STATIC } from './modes.ts';
import { chatModel, contextorRig, contextRecord } from './testing.ts';

const q = (name: string): QualifiedName => QualifiedName.parse(name);
const SESSION = mintId('session', () => 'names');

/** Every hub fn, by qualified name, with its declaration. */
const HUB_FNS: ReadonlyArray<[QualifiedName, AnyFnDef]> = Object.entries(hub.defs.fns).map(([local, def]): [QualifiedName, AnyFnDef] => [q(`hub/${local}`), def]);
/** Some fns of systems the message and the context name. */
const SYSTEM_FNS = ['fs/read', 'fs/write', 'database/create_table', 'input/get_input', 'widgets/make_widget'].map(q);

/** The instructions the hub's own chat agent is declared with (its `CHAT_BASE` or `CHAT_SMALL_BASE`). */
async function instructionsOf(local: 'chat' | 'chat_small'): Promise<string> {
  const payload: unknown = (await manifestOf(hub, { version: '0.0.0' })).fns.find((decl) => decl.name === local)?.payload;
  const instructions: unknown = typeof payload === 'object' && payload !== null && 'instructions' in payload ? payload.instructions : undefined;
  if (typeof instructions !== 'string') throw new Error(`hub/${local} has no instructions`);
  return instructions;
}

/** A person's message with every block type, as the enricher renders it (qualified names, as stored). */
async function everyBlock(): Promise<string> {
  const w = await chatWorld();
  const message: ChatMessage = {
    id: IDS.message.parse('msg_1'), session: IDS.session.parse('ses_1'), turn: IDS.turn.parse('trn_1'), author: IDS.actor.parse('act_ada'), role: 'user', runs: [], status: 'done',
    replyAll: false, answerers: [], createdAt: 0,
    parts: [
      { type: 'systems-changed', on: [{ name: SystemName.parse('fs'), reason: 'installed', description: 'Files: read them with fs/read.' }], off: [] },
      { type: 'text', text: 'Please save it with fs/write, like database/main.overdue_invoices or input/trip_details, then ' },
      { type: 'mention', provider: 'fs/files', label: 'a.md', target: { path: 'a.md' }, text: 'The file a.md.' },
      { type: 'command', context: 'fs/plan', args: {} },
      { type: 'invocation', run: IDS.run.parse('run_1'), fn: 'fs/read' },
      { type: 'file', ref: { hash: 'a'.repeat(64), size: 3, mime: 'application/pdf' }, name: 'q.pdf', uri: 'hub://resources/uploads/q.pdf' },
      { type: 'extra', extra: 'local-time', blocks: [{ type: 'text', tag: 'now', text: 'Saturday 09:30' }] },
      { type: 'extra', extra: 'suggested-fns', blocks: [{ type: 'suggest-fns', items: [{ fn: 'database/create_table', why: 'Makes a table; then widgets/make_widget shows it.', score: 1 }] }] },
      { type: 'extra', extra: 'suggested-context', blocks: [{ type: 'suggest-context', items: [{ context: 'database/guide', why: 'How tables work (see input/get_input).', score: 1 }] }] },
      { type: 'hook', hook: 'fs/git', blocks: [{ type: 'text', tag: 'branch', text: 'main' }, { type: 'load', context: ['fs/guide'], fns: ['fs/read'] }] },
      { type: 'input-answer', run: IDS.run.parse('run_9'), title: 'Trip', value: {}, text: 'days: 3' },
      {
        type: 'loaded-for-you', by: 'decision',
        fns: [{ fn: 'hub/fns_examples', label: 'Examples', why: 'Shows hub/fns_get examples.' }],
        context: [{ context: 'database/guide', title: 'Tables', text: 'Make one with fn:database/create_table, then load with hub/fns_load.', fns: ['database/create_table'] }],
      },
    ],
  };
  return w.chat.enrich.render(message);
}

/** A rig with every hub fn, the systems' fns, the chat agents and a context item that names fns. */
async function planning(agentName: 'hub/chat' | 'hub/chat_small', instructions: string, transcript: LlmMessage[]) {
  const r = await contextorRig({ models: [chatModel('big', { contextWindow: 200_000 })] });
  // the hub's native fns as declared (a kind's fn, an agent, by name only)
  for (const [name, def] of HUB_FNS) r.catalog.addFn(name, ...(def.kind === 'native' ? [def] : []));
  for (const name of SYSTEM_FNS) r.catalog.addFn(name);
  const record = r.catalog.addFn(q(agentName), agent({
    description: 'The chat.', args: g.obj({}), returns: g.text(), instructions,
    mode: agentName === 'hub/chat_small' ? { type: 'static' } : { type: 'tools' },
    tools: agentName === 'hub/chat_small' ? [] : [hub.fns.fns_search, hub.fns.fns_load, hub.fns.fns_drop, hub.fns.ctx_search, hub.fns.ctx_load, hub.fns.ctx_drop],
  }));
  for (const name of RESERVED) r.catalog.reserved.add(name);
  r.catalog.addContext(contextRecord(q('database/guide'), { description: 'Tables: make one with database/create_table.', content: 'Use fn:database/create_table, then hub/fns_load it. See context:database/guide.' }));
  const session = await r.store.table('sessions').insert({
    id: SESSION, title: 'T', owner: ALICE, agent: q(agentName), participants: [], systems: 'all', tools: [], context: [q('database/guide')], status: 'idle', transcript,
    createdAt: 0, updatedAt: 0, archived: false,
  } satisfies Session);
  const turn: Turn = {
    id: mintId('turn', () => 'names'), actor: ALICE, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running', limits: OPEN_LIMITS, cost: 0,
    errors: 'feed-back', createdAt: 0, session: SESSION,
  };
  return r.planner.plan({ session, turn, agent: record, model: 'big', instructions, transcript });
}

/** Every text of a planned prompt the model reads. */
function promptTexts(planned: Awaited<ReturnType<typeof planning>>): string[] {
  return [
    planned.instructions, planned.context, planned.injectedContext,
    ...planned.messages.flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.map((part) => part.content))),
    ...planned.tools.flatMap((tool) => [tool.name, tool.description, tool.instructions ?? '', tool.spec.description ?? '', JSON.stringify(tool.spec.parameters)]),
  ];
}

/** The systems the rig has installed, and the context keys, kinds and hook and mention names, which keep their `/`. */
const SYSTEMS = new Set(['hub', 'fs', 'database', 'input', 'widgets']);
const RESERVED = ['database/guide', 'fs/guide', 'fs/plan', 'hub/llm', 'database/query', 'input/form', 'widgets/widget'];

/** A `system/name` token standing alone (as `ModelFnNames.text` reads them). */
const SLASH_NAME = /(?<![A-Za-z0-9_./:-])([a-z][a-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*)/g;

/**
 * The fn names still written in their `system/name` form, known fns and example ones alike (any fn-shaped name of an
 * installed system that is no context key, kind or hook), or as an unrendered `fn:` ref.
 */
function leftovers(texts: readonly string[]): string[] {
  const fns = new Set<string>([...HUB_FNS.map(([name]) => name), ...SYSTEM_FNS]);
  const reserved = new Set(RESERVED);
  return texts.flatMap((text) => [
    ...[...text.matchAll(SLASH_NAME)].flatMap((match) => {
      const name = (match[1] ?? '').replace(/[.-]+$/, '');
      const parsed = QualifiedName.safeParse(name);
      // an attribute's value (a mention's `provider="fs/files"`) is a fn only when it is a known one
      const inAttribute = text.slice(Math.max(0, match.index - 2), match.index) === '="';
      return parsed.success && (fns.has(name) || (!inAttribute && isFnShaped(parsed.data, SYSTEMS, reserved))) ? [name] : [];
    }),
    ...(text.match(/\bfn:[a-z][\w-]*\/\S+/g) ?? []),
  ]);
}

describe('no fn reaches the model in its system/name form', () => {
  it('in tools mode: the chat prompt, its tools, a message with every block, a tool reply and a background result', async () => {
    const message = await everyBlock();
    const transcript: LlmMessage[] = [
      { role: 'user', content: 'Earlier: what does hub/fns_search do?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: modelFnName(hub.fns.fns_search.name), arguments: '{"text":"read"}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'Found fs/read. Load it with hub/fns_load.' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: '<background-result run="run_2" fn="fs/read">Read with fs/read.</background-result>' },
      { role: 'user', content: message },
    ];
    const instructions = await instructionsOf('chat');
    // what goes in names fns the qualified way: the check below is not empty-handed
    expect(leftovers([message]).length).toBeGreaterThan(5);
    const planned = await planning('hub/chat', instructions, transcript);
    const texts = promptTexts(planned);
    expect(planned.messages.some((m) => typeof m.content === 'string' && m.content.includes('<loaded_for_you>'))).toBe(true);
    expect(leftovers(texts)).toEqual([]);
    const all = texts.join('\n');
    // fns read as the model calls them; context keys keep their form
    expect(all).toContain('fs__write');
    expect(all).toContain(modelFnName(hub.fns.resource_read.name));
    expect(all).toContain('database__create_table');
    expect(all).toContain('database/guide');
    // example fn names no fn holds read the same way
    expect(all).toContain('database__main__overdue_invoices');
    expect(all).toContain('input__trip_details');
    expect(planned.tools.map((tool) => tool.name)).toContain('hub__fns_search');
  });

  it('in static mode, the hub fns behind the static tools read as find, find_ctx, inspect, load and unload', async () => {
    const planned = await planning('hub/chat_small', await instructionsOf('chat_small'), [{ role: 'user', content: await everyBlock() }]);
    const texts = promptTexts(planned);
    expect(leftovers(texts)).toEqual([]);
    const all = texts.join('\n');
    for (const fn of REPLACED_BY_STATIC) expect(all).not.toContain(modelFnName(q(fn)));
    expect(planned.tools.map((tool) => tool.name)).toEqual(['find', 'find_ctx', 'inspect', 'load', 'unload', 'run']);
    expect(all).toContain('database__create_table');
  });
});
