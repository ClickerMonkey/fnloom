import { IDS, SuggestDecision, type Suggestion } from '@harness/core';
import { describe, expect, it } from 'vitest';
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
    const decided = await w.chat.suggestions.decide({ session: w.session.id, text: 'read the readme' });
    expect(decided.suggestions.map((s) => s.name)).toEqual(['fs/read', 'fs/guide']);
    expect(decided.record).toEqual({
      by: 'score', threshold: 0.15, items: [
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

  it('by the decision model when it is on: its picks are used, the rest declined with its reasons, its call linked', async () => {
    const w = await world();
    const value = SuggestDecision.parse({ enabled: true, model: { model: { model: 'tiny' } }, floor: 0.3, messages: 2 });
    expect(await w.chat.suggestions.set(value, w.admin.id)).toMatchObject({ value, setBy: w.admin.id });
    await w.store.table('messages').insert({
      id: IDS.message.parse('msg_old'), session: w.session.id, turn: IDS.turn.parse('trn_old'), author: w.admin.id, role: 'user', parts: [{ type: 'text', text: 'we use files' }],
      runs: [], status: 'done', replyAll: false, answerers: [], createdAt: 0,
    });
    w.llm.answers = ['```json\n{"picks":[{"name":"fs/guide","reason":"explains files"}],"declined":[{"name":"fs/read","reason":"nothing to read yet"}]}\n```'];
    const decided = await w.chat.suggestions.decide({ session: w.session.id, text: 'how do files work' });
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

  it('lets the score decide when the decision model fails, marking what it left out as failed', async () => {
    const w = await world();
    await w.chat.suggestions.set(SuggestDecision.parse({ enabled: true, model: { model: { model: 'tiny' } }, cap: 1 }), w.admin.id);
    w.llm.answers = ['not json at all'];
    const decided = await w.chat.suggestions.decide({ session: w.session.id, text: 'files' });
    expect(decided.suggestions.map((s) => s.name)).toEqual(['fs/read']);
    expect(decided.record?.items.slice(0, 2)).toEqual([
      { used: true, kind: 'fn', name: 'fs/read', score: 0.9 },
      { used: false, kind: 'context', name: 'fs/guide', score: 0.5, reason: 'failed' },
    ]);
    expect(w.logs.some((l) => l.msg === 'suggestions.decision.failed')).toBe(true);
  });

  it('is off by default, and records nothing for a message with no candidates', async () => {
    const w = await chatWorld();
    expect((await w.chat.suggestions.setting()).value).toMatchObject({ enabled: false, messages: 3 });
    expect(await w.chat.suggestions.decide({ session: w.session.id, text: 'hello' })).toEqual({ suggestions: [] });
  });
});
