import { agent, fn, g, hub, type FnRef } from '@harness/sdk';
import { ActorId, QualifiedName, SystemName, type Json, type SearchHit, type Session, type SessionId, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_KIND, type RunInput } from '../execution/index.ts';
import { AGENT, ALICE, calls, executionRig, says, SESSION, until, type ExecutionRig } from '../execution/testing.ts';
import { registerHubFns } from './hub-fns.ts';

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

/** Put a hub fn in the rig's catalog with the contract's args and result. */
function addHubFn<A, R>(r: ExecutionRig, ref: FnRef<QualifiedName, A, R>): void {
  r.catalog.add('hub', ref.name.slice('hub/'.length), fn({ description: ref.name, args: ref.args, returns: ref.returns, tags: ['read'] }));
}

/** A rig with the hub fns registered over its catalog and store, a search that answers `hits`, and a session. */
async function started(hits: SearchHit[] = [], session: Partial<Session> = {}) {
  const r = await executionRig();
  rig = r;
  const { search_fns, load_fns, drop_fns, search_context, load_context, search_resources, ask_user } = hub.fns;
  addHubFn(r, search_fns); addHubFn(r, load_fns); addHubFn(r, drop_fns); addHubFn(r, search_context); addHubFn(r, load_context);
  addHubFn(r, search_resources); addHubFn(r, ask_user);
  r.catalog.add('fs', 'read', fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] }));
  r.catalog.add('shop', 'buy', fn({ description: 'Buy.', args: g.obj({}), returns: g.text() }), { available: { unavailable: 'system-disconnected', detail: 'shop is offline' } });
  const searched: Array<{ text: string; kinds: readonly string[] }> = [];
  const loads: Array<{ session: SessionId; tools?: readonly string[]; context?: readonly string[] }> = [];
  registerHubFns(r.module.hubFns, {
    store: () => r.store,
    catalog: () => r.catalog,
    search: () => ({ search: (query) => { searched.push(query); return Promise.resolve(hits.filter((h) => query.kinds.includes(h.kind))); } }),
    sessions: () => ({
      load: async (id, loaded) => {
        loads.push({ session: id, ...loaded });
        return r.store.table('sessions').update(id, { ...(loaded.tools === undefined ? {} : { tools: [...loaded.tools] }), ...(loaded.context === undefined ? {} : { context: [...loaded.context] }) });
      },
    }),
    handlers: () => r.module.handlers,
  });
  await r.session({ systems: [SystemName.parse('fs'), SystemName.parse('shop')], ...session });
  await r.module.start();
  return { r, searched, loads, turn: await r.turn({ session: SESSION, text: 'hello' }) };
}

/** Run a hub fn in the session's turn and return how it settled. */
async function call(r: ExecutionRig, turn: Turn, name: string, args: Json) {
  const input: RunInput = { fn: QualifiedName.parse(`hub/${name}`), args, turn: turn.id, session: SESSION, key: name, actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [] };
  return (await r.module.runs.start(input)).settled;
}

