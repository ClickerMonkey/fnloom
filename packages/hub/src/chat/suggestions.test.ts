import { HubOption, IDS, SuggestDecision, type Suggestion } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { candidateFor } from './suggestions.ts';
import { CLIENT, chatWorld } from './testing.ts';

const candidates: Suggestion[] = [
  { kind: 'fn', name: 'fs/read', description: 'Read a file.', score: 0.9 },
  { kind: 'context', name: 'fs/guide', description: 'How files work.', score: 0.5 },
  { kind: 'fn', name: 'fs/write', description: 'Write a file.', score: 0.1 },
];

async function world() {
  const w = await chatWorld();
  w.index.suggestions = candidates;
  w.index.hidden = [{ kind: 'fn', name: 'web/search', score: 0.8 }];
  return w;
}

describe('suggestions for a sent message', () => {
  it('by score: the best over the threshold are used, the rest say why not, and the message carries the record', async () => {
    const w = await world();
    const decided = await w.chat.suggestions.decide({ session: w.session.id, text: 'read the readme', actor: w.admin.id });
    expect(decided.suggestions.map((s) => s.name)).toEqual(['fs/read', 'fs/guide']);
    expect(decided.record).toEqual({
      by: 'score', threshold: 0.45, items: [
        { used: true, kind: 'fn', name: 'fs/read', score: 0.9 },
        { used: true, kind: 'context', name: 'fs/guide', score: 0.5 },
        { used: false, kind: 'fn', name: 'fs/write', score: 0.1, reason: 'below-threshold' },
        { used: false, kind: 'fn', name: 'web/search', score: 0.8, reason: 'rule' },
      ],
    });
    const { message } = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text: 'read the readme' }], client: CLIENT });
    expect(message.suggestions?.items).toHaveLength(4);
    expect(w.llm.asked).toHaveLength(0);
  });

  it('by an LLM: its picks are used, the rest declined with its reasons, its call linked', async () => {
    const w = await world();
    const value = SuggestDecision.parse({ by: 'llm', model: { model: { model: 'tiny' } }, floor: 0.3, messages: 2 });
    expect(await w.chat.suggestions.set(value, w.admin.id)).toMatchObject({ value, setBy: w.admin.id });
    await w.store.table('messages').insert({
      id: IDS.message.parse('msg_old'), session: w.session.id, turn: IDS.turn.parse('trn_old'), author: w.admin.id, role: 'user', parts: [{ type: 'text', text: 'we use files' }],
      runs: [], status: 'done', replyAll: false, answerers: [], createdAt: 0,
    });
    w.llm.answers = ['{"picks":[{"name":"fs/guide","reason":"explains files"}],"declined":[{"name":"fs/read","reason":"nothing to read yet"}]}'];
    const decided = await w.chat.suggestions.decide({ session: w.session.id, text: 'how do files work', actor: w.admin.id });
    expect(decided.suggestions.map((s) => s.name)).toEqual(['fs/guide']);
    expect(decided.record).toMatchObject({ by: 'decision', threshold: 0.3, call: 'mdl_1' });
    expect(decided.record?.items).toEqual([
      { used: false, kind: 'fn', name: 'fs/read', score: 0.9, reason: 'declined', note: 'nothing to read yet' },
      { used: true, kind: 'context', name: 'fs/guide', score: 0.5, note: 'explains files' },
      { used: false, kind: 'fn', name: 'fs/write', score: 0.1, reason: 'below-threshold' },
      { used: false, kind: 'fn', name: 'web/search', score: 0.8, reason: 'rule' },
    ]);
    const asked = w.llm.asked[0];
    expect(asked).toMatchObject({ model: { model: 'tiny' }, priority: 'interactive' });
    const prompt = JSON.stringify(asked?.request.messages);
    expect(prompt).toContain('Earlier: we use files');
    expect(prompt).toContain('Latest: how do files work');
    expect(prompt).not.toContain('fs/write');
  });

  it('lets the score decide when the LLM fails, marking what it left out as failed', async () => {
    const w = await world();
    await w.chat.suggestions.set(SuggestDecision.parse({ by: 'llm', model: { model: { model: 'tiny' } }, cap: 1 }), w.admin.id);
    w.llm.answers = ['not json at all'];
    const decided = await w.chat.suggestions.decide({ session: w.session.id, text: 'files', actor: w.admin.id });
    expect(decided.suggestions.map((s) => s.name)).toEqual(['fs/read']);
    expect(decided.record?.items.slice(0, 2)).toEqual([
      { used: true, kind: 'fn', name: 'fs/read', score: 0.9 },
      { used: false, kind: 'context', name: 'fs/guide', score: 0.5, reason: 'failed' },
    ]);
    expect(w.logs.some((l) => l.msg === 'suggestions.decision.failed')).toBe(true);
  });

  it('has no model by default, and records nothing for a message with no candidates', async () => {
    const w = await chatWorld();
    expect((await w.chat.suggestions.setting()).value).toEqual({ by: 'none' });
    expect(await w.chat.suggestions.decide({ session: w.session.id, text: 'hello', actor: w.admin.id })).toEqual({ suggestions: [] });
  });

  it('by a decision model: one yes/no question per candidate over the floor, split by its maxQuestions, picked at the decide role threshold', async () => {
    const w = await world();
    w.decisions.role = { model: 'judge', threshold: 0.6, maxQuestions: 1 };
    w.decisions.answer = (instructions) => (instructions.includes('fs/guide') ? 0.9 : instructions.includes('fs/read') ? 0.7 : 0.1);
    await w.chat.suggestions.set(SuggestDecision.parse({ by: 'decision', floor: 0.3 }), w.admin.id);
    const decided = await w.chat.suggestions.decide({ session: w.session.id, text: 'how do files work', actor: w.admin.id });
    // most likely first; fs/write scored under the floor, so it was never asked about
    expect(decided.suggestions.map((s) => s.name)).toEqual(['fs/read', 'fs/guide']);
    expect(w.decisions.asked).toEqual([['c0'], ['c1']]);
    expect(decided.record).toMatchObject({ by: 'decision', threshold: 0.3, call: 'mdl_d1' });
    expect(decided.record?.items).toEqual([
      { used: true, kind: 'fn', name: 'fs/read', score: 0.9, note: '70% likely' },
      { used: true, kind: 'context', name: 'fs/guide', score: 0.5, note: '90% likely' },
      { used: false, kind: 'fn', name: 'fs/write', score: 0.1, reason: 'below-threshold' },
      { used: false, kind: 'fn', name: 'web/search', score: 0.8, reason: 'rule' },
    ]);
    // a stricter decide role declines the less likely one, saying how likely it was
    w.decisions.role = { model: 'judge', threshold: 0.8 };
    const strict = await w.chat.suggestions.decide({ session: w.session.id, text: 'how do files work', actor: w.admin.id });
    expect(strict.suggestions.map((s) => s.name)).toEqual(['fs/guide']);
    expect(strict.record?.items[0]).toEqual({ used: false, kind: 'fn', name: 'fs/read', score: 0.9, reason: 'declined', note: '70% likely' });
    expect(w.llm.asked).toHaveLength(0);
  });

  it('lets the score decide when no decision model is set, saying the decision failed', async () => {
    const w = await world();
    await w.chat.suggestions.set(SuggestDecision.parse({ by: 'decision', cap: 1 }), w.admin.id);
    const decided = await w.chat.suggestions.decide({ session: w.session.id, text: 'files', actor: w.admin.id });
    expect(decided.suggestions.map((s) => s.name)).toEqual(['fs/read']);
    expect(decided.record?.items[1]).toMatchObject({ name: 'fs/guide', reason: 'failed' });
    const failed = w.logs.find((l) => l.msg === 'suggestions.decision.failed');
    expect(failed).toMatchObject({ by: 'decision' });
    expect(JSON.stringify(failed)).toContain('No decision model is set');
    expect(w.decisions.asked).toEqual([]);
  });

  it('reads a setting saved before the chooser was one choice as today’s', async () => {
    const w = await world();
    const legacy = { enabled: true, model: { model: { model: 'tiny' } }, messages: 2, candidates: 10, cap: 3, floor: 0.4 };
    // the row as the store reads it back: the hub option schema takes the legacy shape and gives today's
    await w.store.table('hubOptions').put(HubOption.parse({ key: 'suggestDecision', value: legacy, setBy: w.admin.id, updatedAt: 1 }));
    expect((await w.chat.suggestions.setting()).value).toEqual({ by: 'llm', model: { model: { model: 'tiny' } }, messages: 2, candidates: 10, cap: 3, floor: 0.4 });
  });
});

