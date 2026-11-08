import { IDS, SystemName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { ChatError } from './errors.ts';
import { DEFAULT_AGENT, UNTITLED, sessionPriorityRule } from './sessions.ts';
import { agentActorId } from './support.ts';
import { chatWorld, makeRun, settle } from './testing.ts';

describe('sessions', () => {
  it('start with the owner and the default agent, whose actor is made on first use', async () => {
    const w = await chatWorld();
    expect(w.session).toMatchObject({ title: UNTITLED, owner: w.admin.id, agent: DEFAULT_AGENT, systems: 'all', status: 'idle', archived: false });
    expect(w.session.participants.map((p) => [p.actor, p.role])).toEqual([[w.admin.id, 'owner'], [agentActorId('hub/chat'), 'agent']]);
    expect(await w.store.table('actors').get(agentActorId('hub/chat'))).toMatchObject({ kind: 'agent', fn: 'hub/chat', name: 'Chat', about: 'The chat agent.' });
    await settle();
    const changed = w.bus.of('session.changed').at(-1);
    expect(changed?.session.id).toBe(w.session.id);
    expect(changed?.participants).toEqual([w.admin.id]);
  });

  it('take a title, systems and agent, but only an agent fn can answer', async () => {
    const w = await chatWorld();
    w.catalog.addFn('crm', { name: 'coach', kind: 'hub/llm' });
    w.catalog.addFn('crm', { name: 'find' });
    const made = await w.chat.sessions.create({ owner: w.admin.id, title: '  Deals  ', systems: [SystemName.parse('crm')], agent: 'crm/coach' });
    expect(made).toMatchObject({ title: 'Deals', systems: ['crm'], agent: 'crm/coach' });
    await expect(w.chat.sessions.create({ owner: w.admin.id, agent: 'crm/find' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(w.chat.sessions.create({ owner: w.admin.id, agent: 'crm/nope' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('are made only by enabled users', async () => {
    const w = await chatWorld();
    const off = await w.user('Off', { disabled: true });
    await expect(w.chat.sessions.create({ owner: off.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.chat.sessions.create({ owner: agentActorId('hub/chat') })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('are seen only by their participants', async () => {
    const w = await chatWorld();
    const bo = await w.user('Bo');
    expect(await w.chat.sessions.get(w.session.id, w.admin.id)).toEqual(w.session);
    expect(await w.chat.sessions.get(w.session.id, bo.id)).toBeUndefined();
    expect(await w.chat.sessions.get(IDS.session.parse('ses_missing'), w.admin.id)).toBeUndefined();
    await expect(w.chat.sessions.messages(w.session.id, bo.id, {})).rejects.toBeInstanceOf(ChatError);
  });

  it('list newest first, filtered by archive and by words in the title, with an exact cursor', async () => {
    const w = await chatWorld();
    for (const title of ['Plan the trip', 'Fix the build', 'Trip photos', 'Old notes']) {
      w.advance(1_000);
      const s = await w.chat.sessions.create({ owner: w.admin.id, title });
      if (title === 'Old notes') { await w.chat.sessions.update(s.id, { archived: true }, w.admin.id); }
    }
    const all = await w.chat.sessions.list(w.admin.id, {});
    expect(all.items.map((s) => s.title)).toEqual(['Trip photos', 'Fix the build', 'Plan the trip', UNTITLED]);
    const trips = await w.chat.sessions.list(w.admin.id, { search: 'TRIP', limit: 1 });
    expect(trips.items.map((s) => s.title)).toEqual(['Trip photos']);
    const more = await w.chat.sessions.list(w.admin.id, { search: 'trip', limit: 1, ...(trips.cursor === undefined ? {} : { cursor: trips.cursor }) });
    expect(more.items.map((s) => s.title)).toEqual(['Plan the trip']);
    expect((await w.chat.sessions.list(w.admin.id, { archived: true })).items.map((s) => s.title)).toEqual(['Old notes']);
    expect(Object.keys(all.items[0] ?? {})).not.toContain('transcript');
  });

  it('change only by their owner, except each person\'s notify choice', async () => {
    const w = await chatWorld();
    const bo = await w.user('Bo');
    const session = await w.store.table('sessions').update(w.session.id, { participants: [...w.session.participants, { actor: bo.id, role: 'member', notify: 'all', joinedAt: 0 }] });
    await expect(w.chat.sessions.update(session.id, { title: 'Mine now' }, bo.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.chat.sessions.update(session.id, { priority: 'urgent' }, bo.id)).rejects.toMatchObject({ code: 'forbidden' });
    const quiet = await w.chat.sessions.update(session.id, { notify: 'none' }, bo.id);
    expect(quiet.participants.find((p) => p.actor === bo.id)?.notify).toBe('none');
    expect(quiet.participants.find((p) => p.actor === w.admin.id)?.notify).toBe('all');
  });

  it("keep a model of their own until set back to the agent's choice", async () => {
    const w = await chatWorld();
    const bo = await w.user('Bo');
    expect((await w.chat.sessions.update(w.session.id, { model: { model: 'openai/gpt-oss-20b:free' } }, w.admin.id)).model).toEqual({ model: 'openai/gpt-oss-20b:free' });
    await expect(w.chat.sessions.update(w.session.id, { model: { category: 'fast' } }, bo.id)).rejects.toMatchObject({ code: 'not-found' });
    const cleared = await w.chat.sessions.update(w.session.id, { model: null }, w.admin.id);
    expect('model' in cleared).toBe(false);
    expect((await w.store.table('sessions').get(w.session.id))?.model).toBeUndefined();
  });

  it('keep a chat mode and contextor of their own until set back to the agent fn’s', async () => {
    const w = await chatWorld();
    const bo = await w.user('Bo');
    const set = await w.chat.sessions.update(w.session.id, { mode: { type: 'static', protocol: 'native', placement: 'tail', loadDetail: 'full' }, contextor: { type: 'plain' } }, w.admin.id);
    expect(set).toMatchObject({ mode: { type: 'static', placement: 'tail' }, contextor: { type: 'plain' } });
    expect((await w.store.table('sessions').get(w.session.id))?.mode?.type).toBe('static');
    await expect(w.chat.sessions.update(w.session.id, { mode: null }, bo.id)).rejects.toMatchObject({ code: 'not-found' });
    const cleared = await w.chat.sessions.update(w.session.id, { mode: null }, w.admin.id);
    expect('mode' in cleared).toBe(false);
    expect(cleared.contextor).toEqual({ type: 'plain' });
    expect('contextor' in await w.chat.sessions.update(w.session.id, { contextor: null }, w.admin.id)).toBe(false);
  });

  it('switch agents by swapping the agent participant', async () => {
    const w = await chatWorld();
    w.catalog.addFn('crm', { name: 'coach', kind: 'hub/llm' });
    const switched = await w.chat.sessions.update(w.session.id, { agent: 'crm/coach', title: '  ', systems: [SystemName.parse('crm')] }, w.admin.id);
    expect(switched.agent).toBe('crm/coach');
    expect(switched.title).toBe(UNTITLED);
    expect(switched.systems).toEqual(['crm']);
    expect(switched.participants.filter((p) => p.role === 'agent').map((p) => p.actor)).toEqual([agentActorId('crm/coach')]);
  });

  it('keep one priority rule each, keeping its ceiling', async () => {
    const w = await chatWorld();
    await w.store.table('priorityRules').put({ id: sessionPriorityRule(w.session.id), target: { scope: 'session', session: w.session.id }, max: 'interactive', setBy: w.admin.id });
    await w.chat.sessions.update(w.session.id, { priority: 'background' }, w.admin.id);
    expect(await w.store.table('priorityRules').get(sessionPriorityRule(w.session.id))).toEqual({
      id: sessionPriorityRule(w.session.id), target: { scope: 'session', session: w.session.id }, default: 'background', max: 'interactive', setBy: w.admin.id,
    });
  });

  it('page their messages newest first', async () => {
    const w = await chatWorld();
    for (let i = 0; i < 3; i++) {
      w.advance(10);
      await w.store.table('messages').insert({
        id: IDS.message.parse(`msg_${i}`), session: w.session.id, turn: IDS.turn.parse('trn_1'), author: w.admin.id, role: 'user', parts: [{ type: 'text', text: `m${i}` }], runs: [],
        status: 'done', replyAll: false, answerers: [], createdAt: i,
      });
    }
    const first = await w.chat.sessions.messages(w.session.id, w.admin.id, { limit: 2 });
    expect(first.items.map((m) => m.id)).toEqual(['msg_2', 'msg_1']);
    const rest = await w.chat.sessions.messages(w.session.id, w.admin.id, { limit: 2, ...(first.cursor === undefined ? {} : { cursor: first.cursor }) });
    expect(rest.items.map((m) => m.id)).toEqual(['msg_0']);
  });
});

describe('session controls', () => {
  async function busy() {
    const w = await chatWorld();
    const turn = IDS.turn.parse('trn_busy');
    const run = (id: string, status: 'running' | 'paused' | 'done', allowed: { cancel: boolean; pause: boolean }) => makeRun({
      id: IDS.run.parse(id), fn: 'fs/write', turn, actor: w.admin.id, session: w.session.id, status, allowed: { ...allowed, background: true },
    });
    await w.store.table('runs').insert(run('run_a', 'running', { cancel: true, pause: true }));
    await w.store.table('runs').insert(run('run_b', 'running', { cancel: false, pause: false }));
    await w.store.table('runs').insert(run('run_c', 'paused', { cancel: true, pause: true }));
    await w.store.table('runs').insert(run('run_d', 'done', { cancel: true, pause: true }));
    return w;
  }

  it('offer pause and cancel only as far as the running runs allow', async () => {
    const w = await busy();
    expect(await w.chat.sessions.controls(w.session.id)).toEqual({ pause: true, cancel: true, uncancellable: ['run_b'], undoLastTurn: false });
  });

  it('pause what can pause, resume what is paused, cancel what can cancel', async () => {
    const w = await busy();
    await w.chat.sessions.control(w.session.id, 'pause', w.admin.id);
    expect(w.runs.controlled).toEqual([{ action: 'pause', run: 'run_a' }]);
    expect((await w.store.table('sessions').get(w.session.id))?.status).toBe('paused');
    w.runs.controlled.length = 0;
    await w.chat.sessions.control(w.session.id, 'resume', w.admin.id);
    expect(w.runs.controlled).toEqual([{ action: 'resume', run: 'run_c' }]);
    expect((await w.store.table('sessions').get(w.session.id))?.status).toBe('running');
    w.runs.controlled.length = 0;
    const controls = await w.chat.sessions.control(w.session.id, 'cancel', w.admin.id);
    expect(w.runs.controlled.map((c) => c.run).sort()).toEqual(['run_a', 'run_c']);
    await settle();
    expect(w.bus.of('session.controls').at(-1)).toEqual({ session: w.session.id, controls });
  });

  it('are deleted by their owner only, cancelling what runs and taking their messages and state along', async () => {
    const w = await busy();
    const bo = await w.user('Bo');
    await w.store.table('messages').insert({
      id: IDS.message.parse('msg_1'), session: w.session.id, turn: IDS.turn.parse('trn_busy'), author: w.admin.id, role: 'user', parts: [{ type: 'text', text: 'hi' }], runs: [],
      status: 'done', replyAll: false, answerers: [], createdAt: 1,
    });
    await w.chat.sessions.update(w.session.id, { priority: 'interactive' }, w.admin.id);
    await expect(w.chat.sessions.delete(w.session.id, bo.id)).rejects.toMatchObject({ code: 'not-found' });
    expect(await w.chat.sessions.delete(w.session.id, w.admin.id)).toBe(true);
    expect(w.runs.controlled.map((c) => [c.action, c.run]).sort()).toEqual([['cancel', 'run_a'], ['cancel', 'run_c']]);
    expect(await w.store.table('sessions').get(w.session.id)).toBeUndefined();
    expect(await w.store.table('messages').get('msg_1')).toBeUndefined();
    expect(await w.store.table('priorityRules').get(sessionPriorityRule(w.session.id))).toBeUndefined();
    // the runs stay, for the admin's history
    expect(await w.store.table('runs').get('run_d')).toBeDefined();
    await settle();
    expect(w.bus.of('session.deleted')).toEqual([{ session: w.session.id, participants: [w.admin.id] }]);
    await expect(w.chat.sessions.delete(w.session.id, w.admin.id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('offer undo of the last turn once it has ended and nothing runs', async () => {
    const w = await chatWorld();
    expect((await w.chat.sessions.controls(w.session.id)).undoLastTurn).toBe(false);
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text: 'hi' }], client: { timeZone: 'UTC', locale: 'en', now: 0 } });
    const agentRun = w.agents.started.length > 0 ? (await w.store.table('turns').get(sent.turn))?.root : undefined;
    if (agentRun !== undefined) { await w.store.table('runs').update(agentRun, { status: 'done' }); }
    await w.chat.turns.settle(sent.turn, 'done');
    expect((await w.chat.sessions.controls(w.session.id)).undoLastTurn).toBe(true);
  });

  it('track presence for the tool-timeout rule', async () => {
    const w = await chatWorld();
    expect(await w.chat.sessions.active(w.session.id)).toBe(false);
    await w.chat.sessions.presence({ session: w.session.id, user: w.admin.id, focused: true, typing: false });
    expect(await w.chat.sessions.active(w.session.id)).toBe(true);
    w.advance(w.deps.settings.queue.HARNESS_ACTIVE_WINDOW + 1);
    expect(await w.chat.sessions.active(w.session.id)).toBe(false);
    const bo = await w.user('Bo');
    await expect(w.chat.sessions.presence({ session: w.session.id, user: bo.id, focused: true, typing: true })).rejects.toMatchObject({ code: 'not-found' });
    await settle();
    expect(w.bus.of('presence')).toHaveLength(1);
  });
});