describe('finding and loading fns', () => {
  it('finds fns by meaning and says which can be used now', async () => {
    const { r, turn, searched } = await started([
      { kind: 'fn', key: 'fs/read', score: 0.9, text: 'read' }, { kind: 'fn', key: 'shop/buy', score: 0.5, text: 'buy' }, { kind: 'context', key: 'fs/guide', score: 1, text: 'g' },
    ]);
    const settled = await call(r, turn, 'search_fns', { query: 'open a file' });
    expect(settled).toEqual({ status: 'done', result: [
      { fn: 'fs/read', description: 'Read a file.', available: true }, { fn: 'shop/buy', description: 'Buy.', available: false },
    ] });
    expect(searched[0]).toMatchObject({ text: 'open a file', kinds: ['fn'], limit: 10 });
  });

  it('loads usable fns into the session and says why the rest were refused', async () => {
    const { r, turn } = await started([], { systems: [SystemName.parse('fs')] });
    const settled = await call(r, turn, 'load_fns', { fns: ['fs/read', 'shop/buy', 'fs/nothing', 'not a name'] });
    expect(settled).toEqual({ status: 'done', result: {
      loaded: ['fs/read'],
      refused: [
        { fn: 'not a name', reason: 'not a qualified fn name (system/name)' },
        { fn: 'shop/buy', reason: 'this session does not use that system' },
        { fn: 'fs/nothing', reason: 'no such fn' },
      ],
    } });
    expect((await r.store.table('sessions').get(SESSION))?.tools).toEqual(['fs/read']);
    expect(await call(r, turn, 'drop_fns', { fns: ['fs/read', 'fs/other'] })).toEqual({ status: 'done', result: { dropped: ['fs/read'] } });
    expect((await r.store.table('sessions').get(SESSION))?.tools).toEqual([]);
  });

  it('refuses outside a chat session', async () => {
    const { r } = await started();
    const loose = await r.turn();
    const input: RunInput = { fn: QualifiedName.parse('hub/search_fns'), args: { query: 'x' }, turn: loose.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [] };
    expect(await (await r.module.runs.start(input)).settled).toMatchObject({ status: 'failed', error: { message: 'this fn only works inside a chat session' } });
  });
});

describe('context and resources', () => {
  it('finds and loads context the session can use', async () => {
    const { r, turn } = await started([{ kind: 'context', key: 'fs/guide', score: 1, text: 'guide' }]);
    r.catalog.contexts.set(QualifiedName.parse('fs/guide'), 'How to work with files.');
    expect(await call(r, turn, 'search_context', { query: 'files' })).toEqual({ status: 'done', result: [{ context: 'fs/guide', description: 'guide' }] });
    expect(await call(r, turn, 'load_context', { context: ['fs/guide', 'fs/missing'] })).toEqual({ status: 'done', result: { loaded: ['fs/guide'] } });
    expect((await r.store.table('sessions').get(SESSION))?.context).toEqual(['fs/guide']);
  });

  it('searches sections and gives each hit its resource, section, title and preview, narrowed to roots', async () => {
    const { r, turn } = await started([
      { kind: 'section', key: 'file:///repo/README.md#Intro', score: 0.8, text: 'README.md > Intro\n\nA harness.' },
      { kind: 'section', key: 'file:///other/notes.md#Top', score: 0.4, text: 'notes.md\n\nElsewhere.' },
    ]);
    expect(await call(r, turn, 'search_resources', { query: 'harness', roots: ['file:///repo'] })).toEqual({ status: 'done', result: [
      { uri: 'file:///repo/README.md', section: 'Intro', title: 'README.md > Intro', preview: 'README.md > Intro\n\nA harness.', score: 0.8 },
    ] });
  });
});

describe('asking a person', () => {
  it('asks the turn\'s user as a handler call and returns their answer', async () => {
    const { r, turn } = await started();
    const asked = call(r, turn, 'ask_user', { question: 'Which branch?' });
    await until(async () => (await r.store.table('handlerCalls').find({ limit: 1 })).items.length === 1, 'the question to be asked');
    const [question] = (await r.store.table('handlerCalls').find({ limit: 1 })).items;
    expect(question).toMatchObject({ handler: 'ask_user', args: { question: 'Which branch?' }, answerer: { user: ALICE }, decl: { description: 'Which branch?' } });
    if (question === undefined) { throw new Error('no question'); }
    await r.module.handlers.answer(question.id, { answer: 'main' }, ActorId.parse(ALICE));
    expect(await asked).toEqual({ status: 'done', result: { answer: 'main' } });
  });
});

/** The chat agent: it starts with only the hub fns that find and load the rest. */
function chatAgent(maxTools = 32) {
  return agent({
    description: 'Chats.', args: g.obj({}), returns: g.text(), instructions: 'Help with files.', maxTools,
    tools: [hub.fns.search_fns, hub.fns.load_fns, hub.fns.load_context],
  });
}

