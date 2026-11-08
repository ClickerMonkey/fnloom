import { IDS, SystemName, type OutgoingPart, type Participant } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { agentActorId } from './support.ts';
import { CLIENT, LIMITS, chatWorld, gin, makeRun, settle } from './testing.ts';
import { plainText } from './turns.ts';

const chatAgent = agentActorId('hub/chat');

/** Add a person to a session. */
async function addPerson(w: Awaited<ReturnType<typeof chatWorld>>, name: string, notify: Participant['notify'] = 'all') {
  const person = await w.user(name);
  const row = await w.store.table('sessions').get(w.session.id);
  await w.store.table('sessions').update(w.session.id, { participants: [...(row?.participants ?? []), { actor: person.id, role: 'member', notify, joinedAt: 0 }] });
  return person;
}

describe('sending a message', () => {
  it('stores the turn and message, wakes the agent, and names the session', async () => {
    const w = await chatWorld();
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text: 'Plan a trip to Lisbon' }], client: CLIENT });
    expect(sent.message).toMatchObject({ session: w.session.id, turn: sent.turn, author: w.admin.id, role: 'user', status: 'done', replyAll: false, answerers: [chatAgent] });
    expect(sent.message.parts[0]).toEqual({ type: 'text', text: 'Plan a trip to Lisbon' });
    expect(sent.message.parts[1]).toMatchObject({ type: 'extra', extra: 'local-time' });
    const turn = await w.store.table('turns').get(sent.turn);
    expect(turn).toMatchObject({ session: w.session.id, message: sent.message.id, actor: w.admin.id, status: 'running', limits: LIMITS, cost: 0, errors: { max: 3 }, client: CLIENT });
    expect(turn?.user).toMatchObject({ id: w.admin.id, timeZone: 'America/New_York', locale: 'en-US', groups: [] });
    expect(turn?.time.local).toBe('2026-11-07T09:30:00-05:00');
    expect(w.agents.started).toEqual([expect.objectContaining({
      kind: 'hub/llm', fn: 'hub/chat', turn: sent.turn, session: w.session.id, actor: w.admin.id, caller: chatAgent, priority: 'interactive', background: false,
      budget: { cost: LIMITS.turn.cost, time: LIMITS.turn.time },
    })]);
    expect((await w.store.table('turns').get(sent.turn))?.root).toBeDefined();
    const session = await w.store.table('sessions').get(w.session.id);
    expect(session).toMatchObject({ title: 'Plan a trip to Lisbon', status: 'running' });
    expect(w.limits.asked[0]).toMatchObject({ session: w.session.id, turn: sent.turn });
    await settle();
    expect(w.bus.of('message').map((e) => e.message.id)).toEqual([sent.message.id]);
  });

  it('keeps errors flowing back to the agent when the turn error limit is 0', async () => {
    const w = await chatWorld();
    const deps = { ...w.deps, settings: { ...w.deps.settings, chat: { ...w.deps.settings.chat, HARNESS_TURN_ERRORS: 0 } } };
    const { createChat } = await import('./chat.ts');
    const chat = createChat(deps);
    const sent = await chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text: 'x' }], client: CLIENT });
    expect((await w.store.table('turns').get(sent.turn))?.errors).toBe('feed-back');
  });

  it('writes each mention\'s LLM text at send time, asking its system as the person', async () => {
    const w = await chatWorld();
    w.catalog.addEntry('mentions', 'crm/rows', { name: 'rows', title: 'Rows', description: 'Rows.', target: gin({ name: 'obj', props: { id: { type: { name: 'text' } } } }) });
    const crm = w.link.connect('crm', { mentionText: async ({ target, user, time }) => Promise.resolve({ text: `Row ${JSON.stringify(target)} for ${user.name} at ${time.local}` }) });
    const sent = await w.chat.turns.send({
      session: w.session.id, author: w.admin.id, client: CLIENT,
      parts: [{ type: 'text', text: 'Look at ' }, { type: 'mention', provider: 'crm/rows', label: 'Acme', target: { id: '42' } }],
    });
    expect(sent.message.parts[1]).toEqual({ type: 'mention', provider: 'crm/rows', label: 'Acme', target: { id: '42' }, text: 'Row {"id":"42"} for Ada at 2026-11-07T09:30:00-05:00' });
    expect(crm.calls[0]?.data).toMatchObject({ session: w.session.id, actor: w.admin.id, provider: 'rows', target: { id: '42' } });
    expect((await w.store.table('sessions').get(w.session.id))?.title).toBe('Look at @Acme');
  });

  it('falls back to a plain mention text when the system can\'t be asked', async () => {
    const w = await chatWorld();
    w.catalog.addEntry('mentions', 'crm/rows', { name: 'rows', title: 'Rows', description: 'Rows.', target: gin({ name: 'any' }) });
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'mention', provider: 'crm/rows', label: 'Acme', target: 1 }] });
    expect(sent.message.parts[0]).toMatchObject({ type: 'mention', text: '"Acme" from crm/rows (its details could not be fetched when this was sent).' });
    expect(w.logs.some((l) => l.msg === 'chat.mention.text.failed')).toBe(true);
  });

  it('refuses a mention target that isn\'t the provider\'s type, an unknown provider, and one the session excludes', async () => {
    const w = await chatWorld({ systems: [SystemName.parse('crm')] });
    w.catalog.addEntry('mentions', 'crm/rows', { name: 'rows', title: 'Rows', description: 'Rows.', target: gin({ name: 'text' }) });
    w.catalog.checker = (_, type, value) => (type.name === 'text' && typeof value !== 'string' ? ['expected text'] : []);
    const send = (provider: `${string}/${string}`, target: number | string) => w.chat.turns.send({
      session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'mention', provider, label: 'x', target }],
    });
    await expect(send('crm/rows', 42)).rejects.toMatchObject({ code: 'invalid' });
    await expect(send('crm/none', 42)).rejects.toMatchObject({ code: 'not-found' });
    await expect(send('fs/files', 42)).rejects.toMatchObject({ code: 'unavailable' });
    w.catalog.unavailable.set('crm/rows', { unavailable: 'system-disconnected', detail: 'crm is offline' });
    await expect(send('crm/rows', 42)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await w.store.table('turns').count()).toBe(0);
  });

  it('resolves the hub\'s own mentions in the hub', async () => {
    const w = await chatWorld();
    w.catalog.addFn('fs', { name: 'read', description: 'Read a file.' });
    w.catalog.addEntry('mentions', 'hub/fns', { name: 'fns', title: 'Fns', description: 'Fns.', target: gin({ name: 'any' }) });
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'mention', provider: 'hub/fns', label: 'read', target: { fn: 'fs/read' } }] });
    expect(sent.message.parts[0]).toMatchObject({ text: 'The fn fs/read of the fs system: Read a file.' });
  });

  it('adds what hooks load to the session\'s tools and context, when usable', async () => {
    const w = await chatWorld();
    w.catalog.addEntry('hooks', 'git/load', { name: 'load', description: 'Loads.', order: 0, timeout: 1_000 });
    w.catalog.unavailable.set('git/off', { unavailable: 'disabled', detail: 'off' });
    w.link.connect('git', { hook: async () => Promise.resolve([{ type: 'load', fns: ['git/log', 'git/off'], context: ['git/guide'] }]) });
    await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'x' }] });
    const session = await w.store.table('sessions').get(w.session.id);
    expect(session?.tools).toEqual(['git/log']);
    expect(session?.context).toEqual(['git/guide']);
  });

  it('refuses an empty message', async () => {
    const w = await chatWorld();
    for (const parts of [[], [{ type: 'text', text: '  ' }]] satisfies OutgoingPart[][]) {
      await expect(w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts })).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(await w.store.table('turns').count({ session: w.session.id })).toBe(0);
  });

  it('pulls in the context of each /command, refusing unknown, excluded, unusable and incomplete ones', async () => {
    const w = await chatWorld({ systems: [SystemName.parse('git')] });
    w.catalog.addContext('git', { name: 'guide', command: { name: 'guide', args: [{ name: 'topic', hint: 'What about', required: true }] } });
    w.catalog.addContext('git', { name: 'plain' });
    w.catalog.addContext('crm', { name: 'deals', command: { name: 'deals', args: [] } });
    const send = async (part: OutgoingPart) => w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [part] });
    await expect(send({ type: 'command', context: 'git/none', args: {} })).rejects.toMatchObject({ code: 'not-found' });
    await expect(send({ type: 'command', context: 'git/plain', args: {} })).rejects.toMatchObject({ code: 'not-found' });
    await expect(send({ type: 'command', context: 'crm/deals', args: {} })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(send({ type: 'command', context: 'git/guide', args: { topic: ' ' } })).rejects.toMatchObject({ code: 'invalid' });
    w.catalog.unavailable.set('git/guide', { unavailable: 'disabled', detail: 'off' });
    await expect(send({ type: 'command', context: 'git/guide', args: { topic: 'rebase' } })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await w.store.table('turns').count({ session: w.session.id })).toBe(0);
    w.catalog.unavailable.delete('git/guide');
    await send({ type: 'command', context: 'git/guide', args: { topic: 'rebase' } });
    expect((await w.store.table('sessions').get(w.session.id))?.context).toEqual(['git/guide']);
  });

  it('moves agents still busy in the session to the background before waking the next', async () => {
    const w = await chatWorld();
    await w.store.table('runs').insert(makeRun({ id: IDS.run.parse('run_old'), fn: 'hub/chat', kind: 'hub/llm', turn: IDS.turn.parse('trn_old'), actor: w.admin.id, session: w.session.id, status: 'waiting' }));
    await w.store.table('runs').insert(makeRun({ id: IDS.run.parse('run_child'), fn: 'hub/chat', kind: 'hub/llm', turn: IDS.turn.parse('trn_old'), actor: w.admin.id, session: w.session.id, status: 'running', parent: IDS.run.parse('run_old') }));
    await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'actually, stop' }] });
    expect(w.agents.interrupted).toEqual(['run_old']);
    expect(w.agents.started).toHaveLength(1);
  });

  it('wakes no agent when several people talk among themselves, and tells the person replied to', async () => {
    const w = await chatWorld();
    const bo = await addPerson(w, 'Bo');
    const first = await w.chat.turns.send({ session: w.session.id, author: bo.id, client: CLIENT, parts: [{ type: 'text', text: 'Lunch?' }] });
    expect(first.message.answerers).toEqual([]);
    const quiet = await w.store.table('turns').get(first.turn);
    expect(quiet?.status).toBe('done');
    expect(quiet?.endedAt).toBeTypeOf('number');
    w.push.subscribed.add(bo.id);
    const reply = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, replyTo: first.message.id, parts: [{ type: 'text', text: 'Sure, at noon.' }] });
    expect(reply.message.replyTo).toBe(first.message.id);
    expect(w.agents.started).toHaveLength(0);
    const inbox = await w.chat.notifications.list(bo.id, {});
    expect(inbox.items).toEqual([expect.objectContaining({ reason: 'replied', body: 'Sure, at noon.', link: { session: w.session.id }, pushed: true })]);
    expect(w.push.sent.map((p) => p.user)).toEqual([w.admin.id, bo.id]);
    expect((await w.chat.notifications.list(w.admin.id, {})).items).toEqual([expect.objectContaining({ reason: 'message', title: `New message in ${w.session.title}`, body: 'Lunch?' })]);
  });

  it('tells everyone who chose all about a message from another person, but not those who chose replies or none, or who are looking', async () => {
    const w = await chatWorld();
    const bo = await addPerson(w, 'Bo', 'all');
    const cy = await addPerson(w, 'Cy', 'replies');
    const di = await addPerson(w, 'Di', 'none');
    const ed = await addPerson(w, 'Ed', 'all');
    await w.chat.sessions.presence({ session: w.session.id, user: ed.id, focused: true, typing: false });
    await w.chat.turns.send({ session: w.session.id, author: bo.id, client: CLIENT, parts: [{ type: 'text', text: 'Standup moved to **ten**.' }] });
    expect((await w.chat.notifications.list(w.admin.id, {})).items).toEqual([expect.objectContaining({ reason: 'message', body: 'Standup moved to ten.', link: { session: w.session.id } })]);
    for (const quiet of [bo, cy, di, ed]) expect((await w.chat.notifications.list(quiet.id, {})).items).toEqual([]);
  });

  it('tells the person replied to once, as a reply, even when they chose all', async () => {
    const w = await chatWorld();
    const bo = await addPerson(w, 'Bo', 'all');
    const first = await w.chat.turns.send({ session: w.session.id, author: bo.id, client: CLIENT, parts: [{ type: 'text', text: 'Lunch?' }] });
    await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, replyTo: first.message.id, parts: [{ type: 'text', text: 'Yes.' }] });
    expect((await w.chat.notifications.list(bo.id, {})).items.map((n) => n.reason)).toEqual(['replied']);
  });

  it('wakes every agent on reply-all', async () => {
    const w = await chatWorld();
    await addPerson(w, 'Bo');
    w.catalog.addFn('crm', { name: 'coach', kind: 'hub/llm' });
    await w.chat.sessions.update(w.session.id, { agent: 'crm/coach' }, w.admin.id);
    const row = await w.store.table('sessions').get(w.session.id);
    await w.store.table('sessions').update(w.session.id, { participants: [...(row?.participants ?? []), { actor: chatAgent, role: 'agent', notify: 'none', joinedAt: 0 }] });
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, replyAll: true, parts: [{ type: 'text', text: 'Ideas?' }] });
    expect(sent.message.answerers).toEqual([agentActorId('crm/coach'), chatAgent]);
    expect(w.agents.started.map((s) => s.fn)).toEqual(['crm/coach', 'hub/chat']);
  });

  it('refuses replies into another session, archived sessions, outsiders and agents', async () => {
    const w = await chatWorld();
    const other = await w.chat.sessions.create({ owner: w.admin.id });
    const there = await w.chat.turns.send({ session: other.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'x' }] });
    await expect(w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, replyTo: there.message.id, parts: [{ type: 'text', text: 'y' }] })).rejects.toMatchObject({ code: 'invalid' });
    const bo = await w.user('Bo');
    await expect(w.chat.turns.send({ session: w.session.id, author: bo.id, client: CLIENT, parts: [{ type: 'text', text: 'y' }] })).rejects.toMatchObject({ code: 'not-found' });
    await expect(w.chat.turns.send({ session: w.session.id, author: chatAgent, client: CLIENT, parts: [{ type: 'text', text: 'y' }] })).rejects.toMatchObject({ code: 'forbidden' });
    await w.chat.sessions.update(w.session.id, { archived: true }, w.admin.id);
    await expect(w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'y' }] })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('fails the turn when no agent could be started', async () => {
    const w = await chatWorld();
    w.agents.failWith = new Error('queue down');
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'x' }] });
    expect((await w.store.table('turns').get(sent.turn))?.status).toBe('failed');
    expect((await w.store.table('sessions').get(w.session.id))?.status).toBe('idle');
    expect(w.logs.some((l) => l.msg === 'chat.turn.wake.failed')).toBe(true);
  });
});

