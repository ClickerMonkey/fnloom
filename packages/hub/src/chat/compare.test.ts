import { ChatModeConfig, IDS, QualifiedName, SystemName, type CompareVariant, type CompareVariantInput, type LlmMessage, type StateField } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { HubLedger, TURN_CAP } from '../execution/ledger.ts';
import { LedgerSpend } from '../execution/spend.ts';
import { testSettings } from '../execution/testing.ts';
import { variantBudget, variantLabel } from './compare.ts';
import { undoNote } from './undo.ts';
import { agentActorId } from './support.ts';
import { CLIENT, LIMITS, chatWorld, makeRun, settle } from './testing.ts';

const chatAgent = agentActorId('hub/chat');
const FS = SystemName.parse('fs');
const SITE = { fn: QualifiedName.parse('hub/chat'), model: 'test-model' };
const EARLIER: LlmMessage[] = [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Noted.' }];
const TWO: CompareVariantInput[] = [
  { label: 'Fast', settings: { model: { model: 'fast-1' } } },
  { settings: { instructions: 'Answer in one word.', fnMode: 'read' } },
];

/** A field of the chat's session state. */
function field(session: StateField['session'], value: string, version = 1): StateField {
  return { session, system: FS, name: 'cwd', type: 'h_text', def: { name: 'text' }, value, version, updatedBy: { run: IDS.run.parse('run_old') }, updatedAt: 0 };
}

/** A chat with history, a loaded fn and some state, and a message compared across `variants`. */
async function compared(variants: CompareVariantInput[] = TWO) {
  const w = await chatWorld();
  w.catalog.addFn('fs', { name: 'write' });
  w.catalog.addFn('fs', { name: 'read', tags: ['read'] });
  await w.store.table('sessions').update(w.session.id, { transcript: EARLIER, tools: ['fs/read'] });
  await w.store.table('stateFields').put(field(w.session.id, '/repo'));
  const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'Which one?' }], variants });
  const turn = await w.store.table('turns').get(sent.turn);
  if (turn?.compare === undefined) { throw new Error('expected a compared turn'); }
  const variant = (i: number): CompareVariant => {
    const v = turn.compare?.variants[i];
    if (v === undefined) { throw new Error(`no variant ${i}`); }
    return v;
  };
  /** A variant answers: its fork's transcript grows, it loads a fn, its answer is a message, and its turn settles. */
  const answer = async (i: number, text: string, status: 'done' | 'failed' = 'done'): Promise<void> => {
    const v = variant(i);
    const fork = await w.store.table('sessions').get(v.session);
    await w.store.table('sessions').update(v.session, {
      transcript: [...(fork?.transcript ?? []), { role: 'user', content: 'Which one?' }, { role: 'assistant', content: text }], tools: [...(fork?.tools ?? []), 'fs/write'],
    });
    const message = await w.chat.turns.begin({ turn: v.turn, author: chatAgent });
    await w.chat.turns.finish(message.id, [{ type: 'text', text }], status);
    const root = (await w.store.table('turns').get(v.turn))?.root;
    if (root !== undefined) { await w.store.table('runs').update(root, { status }); }
    await w.chat.turns.settle(v.turn, status);
  };
  return { ...w, sent, turn, variant, answer };
}

