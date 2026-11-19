import { IDS, type LlmMessage, type Run, type TurnId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { fieldType } from './state.ts';
import { CLIENT, chatWorld, gin, makeRun, settle } from './testing.ts';
import { undoNote } from './undo.ts';

const text = gin({ name: 'text' });

async function world() {
  const w = await chatWorld();
  w.catalog.addFn('fs', { name: 'write' });
  w.catalog.addFn('fs', { name: 'read', tags: ['read'] });
  w.catalog.addFn('fs', { name: 'notify' });
  w.catalog.addFn('fs', { name: 'cd', state: gin({ name: 'obj', props: { cwd: { type: text } } }) });
  const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'Tidy up' }] });
  const root = (await w.store.table('turns').get(sent.turn))?.root;
  if (root !== undefined) { await w.store.table('runs').update(root, { status: 'done' }); }
  await w.chat.turns.settle(sent.turn, 'done');
  let at = 100;
  const run = async (id: string, input: Partial<Run> & Pick<Run, 'fn'>): Promise<Run> => w.store.table('runs').insert(makeRun({ id: IDS.run.parse(id), turn: sent.turn, actor: w.admin.id, session: w.session.id, createdAt: at++, ...input }));
  return { ...w, turn: sent.turn, run };
}

describe('undoing a turn', () => {
  it('undoes each run with an undo payload, newest first, puts state back, and posts a note', async () => {
    const w = await world();
    await w.run('run_1', { fn: 'fs/write', undo: { path: 'a.md' } });
    const cd = await w.run('run_2', { fn: 'fs/cd' });
    await w.chat.state.set({ run: cd.id }, { patch: { cwd: '/repo' }, clear: [] });
    await w.run('run_3', { fn: 'fs/write', undo: { path: 'b.md' } });
    w.runs.undoOutcomes.set(IDS.run.parse('run_3'), { status: 'undone', summary: 'Removed b.md.' });
    w.runs.undoOutcomes.set(IDS.run.parse('run_1'), { status: 'gone' });
    const report = await w.chat.undo.undoTurn(w.turn, w.admin.id);
    expect(w.runs.controlled.filter((c) => c.action === 'undo').map((c) => c.run)).toEqual(['run_3', 'run_1']);
    expect(report).toEqual({
      turn: w.turn,
      undone: [
        { run: 'run_3', fn: 'fs/write', summary: 'Removed b.md.' },
        { run: 'run_2', fn: 'fs/cd', summary: 'Put back one state field.' },
        { run: 'run_1', fn: 'fs/write', summary: 'Nothing was left to undo.' },
      ],
      failed: [],
      notUndoable: [],
      session: { messages: 0, unloaded: [], reloaded: [] },
    });
    expect((await w.chat.state.get({ run: cd.id })).values).toEqual({});
    expect((await w.store.table('turns').get(w.turn))?.status).toBe('undone');
    const note = (await w.chat.sessions.messages(w.session.id, w.admin.id, { limit: 1 })).items[0];
    expect(note).toMatchObject({ role: 'note', author: w.deps.hubActor, turn: w.turn, parts: [{ type: 'text', text: undoNote(report) }] });
    await settle();
    expect(w.bus.of('session.controls').at(-1)?.controls.undoLastTurn).toBe(false);
    expect(await fieldType(text)).toHaveLength(64);
  });

  it('reports what failed and what changed something without an undo, leaving reads and agents out', async () => {
    const w = await world();
    await w.run('run_1', { fn: 'fs/read' });
    await w.run('run_2', { fn: 'fs/notify' });
    await w.run('run_3', { fn: 'fs/write', undo: {} });
    await w.run('run_4', { fn: 'fs/write', undo: {} });
    await w.run('run_5', { fn: 'fs/write', undo: {}, status: 'undone' });
    await w.run('run_6', { fn: 'fs/notify', status: 'failed' });
    w.runs.undoOutcomes.set(IDS.run.parse('run_3'), { status: 'failed', error: { class: 'caller', message: 'file changed since' } });
    w.runs.undoOutcomes.set(IDS.run.parse('run_4'), new Error('system offline'));
    const report = await w.chat.undo.undoTurn(w.turn, w.admin.id);
    expect(report.undone).toEqual([]);
    expect(report.failed).toEqual([
      { run: 'run_4', fn: 'fs/write', error: { class: 'fatal', code: 'undo-failed', message: 'system offline' } },
      { run: 'run_3', fn: 'fs/write', error: { class: 'caller', message: 'file changed since' } },
    ]);
    expect(report.notUndoable).toEqual([{ run: 'run_2', fn: 'fs/notify' }]);
  });

  it('is refused while the turn runs, twice, or by someone outside the session', async () => {
    const w = await world();
    const bo = await w.user('Bo');
    await expect(w.chat.undo.undoTurn(w.turn, bo.id)).rejects.toMatchObject({ code: 'not-found' });
    await expect(w.chat.undo.undoTurn(IDS.turn.parse('trn_none'), w.admin.id)).rejects.toMatchObject({ code: 'not-found' });
    await w.chat.undo.undoTurn(w.turn, w.admin.id);
    await expect(w.chat.undo.undoTurn(w.turn, w.admin.id)).rejects.toMatchObject({ code: 'conflict' });
    const busy = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'again' }] });
    await expect(w.chat.undo.undoTurn(busy.turn, w.admin.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('waits until every run of the turn has ended, even one in the background', async () => {
    const w = await world();
    await w.run('run_bg', { fn: 'fs/write', undo: {}, status: 'running', background: true });
    await expect(w.chat.undo.undoTurn(w.turn, w.admin.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(w.runs.controlled.filter((c) => c.action === 'undo')).toEqual([]);
    await w.store.table('runs').update(IDS.run.parse('run_bg'), { status: 'done' });
    expect((await w.chat.undo.undoTurn(w.turn, w.admin.id)).undone).toHaveLength(1);
  });

  it('works on a turn outside any session for the person who started it', async () => {
    const w = await world();
    const turn = IDS.turn.parse('trn_solo');
    await w.store.table('turns').insert({
      id: turn, actor: w.admin.id, user: { id: w.admin.id, name: 'Ada', email: 'ada@example.com', role: 'admin', groups: [], timeZone: 'UTC', locale: 'en' },
      time: { now: 0, timeZone: 'UTC', local: '' }, status: 'done', limits: { priority: 'background', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 1 }, budgets: [] }, cost: 0,
      errors: 'feed-back', createdAt: 0,
    });
    const bo = await w.user('Bo');
    await expect(w.chat.undo.undoTurn(turn, bo.id)).rejects.toMatchObject({ code: 'not-found' });
    expect((await w.chat.undo.undoTurn(turn, w.admin.id)).undone).toEqual([]);
  });
});

describe('undoing a turn as a true redo', () => {
  /** A session that already had an exchange and loaded things, then a turn that ran long, loaded more and dropped one. */
  async function grown() {
    const w = await chatWorld();
    const before: LlmMessage[] = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'earlier answer' }];
    const selection = { turn: IDS.turn.parse('trn_old'), items: [], at: 1 };
    await w.store.table('sessions').update(w.session.id, { transcript: before, tools: ['fs/read', 'fs/old'], context: ['fs/guide'], selection });
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'Create a place to track tasks' }] });
    // what 24 failed iterations left: a long transcript, fns and context the agent loaded, and one it dropped
    const tries: LlmMessage[] = Array.from({ length: 24 }, (_, i) => ({ role: 'assistant', content: `try ${i}` }));
    await w.store.table('sessions').update(w.session.id, {
      transcript: [...before, { role: 'user', content: 'Create a place to track tasks' }, ...tries], tools: ['fs/read', 'database/create_table', 'database/insert'],
      context: ['fs/guide', 'database/schema'], selection: { turn: sent.turn, items: [], at: 2 },
    });
    await endTurn(w, sent.turn, 'failed');
    return { ...w, turn: sent.turn, before, selection };
  }

  it('cuts the transcript back to before the turn and puts the loaded fns, context and selection back', async () => {
    const w = await grown();
    expect((await w.store.table('turns').get(w.turn))?.start).toEqual({ transcript: 2, tools: ['fs/read', 'fs/old'], context: ['fs/guide'], selection: w.selection });
    const report = await w.chat.undo.undoTurn(w.turn, w.admin.id);
    expect(report.session).toEqual({ messages: 25, unloaded: ['database/create_table', 'database/insert', 'database/schema'], reloaded: ['fs/old'] });
    expect(await w.store.table('sessions').get(w.session.id)).toMatchObject({ transcript: w.before, tools: ['fs/read', 'fs/old'], context: ['fs/guide'], selection: w.selection });
    const note = (await w.chat.sessions.messages(w.session.id, w.admin.id, { limit: 1 })).items[0];
    // truthful: the turn changed the conversation and what was loaded, so the note never says it changed nothing
    expect(note?.parts).toEqual([{ type: 'text', text: [
      'Took the turn\'s 25 messages out of the conversation, so the agent starts again from before it.',
      'Unloaded what the turn loaded: database/create_table, database/insert, database/schema.',
      'Loaded again what the turn dropped: fs/old.',
    ].join('\n') }]);
    await settle();
    expect(w.bus.of('session.changed').at(-1)?.session.id).toBe(w.session.id);
  });

  it('clears a graph selection the session had none of before the turn', async () => {
    const w = await chatWorld();
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'hi' }] });
    await w.store.table('sessions').update(w.session.id, { selection: { turn: sent.turn, items: [], at: 2 }, transcript: [{ role: 'user', content: 'hi' }] });
    await endTurn(w, sent.turn, 'done');
    expect((await w.chat.undo.undoTurn(sent.turn, w.admin.id)).session).toEqual({ messages: 1, unloaded: [], reloaded: [] });
    expect((await w.store.table('sessions').get(w.session.id))?.selection).toBeUndefined();
  });

  it('starts a turn that took over from a busy agent after what that agent answered on its way out', async () => {
    const w = await chatWorld();
    const first = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'first' }] });
    await w.store.table('sessions').update(w.session.id, { transcript: [{ role: 'user', content: 'first' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'fs__read', arguments: '{}' }] }] });
    // the interrupted agent answers its open call into the transcript before the new turn's message goes in
    w.agents.interrupt = async () => {
      const session = await w.store.table('sessions').get(w.session.id);
      await w.store.table('sessions').update(w.session.id, { transcript: [...(session?.transcript ?? []), { role: 'tool', toolCallId: 'c1', content: 'Running in the background' }] });
    };
    const second = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'second' }] });
    expect((await w.store.table('turns').get(first.turn))?.start?.transcript).toBe(0);
    expect((await w.store.table('turns').get(second.turn))?.start?.transcript).toBe(3);
  });

  it('refuses a turn a later standing turn was built on, and takes it once the later one is undone', async () => {
    const w = await grown();
    const later = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'and then?' }] });
    await endTurn(w, later.turn, 'done');
    const laterStands: unknown = expect.stringContaining('later turn');
    await expect(w.chat.undo.undoTurn(w.turn, w.admin.id)).rejects.toMatchObject({ code: 'conflict', message: laterStands });
    await w.chat.undo.undoTurn(later.turn, w.admin.id);
    expect((await w.chat.undo.undoTurn(w.turn, w.admin.id)).session?.messages).toBe(25);
    expect((await w.store.table('sessions').get(w.session.id))?.transcript).toEqual(w.before);
  });
});

