/**
 * Holding a prompt to its budget when it is tight: trimming the current exchange in its order (the hub's notes, older
 * tool results, the newest one) before refusing, the suggest contextor's auto-injected context within its caps, and
 * the plain contextor leaving out loaded context that won't fit instead of refusing the turn.
 */
import { agent, g } from '@harness/sdk';
import { mintId, type ContextorConfig, type LlmMessage, type Session, type Turn } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { ALICE, ALICE_INFO, OPEN_LIMITS } from '../execution/testing.ts';
import { textOf } from './history.ts';
import { PromptTooLarge } from './planner.ts';
import { contextorRig, contextRecord } from './testing.ts';

const SESSION = mintId('session', () => 'fit');
const chat = agent({ description: 'Chat.', args: g.obj({}), returns: g.text(), instructions: 'Be brief.', tools: [] });

/** A planner over a small window, and a plan of a transcript ending in the current exchange. */
async function planning(patch: Partial<Session> = {}, window = 2_048) {
  const r = await contextorRig({ models: [{ id: 'small', provider: 'openrouter', name: 'small', contextWindow: window, capabilities: ['chat', 'tools'] }] });
  const agentRecord = r.catalog.addFn('hub/chat', chat);
  const session = await r.store.table('sessions').insert({
    id: SESSION, title: 'T', owner: ALICE, agent: 'hub/chat', participants: [], systems: 'all', tools: [], context: [], status: 'idle', transcript: [],
    createdAt: 0, updatedAt: 0, archived: false, ...patch,
  });
  const turn: Turn = {
    id: mintId('turn', () => 'fit'), actor: ALICE, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running', limits: OPEN_LIMITS, cost: 0,
    errors: 'feed-back', createdAt: 0, session: SESSION,
  };
  const plan = (transcript: LlmMessage[]) => r.planner.plan({ session, turn, agent: agentRecord, model: 'small', instructions: 'Be brief.', transcript });
  return { r, plan };
}

/** What the budget allows a request: window − output − reasoning − margin. */
function available(budget: { window: number; output: number; reasoning: number; margin: number }): number {
  return budget.window - budget.output - budget.reasoning - budget.margin;
}

/** An assistant message calling a tool, and the tool's reply. */
function toolRound(id: string, result: string): LlmMessage[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, name: 'fs__read', arguments: `{"path":"${id}.md"}` }] },
    { role: 'tool', toolCallId: id, content: result },
  ];
}

const WORDS = 'Please summarise what you found.';