describe('starting a compare', () => {
  it('forks the chat once per variant with its settings, and leaves the chat as it was', async () => {
    const w = await compared();
    expect(w.sent.message).toMatchObject({ answerers: [], compared: true });
    expect(w.turn).toMatchObject({ status: 'running', compare: { reserved: LIMITS.turn.cost / 2, discarded: [] } });
    expect(w.turn.root).toBeUndefined();
    expect(w.turn.compare?.variants.map((v) => v.label)).toEqual(['Fast', 'read · own prompt']);
    for (const i of [0, 1]) {
      const v = w.variant(i);
      const fork = await w.store.table('sessions').get(v.session);
      expect(fork).toMatchObject({ forkOf: w.session.id, fork: { turn: w.sent.turn, variant: i, label: v.label }, transcript: EARLIER, tools: ['fs/read'], status: 'running' });
      expect((await w.store.table('stateFields').get({ session: v.session, system: FS, name: 'cwd', type: 'h_text' }))?.value).toBe('/repo');
      expect(await w.store.table('turns').get(v.turn)).toMatchObject({ session: v.session, message: w.sent.message.id, status: 'running' });
    }
    expect(await w.store.table('sessions').get(w.variant(0).session)).toMatchObject({ model: { model: 'fast-1' } });
    expect(await w.store.table('sessions').get(w.variant(1).session)).toMatchObject({ instructions: 'Answer in one word.', fnMode: 'read' });
    expect(w.agents.started.map((s) => ({ session: s.session, turn: s.turn, fn: s.fn, caller: s.caller }))).toEqual([
      { session: w.variant(0).session, turn: w.variant(0).turn, fn: 'hub/chat', caller: chatAgent },
      { session: w.variant(1).session, turn: w.variant(1).turn, fn: 'hub/chat', caller: chatAgent },
    ]);
    // forks are never listed, and the chat itself never wakes its agent
    expect((await w.chat.sessions.list(w.admin.id, {})).items.map((s) => s.id)).toEqual([w.session.id]);
    expect(w.agents.started.some((s) => s.session === w.session.id)).toBe(false);
  });

  it('keeps what a variant does in its fork: the chat\'s transcript, messages and state stay as they were', async () => {
    const w = await compared();
    await w.store.table('stateFields').put(field(w.variant(0).session, '/elsewhere', 2));
    await w.answer(0, 'This one.');
    const chat = await w.store.table('sessions').get(w.session.id);
    expect(chat).toMatchObject({ transcript: EARLIER, tools: ['fs/read'] });
    expect((await w.chat.sessions.messages(w.session.id, w.admin.id, {})).items.map((m) => m.role)).toEqual(['user']);
    expect((await w.store.table('stateFields').get({ session: w.session.id, system: FS, name: 'cwd', type: 'h_text' }))?.value).toBe('/repo');
    expect((await w.store.table('sessions').get(w.variant(1).session))?.transcript).toEqual(EARLIER);
  });

  it('refuses a variant naming an agent that does not exist, before anything is stored', async () => {
    const w = await chatWorld();
    await expect(w.chat.turns.send({
      session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'x' }],
      variants: [{ settings: {} }, { settings: { agent: 'fs/nope' } }],
    })).rejects.toMatchObject({ code: 'invalid' });
    expect(await w.store.table('turns').count({ session: w.session.id })).toBe(0);
  });
});

describe('the compare budget', () => {
  it('reserves each variant an even share of the turn budget up front, which its calls cannot pass', async () => {
    const w = await compared([{ settings: {} }, { settings: {} }, { settings: {} }, { settings: {} }]);
    const share = variantBudget(LIMITS.turn.cost, 4);
    expect(share).toBe(LIMITS.turn.cost / 4);
    expect(w.turn.compare?.reserved).toBe(share);
    expect(w.agents.started.map((s) => s.budget?.cost)).toEqual([share, share, share, share]);
    const own = await w.store.table('turns').get(w.variant(2).turn);
    expect(own?.limits.turn).toEqual({ cost: share, time: LIMITS.turn.time });
    const ledger = new HubLedger({ store: w.store, bus: w.bus, clock: () => 1, random: () => 'x1', settings: testSettings() }, new LedgerSpend(w.store));
    const root = own?.root;
    if (own === undefined || root === undefined) { throw new Error('expected a started variant'); }
    expect(await ledger.reserve({ limits: own.limits, estimate: share * 2, run: root, site: SITE })).toMatchObject({ ok: false, budget: TURN_CAP });
    expect(await ledger.reserve({ limits: own.limits, estimate: share / 2, run: root, site: SITE })).toMatchObject({ ok: true });
  });

  it('counts a variant\'s spend as its chat\'s, and the compared turn adds up its variants\'', async () => {
    const w = await compared();
    const ledger = new HubLedger({ store: w.store, bus: w.bus, clock: () => 1, random: () => 'x2', settings: testSettings() }, new LedgerSpend(w.store));
    const root = (await w.store.table('turns').get(w.variant(0).turn))?.root;
    if (root === undefined) { throw new Error('expected a started variant'); }
    await ledger.record({ cost: 0.1, tokens: 10, actor: w.admin.id, session: w.variant(0).session, fn: 'hub/chat', run: root });
    const lines = await w.store.table('ledger').find({ limit: 5 });
    expect(lines.items.map((l) => l.session)).toEqual([w.session.id]);
    expect((await w.store.table('turns').get(w.variant(0).turn))?.cost).toBeCloseTo(0.1);
    await w.answer(0, 'A');
    expect((await w.store.table('turns').get(w.sent.turn))?.cost).toBeCloseTo(0.1);
  });
});