/** Start the chat agent on the session's turn and wait for how it settles. */
async function answer(r: ExecutionRig, turn: Turn): Promise<unknown> {
  const { run } = await r.module.agents.start({
    kind: AGENT_KIND, fn: QualifiedName.parse('tools/chat'), args: {}, turn: turn.id, session: SESSION, key: 'answer', actor: ALICE, caller: AGENT,
    priority: 'interactive', background: false, handlers: [],
  });
  return r.module.runs.wait(run);
}

/** The tool names and the system prompt of one request the model was sent. */
function sent(r: ExecutionRig, index: number): { tools: string[]; system: string } {
  const request = r.provider.requests[index];
  const first = request?.messages[0];
  return { tools: (request?.tools ?? []).map((t) => t.name).sort(), system: first?.role !== 'system' ? '' : typeof first.content === 'string' ? first.content : JSON.stringify(first.content) };
}

describe('the chat agent reaching system fns', () => {
  it('searches, loads a fn and context, then calls the loaded fn in the next iteration', async () => {
    const { r, turn } = await started([{ kind: 'fn', key: 'fs/read', score: 0.9, text: 'read' }], { systems: [SystemName.parse('fs')] });
    r.catalog.add('tools', 'chat', chatAgent());
    r.catalog.contexts.set(QualifiedName.parse('fs/guide'), 'How to work with files.');
    const files = r.connect('fs');
    files.behaviour.run = () => Promise.resolve({ status: 'done', result: 'hello from a.txt' });
    // the scripted model reuses its tool call ids each iteration (call_1, call_2), as some real models do
    r.provider.script(
      calls([['hub__search_fns', { query: 'read a file' }]]),
      calls([['hub__load_fns', { fns: ['fs/read'] }], ['hub__load_context', { context: ['fs/guide'] }]]),
      calls([['fs__read', { path: 'a.txt' }]]),
      says('It says hello.'),
    );
    expect(await answer(r, turn)).toEqual({ status: 'done', result: 'It says hello.' });

    expect(sent(r, 0).tools).toEqual(['hub__load_context', 'hub__load_fns', 'hub__search_fns']);
    expect(sent(r, 0).system).not.toContain('<context');
    expect(sent(r, 2).tools).toEqual(['fs__read', 'hub__load_context', 'hub__load_fns', 'hub__search_fns']);
    expect(sent(r, 2).system).toContain('<context name="fs/guide">\nHow to work with files.\n</context>');
    expect(files.requests.map((q) => [q.fn, q.args])).toEqual([['read', { path: 'a.txt' }]]);
    expect(await r.store.table('sessions').get(SESSION)).toMatchObject({ tools: ['fs/read'], context: ['fs/guide'] });
  });

  it('offers only loaded fns that are on, available and of the session’s systems, its own tools first, up to its cap', async () => {
    const { r, turn } = await started([], { systems: [SystemName.parse('fs'), SystemName.parse('shop')], tools: ['fs/write', 'fs/off', 'shop/buy', 'other/peek', 'fs/read'] });
    r.catalog.add('tools', 'chat', chatAgent(4));
    r.catalog.add('fs', 'write', fn({ description: 'Write.', args: g.obj({}), returns: g.text(), tags: ['read'] }));
    r.catalog.add('fs', 'off', fn({ description: 'Off.', args: g.obj({}), returns: g.text(), tags: ['read'] }), { disabled: true });
    r.catalog.add('other', 'peek', fn({ description: 'Peek.', args: g.obj({}), returns: g.text(), tags: ['read'] }));
    r.provider.script(says('ok'));
    expect(await answer(r, turn)).toEqual({ status: 'done', result: 'ok' });
    // shop/buy is unavailable, fs/off switched off, other/peek of a system the session doesn't use; the cap of 4 drops fs/read
    expect(sent(r, 0).tools).toEqual(['fs__write', 'hub__load_context', 'hub__load_fns', 'hub__search_fns']);
  });
});