/** End a sent turn the way its agent run would: the run settles, then the turn. */
async function endTurn(w: Awaited<ReturnType<typeof chatWorld>>, turn: TurnId, status: 'done' | 'failed'): Promise<void> {
  const root = (await w.store.table('turns').get(turn))?.root;
  if (root !== undefined) { await w.store.table('runs').update(root, { status }); }
  await w.chat.turns.settle(turn, status);
}

describe('the undo note', () => {
  it('says what was undone, what failed and what was left', () => {
    const run = IDS.run.parse('run_1');
    expect(undoNote({ turn: IDS.turn.parse('trn_1'), undone: [], failed: [], notUndoable: [] })).toBe('Undid the turn. It had changed nothing.');
    expect(undoNote({
      turn: IDS.turn.parse('trn_1'),
      undone: [{ run, fn: 'fs/write', summary: 'Removed a.md.' }, { run, fn: 'fs/cd', summary: 'Put back one state field.' }],
      failed: [{ run, fn: 'fs/rm', error: { class: 'fatal', message: 'gone' } }],
      notUndoable: [{ run, fn: 'fs/mail' }],
    })).toBe('Undid 2 changes:\n- fs/write: Removed a.md.\n- fs/cd: Put back one state field.\nCould not undo:\n- fs/rm: gone\nThese have no undo and were left as they are:\n- fs/mail');
    // a turn that only rewound the session says so, and nothing about changing nothing
    const rewound = (messages: number) => undoNote({ turn: IDS.turn.parse('trn_1'), undone: [], failed: [], notUndoable: [], session: { messages, unloaded: [], reloaded: [] } });
    expect(rewound(1)).toBe('Took the turn\'s one message out of the conversation, so the agent starts again from before it.');
    expect(rewound(0)).toBe('Undid the turn. It had changed nothing.');
  });
});