describe('a compare settling', () => {
  it('ends the compared turn once every variant has, and shows each variant\'s answer, spend and time', async () => {
    const w = await compared();
    await w.answer(0, 'First.');
    expect((await w.store.table('turns').get(w.sent.turn))?.status).toBe('running');
    w.advance(5_000);
    await w.answer(1, 'Second.', 'failed');
    expect((await w.store.table('turns').get(w.sent.turn))?.status).toBe('done');
    expect((await w.store.table('sessions').get(w.session.id))?.status).toBe('idle');
    const view = await w.chat.compare.view(w.sent.turn, w.admin.id);
    expect(view).toMatchObject({ turn: w.sent.turn, session: w.session.id, message: w.sent.message.id, status: 'done', reserved: LIMITS.turn.cost / 2 });
    expect(view.variants.map((v) => ({ status: v.status, text: v.messages.flatMap((m) => m.parts) }))).toEqual([
      { status: 'done', text: [{ type: 'text', text: 'First.' }] },
      { status: 'failed', text: [{ type: 'text', text: 'Second.' }] },
    ]);
    expect(view.variants[1]?.time).toBeGreaterThan(4_900);
    await settle();
    expect(w.bus.of('turn.compare').filter((e) => e.turn === w.sent.turn).length).toBeGreaterThanOrEqual(3);
    // nobody outside the chat sees it
    const bo = await w.user('Bo');
    await expect(w.chat.compare.view(w.sent.turn, bo.id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('lists the approvals each variant waits on, marked with the variant', async () => {
    const w = await compared();
    const v = w.variant(1);
    const run = await w.store.table('runs').insert(makeRun({ id: IDS.run.parse('run_ask'), fn: 'fs/write', turn: v.turn, session: v.session, actor: w.admin.id, status: 'awaiting-approval' }));
    await w.store.table('approvals').insert({
      id: IDS.approval.parse('apr_1'), run: run.id, fn: run.fn, approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: 0, variant: { turn: w.sent.turn, variant: 1, label: v.label },
    });
    const view = await w.chat.compare.view(w.sent.turn, w.admin.id);
    expect(view.variants[0]?.approvals).toEqual([]);
    expect(view.variants[1]?.approvals).toMatchObject([{ id: 'apr_1', variant: { variant: 1, label: v.label } }]);
  });
});

describe('choosing a variant', () => {
  it('appends its transcript, loaded fns, state and messages to the chat, and lists what the others did', async () => {
    const w = await compared();
    await w.store.table('stateFields').put(field(w.variant(0).session, '/chosen', 2));
    await w.answer(0, 'Chosen answer.');
    const other = w.variant(1);
    const otherRoot = (await w.store.table('turns').get(other.turn))?.root;
    await w.store.table('runs').insert(makeRun({ id: IDS.run.parse('run_w'), fn: 'fs/write', turn: other.turn, session: other.session, actor: w.admin.id, status: 'done', parent: otherRoot }));
    await w.store.table('runs').insert(makeRun({ id: IDS.run.parse('run_r'), fn: 'fs/read', turn: other.turn, session: other.session, actor: w.admin.id, status: 'done', parent: otherRoot }));
    await w.answer(1, 'Other answer.');
    const chosenRoot = (await w.store.table('turns').get(w.variant(0).turn))?.root;

    const view = await w.chat.compare.choose({ turn: w.sent.turn, variant: 0, by: w.admin.id });
    expect(view).toMatchObject({ chosen: 0, chosenBy: w.admin.id, discarded: [{ variant: 1, effects: [{ run: 'run_w', fn: 'fs/write' }] }] });
    const chat = await w.store.table('sessions').get(w.session.id);
    expect(chat?.transcript).toEqual([...EARLIER, { role: 'user', content: 'Which one?' }, { role: 'assistant', content: 'Chosen answer.' }]);
    expect(chat?.tools).toEqual(['fs/read', 'fs/write']);
    expect((await w.store.table('stateFields').get({ session: w.session.id, system: FS, name: 'cwd', type: 'h_text' }))?.value).toBe('/chosen');
    const messages = (await w.chat.sessions.messages(w.session.id, w.admin.id, {})).items;
    expect(messages.map((m) => [m.role, m.turn])).toEqual([['assistant', w.sent.turn], ['user', w.sent.turn]]);
    const turn = await w.store.table('turns').get(w.sent.turn);
    expect(turn?.root).toBe(chosenRoot);
    if (chosenRoot !== undefined) { expect(await w.store.table('runs').get(chosenRoot)).toMatchObject({ turn: w.sent.turn, session: w.session.id }); }
    // the chosen answer still shows in the compare
    expect(view.variants[0]?.messages.map((m) => m.parts)).toEqual([[{ type: 'text', text: 'Chosen answer.' }]]);
    await expect(w.chat.compare.choose({ turn: w.sent.turn, variant: 1, by: w.admin.id })).rejects.toMatchObject({ code: 'conflict' });

    // the compared turn now undoes like any other: the chat goes back to before it
    const report = await w.chat.undo.undoTurn(w.sent.turn, w.admin.id);
    expect(report.session?.messages).toBe(2);
    expect((await w.store.table('sessions').get(w.session.id))?.transcript).toEqual(EARLIER);
    // what the discarded variant did is not the turn's, so it stays, and the undo says so
    expect(report.kept).toEqual([{ variant: 1, label: 'read · own prompt', effects: [{ run: 'run_w', fn: 'fs/write' }] }]);
    expect(w.runs.controlled.filter((c) => c.action === 'undo').map((c) => c.run)).not.toContain('run_w');
  });

  it('can make the chosen variant\'s settings the chat\'s own', async () => {
    const w = await compared();
    await w.answer(0, 'Fast answer.');
    await w.answer(1, 'Other.');
    await w.chat.compare.choose({ turn: w.sent.turn, variant: 1, adopt: true, by: w.admin.id });
    expect(await w.store.table('sessions').get(w.session.id)).toMatchObject({ instructions: 'Answer in one word.', fnMode: 'read' });
  });

  it('is refused while the variant still answers, after a later message, or by someone outside the chat', async () => {
    const w = await compared();
    await expect(w.chat.compare.choose({ turn: w.sent.turn, variant: 0, by: w.admin.id })).rejects.toMatchObject({ code: 'conflict' });
    await w.answer(0, 'A');
    const bo = await w.user('Bo');
    await expect(w.chat.compare.choose({ turn: w.sent.turn, variant: 0, by: bo.id })).rejects.toMatchObject({ code: 'not-found' });
    w.advance(1_000);
    await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'Moving on' }] });
    await expect(w.chat.compare.choose({ turn: w.sent.turn, variant: 0, by: w.admin.id })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('is refused once the compared message was undone, leaving the chat as the undo left it', async () => {
    const w = await compared();
    await w.answer(0, 'A');
    await w.answer(1, 'B');
    await w.chat.undo.undoTurn(w.sent.turn, w.admin.id);
    await expect(w.chat.compare.choose({ turn: w.sent.turn, variant: 0, by: w.admin.id })).rejects.toMatchObject({ code: 'conflict' });
    expect((await w.store.table('sessions').get(w.session.id))?.transcript).toEqual(EARLIER);
    expect((await w.store.table('turns').get(w.sent.turn))?.compare?.chosen).toBeUndefined();
  });

  it('cancels a variant still answering when another is chosen', async () => {
    const w = await compared();
    await w.answer(0, 'A');
    const other = w.variant(1);
    const root = (await w.store.table('turns').get(other.turn))?.root;
    if (root === undefined) { throw new Error('expected a started variant'); }
    await w.store.table('runs').update(root, { status: 'running' });
    await w.chat.compare.choose({ turn: w.sent.turn, variant: 0, by: w.admin.id });
    expect(w.runs.controlled).toContainEqual({ action: 'cancel', run: root });
  });
});

describe('undoing a compared turn before a variant is chosen', () => {
  it('keeps what each variant did and lists it by variant, in the report and the note', async () => {
    const w = await compared();
    const write = async (i: number, id: string, fn: string): Promise<void> => {
      const v = w.variant(i);
      const root = (await w.store.table('turns').get(v.turn))?.root;
      await w.store.table('runs').insert(makeRun({ id: IDS.run.parse(id), fn: QualifiedName.parse(fn), turn: v.turn, session: v.session, actor: w.admin.id, status: 'done', parent: root }));
    };
    await write(0, 'run_a1', 'fs/write');
    await write(0, 'run_a2', 'fs/read');
    await write(0, 'run_a3', 'fs/write');
    await write(1, 'run_b1', 'fs/read');
    await w.answer(0, 'A');
    await w.answer(1, 'B');
    const report = await w.chat.undo.undoTurn(w.sent.turn, w.admin.id);
    // only the variant that changed something, with its writes (not its reads), each still done
    const kept = [{ variant: 0, label: 'Fast', effects: [{ run: 'run_a1', fn: 'fs/write' }, { run: 'run_a3', fn: 'fs/write' }] }];
    expect(report.kept).toEqual(kept);
    expect(w.runs.controlled.filter((c) => c.action === 'undo')).toEqual([]);
    expect((await w.store.table('runs').get(IDS.run.parse('run_a1')))?.status).toBe('done');
    const note = (await w.chat.sessions.messages(w.session.id, w.admin.id, { limit: 1 })).items[0];
    expect(note).toMatchObject({ role: 'note', turn: w.sent.turn });
    expect(note?.parts).toEqual([{ type: 'text', text: undoNote(report) }, { type: 'kept-effects', variants: kept }]);
    expect(undoNote(report)).toContain('What the variants did stays as it is: 2 changes by Fast.');
    expect(undoNote(report)).not.toContain('changed nothing');
  });

  it('lists nothing kept when no variant changed anything', async () => {
    const w = await compared();
    await w.answer(0, 'A');
    await w.answer(1, 'B');
    const report = await w.chat.undo.undoTurn(w.sent.turn, w.admin.id);
    expect(report.kept).toBeUndefined();
    const note = (await w.chat.sessions.messages(w.session.id, w.admin.id, { limit: 1 })).items[0];
    expect(note?.parts.map((p) => p.type)).toEqual(['text']);
  });
});

describe('deleting a compared chat', () => {
  it('takes its forks, their messages and state with it', async () => {
    const w = await compared();
    await w.answer(0, 'A');
    await w.chat.sessions.delete(w.session.id, w.admin.id);
    for (const i of [0, 1]) {
      expect(await w.store.table('sessions').get(w.variant(i).session)).toBeUndefined();
      expect(await w.store.table('messages').count({ session: w.variant(i).session })).toBe(0);
      expect(await w.store.table('stateFields').count({ session: w.variant(i).session })).toBe(0);
    }
  });
});

describe('variant names', () => {
  it('names a variant by what it changes when the person gave no name', () => {
    expect(variantLabel({ settings: {} }, 2)).toBe('Variant C');
    expect(variantLabel({ settings: { model: { category: 'smart' }, mode: ChatModeConfig.parse({ type: 'static' }), systems: [FS] } }, 0)).toBe('smart · static · 1 systems');
    expect(variantLabel({ label: 'Mine', settings: { fnMode: 'none' } }, 0)).toBe('Mine');
  });
});