describe('running a fn by hand', () => {
  it('starts the run, records an invocation message, and settles the turn with the run', async () => {
    const w = await chatWorld();
    w.catalog.addFn('fs', { name: 'ls' });
    const { turn, run } = await w.chat.turns.invoke({ session: w.session.id, author: w.admin.id, fn: 'fs/ls', args: { path: '.' }, client: CLIENT });
    expect(w.runs.started[0]).toMatchObject({ fn: 'fs/ls', args: { path: '.' }, turn, session: w.session.id, key: 'invoke', actor: w.admin.id, caller: w.admin.id });
    const message = (await w.chat.sessions.messages(w.session.id, w.admin.id, {})).items[0];
    expect(message).toMatchObject({ role: 'user', parts: [{ type: 'invocation', run, fn: 'fs/ls' }], runs: [run], answerers: [] });
    expect((await w.store.table('turns').get(turn))).toMatchObject({ status: 'running', root: run, message: message?.id });
    w.runs.finish(run, { status: 'done', result: ['a'] });
    await settle();
    expect((await w.store.table('turns').get(turn))?.status).toBe('done');
    expect((await w.store.table('sessions').get(w.session.id))?.status).toBe('idle');
  });

  it('puts what the run attaches on a message of its own by the system, with the run card, since no agent answers', async () => {
    const w = await chatWorld();
    w.catalog.addFn('fs', { name: 'edit' });
    const fsActor = IDS.actor.parse('act_fs');
    await w.store.table('systems').insert({
      name: SystemName.parse('fs'), description: 'Files.', status: 'connected', enabled: { functions: true, renderers: true },
      version: '1', manifestHash: 'h', actor: fsActor,
    });
    const { turn, run } = await w.chat.turns.invoke({ session: w.session.id, author: w.admin.id, fn: 'fs/edit', args: { path: 'a.md' }, client: CLIENT });
    if ((await w.store.table('runs').get(run)) === undefined) {
      await w.store.table('runs').insert(makeRun({ id: run, fn: 'fs/edit', turn, actor: w.admin.id, session: w.session.id }));
    }
    const diff = { type: 'attachment' as const, attachment: 'fs/diff' as const, data: { path: 'a.md' }, title: 'a.md' };
    const carrier = await w.chat.turns.attach(run, diff);
    expect(carrier).toMatchObject({ role: 'assistant', author: fsActor, turn, parts: [diff], runs: [run], status: 'done' });
    // a second attachment joins the same message
    expect((await w.chat.turns.attach(run, diff)).id).toBe(carrier.id);
    const roles = (await w.chat.sessions.messages(w.session.id, w.admin.id, {})).items.map((m) => m.role).sort();
    expect(roles).toEqual(['assistant', 'user']);
  });

  it('ends the turn as the run did', async () => {
    const w = await chatWorld();
    w.catalog.addFn('fs', { name: 'ls' });
    const failed = await w.chat.turns.invoke({ session: w.session.id, author: w.admin.id, fn: 'fs/ls', args: {}, client: CLIENT });
    w.runs.finish(failed.run, { status: 'failed', error: { class: 'caller', message: 'no' } });
    const cancelled = await w.chat.turns.invoke({ session: w.session.id, author: w.admin.id, fn: 'fs/ls', args: {}, client: CLIENT });
    w.runs.finish(cancelled.run, { status: 'cancelled' });
    const lost = await w.chat.turns.invoke({ session: w.session.id, author: w.admin.id, fn: 'fs/ls', args: {}, client: CLIENT });
    w.runs.lose(lost.run, new Error('worker gone'));
    await settle();
    expect((await w.store.table('turns').get(lost.turn))?.status).toBe('failed');
    expect(w.logs.some((l) => l.msg === 'chat.turn.invoke.failed')).toBe(true);
    expect((await w.store.table('turns').get(failed.turn))?.status).toBe('failed');
    expect((await w.store.table('turns').get(cancelled.turn))?.status).toBe('cancelled');
  });

  it('fails the turn, and passes the refusal on, when the run is refused before it starts', async () => {
    const w = await chatWorld();
    w.catalog.addFn('fs', { name: 'rm' });
    w.runs.refuseStart = new Error('denied by policy');
    await expect(w.chat.turns.invoke({ session: w.session.id, author: w.admin.id, fn: 'fs/rm', args: {}, client: CLIENT })).rejects.toThrow('denied by policy');
    const turn = (await w.store.table('turns').find({ where: { session: w.session.id }, limit: 1 })).items[0];
    expect(turn?.status).toBe('failed');
    expect((await w.store.table('sessions').get(w.session.id))?.status).toBe('idle');
  });

  it('refuses unknown fns, fns of excluded systems and unavailable fns', async () => {
    const w = await chatWorld({ systems: [SystemName.parse('fs')] });
    w.catalog.addFn('crm', { name: 'find' });
    const off = w.catalog.addFn('fs', { name: 'off' });
    w.catalog.fnRecords.set(off.name, { ...off, available: { unavailable: 'system-disconnected', detail: 'fs is offline' } });
    await expect(w.chat.turns.invoke({ session: w.session.id, author: w.admin.id, fn: 'fs/none', args: {}, client: CLIENT })).rejects.toMatchObject({ code: 'not-found' });
    await expect(w.chat.turns.invoke({ session: w.session.id, author: w.admin.id, fn: 'crm/find', args: {}, client: CLIENT })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(w.chat.turns.invoke({ session: w.session.id, author: w.admin.id, fn: 'fs/off', args: {}, client: CLIENT })).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('an agent\'s answer', () => {
  it('streams into an open message that pages show mid-stream, then finishes', async () => {
    const w = await chatWorld();
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'hi' }] });
    const answer = await w.chat.turns.begin({ turn: sent.turn, author: chatAgent });
    expect(answer).toMatchObject({ role: 'assistant', status: 'streaming', replyTo: sent.message.id, parts: [] });
    w.chat.turns.stream(answer.id, { text: 'Hel' });
    w.chat.turns.stream(answer.id, { text: 'lo', reasoning: 'greet' });
    expect((await w.chat.sessions.messages(w.session.id, w.admin.id, {})).items[0]?.parts).toEqual([{ type: 'reasoning', text: 'greet' }, { type: 'text', text: 'Hello' }]);
    // the reasoning is kept with the answer, so it is still there after a reload
    const done = await w.chat.turns.finish(answer.id, [{ type: 'text', text: 'Hello!' }], 'done');
    expect(done).toMatchObject({ status: 'done', parts: [{ type: 'reasoning', text: 'greet' }, { type: 'text', text: 'Hello!' }] });
    w.chat.turns.stream(answer.id, { text: 'late' });
    expect((await w.chat.sessions.messages(w.session.id, w.admin.id, {})).items[0]?.parts).toEqual([{ type: 'reasoning', text: 'greet' }, { type: 'text', text: 'Hello!' }]);
    await settle();
    expect(w.bus.of('message.token').map((t) => t.text)).toEqual(['Hel', 'lo']);
    expect(w.bus.of('message.reasoning')).toEqual([{ session: w.session.id, message: answer.id, text: 'greet' }]);
    expect(w.logs.some((l) => l.msg === 'chat.stream.closed')).toBe(true);
  });

  it('refuses to open an answer outside a session turn, or to finish a user message', async () => {
    const w = await chatWorld();
    await expect(w.chat.turns.begin({ turn: IDS.turn.parse('trn_none'), author: chatAgent })).rejects.toMatchObject({ code: 'not-found' });
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'hi' }] });
    await expect(w.chat.turns.finish(sent.message.id, [], 'done')).rejects.toMatchObject({ code: 'conflict' });
    await expect(w.chat.turns.finish(IDS.message.parse('msg_none'), [], 'done')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('tells a person away that the turn they started finished, with the answer', async () => {
    const w = await chatWorld();
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'text', text: 'Summarise' }] });
    const answer = await w.chat.turns.begin({ turn: sent.turn, author: chatAgent });
    await w.chat.turns.finish(answer.id, [{ type: 'text', text: 'Here is the summary.' }], 'done');
    expect((await w.chat.notifications.list(w.admin.id, {})).items).toEqual([]);
    await w.chat.turns.settle(sent.turn, 'done');
    await w.chat.turns.settle(sent.turn, 'failed');
    const inbox = await w.chat.notifications.list(w.admin.id, {});
    expect(inbox.items).toEqual([expect.objectContaining({ reason: 'turn-finished', title: 'Summarise finished', body: 'Here is the summary.', link: { session: w.session.id }, pushed: false })]);
    expect((await w.store.table('turns').get(sent.turn))?.status).toBe('done');
    expect((await w.store.table('sessions').get(w.session.id))?.status).toBe('idle');
  });

  it('does not tell people who are looking, or who chose replies only for others\' turns', async () => {
    const w = await chatWorld();
    const bo = await addPerson(w, 'Bo', 'replies');
    await w.chat.sessions.presence({ session: w.session.id, user: w.admin.id, focused: true, typing: false });
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, replyAll: true, parts: [{ type: 'text', text: 'x' }] });
    await w.chat.turns.settle(sent.turn, 'cancelled');
    expect((await w.chat.notifications.list(w.admin.id, {})).items).toEqual([]);
    expect((await w.chat.notifications.list(bo.id, {})).items).toEqual([]);
  });

  it('tells another person when an agent answers their message in someone else\'s turn', async () => {
    const w = await chatWorld();
    const bo = await addPerson(w, 'Bo');
    const theirs = await w.chat.turns.send({ session: w.session.id, author: bo.id, client: CLIENT, parts: [{ type: 'text', text: 'What is 2+2?' }] });
    const mine = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, replyAll: true, parts: [{ type: 'text', text: 'Agents, answer Bo' }] });
    const answer = await w.chat.turns.begin({ turn: mine.turn, author: chatAgent, replyTo: theirs.message.id });
    await w.chat.turns.finish(answer.id, [{ type: 'text', text: '4' }], 'done');
    const inbox = (await w.chat.notifications.list(bo.id, {})).items;
    expect(inbox.filter((n) => n.reason === 'replied')).toEqual([expect.objectContaining({ body: '4' })]);
    expect(inbox.filter((n) => n.reason === 'message')).toEqual([expect.objectContaining({ body: 'Agents, answer Bo' })]);
  });
});