describe('trimming the current exchange to the budget', () => {
  it('first leaves out the hub\'s notes on the person\'s message, keeping their words', async () => {
    const { plan } = await planning();
    const notes = `<suggested_fns>\n${'- fs/read — Read a text file.\n'.repeat(400)}</suggested_fns>`;
    const planned = await plan([{ role: 'user', content: `${WORDS}\n${notes}` }]);
    expect(planned.report.budget.cut.map((c) => c.what)).toEqual(['the hub\'s notes on the message']);
    expect(planned.messages.map(textOf)).toEqual([WORDS]);
    expect(planned.estimate).toBeLessThanOrEqual(available(planned.report.budget));
  });

  it('then shortens the turn\'s older tool results, leaving the newest whole when that is enough', async () => {
    const { plan } = await planning();
    const big = 'line of a long file\n'.repeat(150);
    const planned = await plan([{ role: 'user', content: WORDS }, ...toolRound('a', big), ...toolRound('b', big), ...toolRound('c', 'short answer')]);
    expect(planned.report.budget.cut.map((c) => c.what)).toEqual(['the hub\'s notes on the message', '2 earlier tool results of this turn']);
    const results = planned.messages.filter((m) => m.role === 'tool').map(textOf);
    expect(results[0]?.length).toBeLessThan(big.length);
    expect(results[1]?.length).toBeLessThan(big.length);
    expect(results[2]).toBe('short answer');
    expect(textOf(planned.messages[0] ?? { role: 'user', content: '' })).toBe(WORDS);
    expect(planned.estimate).toBeLessThanOrEqual(available(planned.report.budget));
  });

  it('then shortens the newest result too, in that order, and the request fits', async () => {
    const { plan } = await planning();
    const big = 'line of a long file\n'.repeat(150);
    const huge = 'the newest result\n'.repeat(600);
    const planned = await plan([{ role: 'user', content: WORDS }, ...toolRound('a', big), ...toolRound('b', huge)]);
    expect(planned.report.budget.cut.map((c) => c.what)).toEqual(['the hub\'s notes on the message', '1 earlier tool results of this turn', 'the newest tool result']);
    const results = planned.messages.filter((m) => m.role === 'tool').map(textOf);
    expect(results[1]?.length).toBeLessThan(huge.length);
    expect(textOf(planned.messages[0] ?? { role: 'user', content: '' })).toBe(WORDS);
    // the call and its reply still travel together
    expect(planned.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(planned.estimate).toBeLessThanOrEqual(available(planned.report.budget));
  });

  it('refuses only when even the person\'s own words won\'t fit, saying both numbers', async () => {
    const { plan } = await planning();
    const words = 'word '.repeat(4_000);
    const refused = await plan([{ role: 'user', content: words }, ...toolRound('a', 'x'.repeat(5_000))]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PromptTooLarge);
    expect(refused instanceof PromptTooLarge ? refused.report.cut.map((c) => c.what) : []).toEqual(['the hub\'s notes on the message', 'the newest tool result']);
    expect(refused instanceof PromptTooLarge ? refused.message : '').toMatch(/^This message is about [\d,]+ tokens; small takes [\d,]+ here\./);
  });
});

describe('the suggest contextor\'s auto-injected context', () => {
  const suggest = (autoInject: { items: number; tokens: number }): ContextorConfig => ({ type: 'suggest', topN: 6, autoInject });

  /** Context the index finds for the message: two that can be injected, one only people get, one not suggested, one dynamic. */
  async function rig(autoInject: { items: number; tokens: number }, patch: Partial<Session> = {}) {
    const p = await planning({ contextor: suggest(autoInject), ...patch }, 8_192);
    const { catalog, search } = p.r;
    catalog.addContext(contextRecord('fs/git', { description: 'Using git.', content: 'Commit with fs/git_commit.' }));
    catalog.addContext(contextRecord('fs/style', { description: 'House style.', content: `Write plainly. ${'More rules. '.repeat(40)}` }));
    catalog.addContext(contextRecord('fs/people', { description: 'For people.', content: 'Only people read this.', suggest: 'user' }));
    catalog.addContext(contextRecord('fs/quiet', { description: 'Never suggested.', content: 'Quiet.', suggest: 'none' }));
    catalog.addContext(contextRecord('fs/tree', { description: 'The tree, written when used.' }));
    search.hits = ['fs/people', 'fs/quiet', 'fs/tree', 'fs/git', 'fs/style'].map((key, i) => ({ kind: 'context', key, rank: 1 - i / 10, similarity: 1 - i / 10, text: key }));
    return p;
  }

  it('puts the best matches in full, skipping what isn\'t for the model and what has no text yet', async () => {
    const { plan } = await rig({ items: 3, tokens: 2_000 });
    const planned = await plan([{ role: 'user', content: 'how do I commit?' }]);
    expect(planned.report.context.map((c) => c.name)).toEqual(['fs/git', 'fs/style']);
    expect(planned.context).toContain('<context name="fs/git">\nCommit with fs/git_commit.\n</context>');
  });

  it('keeps to its number of items and its tokens', async () => {
    expect((await (await rig({ items: 1, tokens: 2_000 })).plan([{ role: 'user', content: 'commit?' }])).report.context.map((c) => c.name)).toEqual(['fs/git']);
    // the style guide is too long for 40 tokens, so only the short item goes in
    expect((await (await rig({ items: 3, tokens: 40 })).plan([{ role: 'user', content: 'commit?' }])).report.context.map((c) => c.name)).toEqual(['fs/git']);
    expect((await (await rig({ items: 0, tokens: 2_000 })).plan([{ role: 'user', content: 'commit?' }])).report.context).toEqual([]);
  });

  it('leaves out what the session already loaded, which is shown once', async () => {
    const { plan } = await rig({ items: 3, tokens: 2_000 }, { context: ['fs/git'] });
    const planned = await plan([{ role: 'user', content: 'commit?' }]);
    expect(planned.report.context.map((c) => c.name)).toEqual(['fs/git', 'fs/style']);
    expect(planned.context.split('<context name="fs/git">')).toHaveLength(2);
  });

  it('injects nothing for an empty message, and keeps within what the budget leaves', async () => {
    const { plan, r } = await rig({ items: 3, tokens: 100_000 });
    expect((await plan([{ role: 'user', content: '   ' }])).report.context).toEqual([]);
    r.catalog.addContext(contextRecord('fs/huge', { description: 'Huge.', content: 'big '.repeat(10_000) }));
    r.search.hits = [{ kind: 'context', key: 'fs/huge', rank: 1, similarity: 1, text: 'huge' }, { kind: 'context', key: 'fs/git', rank: 0.5, similarity: 0.5, text: 'git' }];
    const planned = await plan([{ role: 'user', content: 'tell me' }]);
    expect(planned.report.context.map((c) => c.name)).toEqual(['fs/git']);
    expect(planned.estimate).toBeLessThanOrEqual(available(planned.report.budget));
  });
});

describe('the plain contextor over a small window', () => {
  it('leaves out loaded context that won\'t fit, reporting it, instead of refusing the turn', async () => {
    const { r, plan } = await planning({ context: ['fs/big', 'fs/small'] });
    r.catalog.addContext(contextRecord('fs/big', { content: 'lots of words '.repeat(1_000) }));
    r.catalog.addContext(contextRecord('fs/small', { content: 'A short note.' }));
    const planned = await plan([{ role: 'user', content: 'hello' }]);
    expect(planned.report.context.map((c) => c.name)).toEqual(['fs/small']);
    expect(planned.report.budget.cut).toContainEqual({ what: 'fs/big', why: 'left out to fit the model\'s window' });
    expect(planned.report.budget.pools.context.asked).toBeGreaterThan(planned.report.budget.pools.context.got);
    expect(planned.estimate).toBeLessThanOrEqual(available(planned.report.budget));
  });
});