describe('candidateFor', () => {
  it('tells a fn and a context item of one name apart by key, and takes a bare name only when it is unique', () => {
    const pool: Suggestion[] = [
      { kind: 'fn', name: 'fs/guide', description: '', score: 0.5 },
      { kind: 'context', name: 'fs/guide', description: '', score: 0.5 },
      { kind: 'fn', name: 'fs/read', description: '', score: 0.5 },
    ];
    expect(candidateFor(pool, 'context:fs/guide')).toBe(pool[1]);
    expect(candidateFor(pool, 'fs/guide')).toBeUndefined();
    expect(candidateFor(pool, 'fs/read')).toBe(pool[2]);
  });
});

describe('the suggestions chooser for systems', () => {
  const request = {
    run: IDS.run.parse('run_1'), question: 'overdue invoices by customer', max: 1,
    candidates: [{ id: 'db.overdue', text: 'Lists overdue invoices per customer.', score: 0.82 }, { id: 'db.all', text: 'Every invoice.', score: 0.4 }],
  };

  it('is off with no model, then an LLM picks known ids only, best first, up to max', async () => {
    const w = await world();
    expect(await w.chat.suggestions.forSystem(request)).toEqual({ by: 'off' });
    await w.chat.suggestions.set(SuggestDecision.parse({ by: 'llm', model: { model: { model: 'tiny' } } }), w.admin.id);
    w.llm.answers = ['{"picked":[{"id":"made-up"},{"id":"db.overdue","why":"same question"},{"id":"db.all"}]}'];
    const decided = await w.chat.suggestions.forSystem(request);
    expect(decided).toMatchObject({ by: 'decision', picked: [{ id: 'db.overdue', why: 'same question' }] });
    // the model call is recorded and named, so the system can point at it
    expect(decided.by === 'decision' ? decided.call : undefined).toMatch(/^mdl_/);
    expect(JSON.stringify(w.llm.asked[0]?.request.messages)).toContain('overdue invoices by customer');
    w.llm.answers = ['{"picked":[],"note":"none groups by customer"}'];
    expect(await w.chat.suggestions.forSystem(request)).toMatchObject({ by: 'decision', picked: [], note: 'none groups by customer' });
    w.llm.answers = ['no json here'];
    expect(await w.chat.suggestions.forSystem(request)).toMatchObject({ by: 'failed' });
  });

  it('by a decision model: a yes/no question per candidate, the likely ones over the decide threshold, charged to the run', async () => {
    const w = await world();
    w.decisions.role = { model: 'judge', threshold: 0.5, maxQuestions: 64 };
    w.decisions.answer = (instructions) => (instructions.includes('overdue') ? 0.8 : 0.6);
    await w.chat.suggestions.set(SuggestDecision.parse({ by: 'decision' }), w.admin.id);
    expect(await w.chat.suggestions.forSystem({ ...request, max: 2 })).toEqual({
      by: 'decision', picked: [{ id: 'db.overdue', why: '80% likely' }, { id: 'db.all', why: '60% likely' }], call: 'mdl_d1',
    });
    expect(await w.chat.suggestions.forSystem(request)).toMatchObject({ picked: [{ id: 'db.overdue' }] });
    w.decisions.answer = () => 0.2;
    expect(await w.chat.suggestions.forSystem(request)).toMatchObject({ by: 'decision', picked: [], note: 'No candidate was at least 50% likely to answer it.' });
    w.decisions.answer = () => { throw new Error('the judge is down'); };
    expect(await w.chat.suggestions.forSystem(request)).toEqual({ by: 'failed', message: 'the judge is down' });
    expect(w.llm.asked).toHaveLength(0);
  });
});