describe('following up', () => {
  it('wakes the session agent in a new turn of the same person, with no message, once nobody is answering', async () => {
    const w = await chatWorld();
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text: 'Run the build' }], client: CLIENT });
    expect(await w.chat.turns.followUp({ turn: sent.turn, agent: chatAgent })).toBeUndefined();
    const answering = (await w.store.table('runs').find({ where: { turn: sent.turn }, limit: 1 })).items[0];
    if (answering === undefined) throw new Error('no agent run');
    await w.store.table('runs').update(answering.id, { status: 'done' });
    await w.chat.turns.settle(sent.turn, 'done');
    const turn = await w.chat.turns.followUp({ turn: sent.turn, agent: chatAgent });
    if (turn === undefined) throw new Error('no follow-up turn');
    const record = await w.store.table('turns').get(turn);
    expect(record).toMatchObject({ session: w.session.id, actor: w.admin.id, status: 'running', client: CLIENT });
    expect(record?.root).toBeTypeOf('string');
    expect(record?.message).toBeUndefined();
    expect(w.agents.started.at(-1)).toMatchObject({ kind: 'hub/llm', fn: 'hub/chat', turn, session: w.session.id, actor: w.admin.id, caller: chatAgent });
    expect((await w.store.table('sessions').get(w.session.id))?.status).toBe('running');
  });

  it('starts nothing for a turn outside a session or a session that is archived', async () => {
    const w = await chatWorld();
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text: 'hi' }], client: CLIENT });
    for (const run of (await w.store.table('runs').find({ where: { turn: sent.turn }, limit: 5 })).items) await w.store.table('runs').update(run.id, { status: 'done' });
    await w.store.table('sessions').update(w.session.id, { archived: true });
    expect(await w.chat.turns.followUp({ turn: sent.turn, agent: chatAgent })).toBeUndefined();
    expect(await w.chat.turns.followUp({ turn: IDS.turn.parse('trn_none'), agent: chatAgent })).toBeUndefined();
    expect(w.agents.started).toHaveLength(1);
  });
});

describe('plain text of parts', () => {
  it('reads like what the person wrote', () => {
    expect(plainText([
      { type: 'text', text: 'Run ' },
      { type: 'command', context: 'fs/plan', args: { goal: 'ship' } },
      { type: 'text', text: ' on ' },
      { type: 'mention', provider: 'fs/files', label: 'a.md', target: null, text: '' },
      { type: 'extra', extra: 'local-time', blocks: [] },
    ])).toBe('Run /plan ship on @a.md');
  });
});

describe('runs and attachments on an assistant message', () => {
  /** A sent turn with the agent's message begun, and one of its tool runs stored. */
  async function answering() {
    const w = await chatWorld();
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text: 'Read the docs' }], client: CLIENT });
    const answer = await w.chat.turns.begin({ turn: sent.turn, author: chatAgent });
    const run = makeRun({ id: IDS.run.parse('run_tool'), fn: 'fs/read', turn: sent.turn, actor: w.admin.id, session: w.session.id });
    await w.store.table('runs').insert(run);
    return { w, sent, answer, run };
  }

  it('records the tool runs the agent started on its message, once each, and announces the change', async () => {
    const { w, answer, run } = await answering();
    await w.chat.turns.track(answer.id, [run.id]);
    await w.chat.turns.track(answer.id, [run.id]);
    await settle();
    expect((await w.store.table('messages').get(answer.id))?.runs).toEqual([run.id]);
    expect(w.bus.of('message').filter((e) => e.message.id === answer.id && e.message.runs.length === 1)).toHaveLength(1);
  });

  it('attaches a run\'s attachment to the turn\'s latest answer, and finishing keeps it', async () => {
    const { w, answer, run } = await answering();
    await w.chat.turns.attach(run.id, { type: 'attachment', attachment: 'fs/diff', data: { path: 'a.md' }, title: 'a.md' });
    const finished = await w.chat.turns.finish(answer.id, [{ type: 'text', text: 'Done.' }], 'done');
    expect(finished.parts).toEqual([{ type: 'text', text: 'Done.' }, { type: 'attachment', attachment: 'fs/diff', data: { path: 'a.md' }, title: 'a.md' }]);
    expect(finished.runs).toEqual([run.id]);
  });

  it('refuses to attach for a run outside a session, or before the turn has an answer', async () => {
    const w = await chatWorld();
    const loose = makeRun({ id: IDS.run.parse('run_loose'), fn: 'fs/read', turn: IDS.turn.parse('trn_loose'), actor: w.admin.id });
    await w.store.table('runs').insert(loose);
    await expect(w.chat.turns.attach(loose.id, { type: 'link', link: { url: 'https://example.com', title: 'x' } })).rejects.toThrow(/no session/);
    const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, parts: [{ type: 'text', text: 'hi' }], client: CLIENT });
    const early = makeRun({ id: IDS.run.parse('run_early'), fn: 'fs/read', turn: sent.turn, actor: w.admin.id, session: w.session.id });
    await w.store.table('runs').insert(early);
    await expect(w.chat.turns.attach(early.id, { type: 'link', link: { url: 'https://example.com', title: 'x' } })).rejects.toThrow(/no assistant message/);
  });
});

describe('loading fns and context into a session', () => {
  it('replaces the session\'s loaded tools and context and announces the change', async () => {
    const w = await chatWorld();
    const loaded = await w.chat.sessions.load(w.session.id, { tools: ['fs/read'], context: ['fs/guide'] });
    expect(loaded).toMatchObject({ tools: ['fs/read'], context: ['fs/guide'] });
    const again = await w.chat.sessions.load(w.session.id, { tools: [] });
    expect(again).toMatchObject({ tools: [], context: ['fs/guide'] });
    await settle();
    expect(w.bus.of('session.changed').length).toBeGreaterThanOrEqual(2);
  });
});
