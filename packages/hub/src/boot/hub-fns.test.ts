import { agent, fn, g, hub, type FnRef } from '@harness/sdk';
import { ActorId, LinkSession, QualifiedName, SystemName, type Json, type SearchHit, type Session, type SessionId, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_KIND, type RunInput } from '../execution/index.ts';
import { AGENT, ALICE, calls, executionRig, says, SESSION, until, type ExecutionRig } from '../execution/testing.ts';
import { openScope, type AccessScope } from '../access/index.ts';
import { registerHubFns } from './hub-fns.ts';
import { linkPayload } from '../testing.ts';

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

/** Put a hub fn in the rig's catalog with the contract's args and result. */
function addHubFn<A, R>(r: ExecutionRig, ref: FnRef<QualifiedName, A, R>): void {
  r.catalog.add('hub', ref.name.slice('hub/'.length), fn({ description: ref.name, args: ref.args, returns: ref.returns, tags: ['read'] }));
}

/**
 * A rig with the hub fns registered over its catalog and store, a search that answers `hits` (keeping to its `keep`),
 * a session, and the run's person seeing what `access` lets them (everything by default).
 */
async function started(hits: SearchHit[] = [], session: Partial<Session> = {}, access: (actor: ActorId) => AccessScope = openScope) {
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
    search: () => ({
      search: async (query) => {
        searched.push(query);
        const kept: SearchHit[] = [];
        for (const hit of hits) { if (query.kinds.includes(hit.kind) && (query.keep === undefined || await query.keep(hit))) { kept.push(hit); } }
        return kept;
      },
    }),
    sessions: () => ({
      load: async (id, loaded) => {
        loads.push({ session: id, ...loaded });
        return r.store.table('sessions').update(id, { ...(loaded.tools === undefined ? {} : { tools: [...loaded.tools] }), ...(loaded.context === undefined ? {} : { context: [...loaded.context] }) });
      },
    }),
    handlers: () => r.module.handlers,
    access: (actor) => Promise.resolve(access(actor)),
    sharing: () => ({ sharing: () => Promise.reject(new Error('no sharing here')), own: () => Promise.reject(new Error('no sharing here')) }),
    fns: () => ({ search: { search: () => Promise.reject(new Error('no fns search here')) }, examples: { sync: () => Promise.resolve(), page: () => Promise.reject(new Error('no examples here')), forPrompt: () => Promise.resolve([]) } }),
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

describe('keeping to what the person may see', () => {
  /** A member who sees nothing private: not `fs/secret` (fn or context), nor anything under file:///private. */
  const member = (actor: ActorId): AccessScope => ({
    ...openScope(actor), admin: false,
    seesFn: (record) => record.name !== 'fs/secret',
    mayUse: (record) => record.name !== 'fs/secret',
    seesContext: (record) => record.name !== 'fs/secret',
    seesUri: (uri) => !uri.startsWith('file:///private/'),
  });

  it('leaves hidden fns, context and sections out of searches, and refuses to load them', async () => {
    const { r, turn } = await started([
      { kind: 'fn', key: 'fs/read', score: 0.9, text: 'read' }, { kind: 'fn', key: 'fs/secret', score: 1, text: 'secret' },
      { kind: 'context', key: 'fs/guide', score: 0.9, text: 'guide' }, { kind: 'context', key: 'fs/secret', score: 1, text: 'secret' },
      { kind: 'section', key: 'file:///repo/README.md#Intro', score: 0.5, text: 'README.md\n\nOpen.' },
      { kind: 'section', key: 'file:///private/crawl.md#Top', score: 0.9, text: 'crawl.md\n\nPrivate.' },
    ], {}, member);
    r.catalog.add('fs', 'secret', fn({ description: 'Secret.', args: g.obj({}), returns: g.text() }));
    r.catalog.contexts.set(QualifiedName.parse('fs/guide'), 'How to work with files.');
    r.catalog.contexts.set(QualifiedName.parse('fs/secret'), 'Private notes.');
    expect(await call(r, turn, 'search_fns', { query: 'x' })).toEqual({ status: 'done', result: [{ fn: 'fs/read', description: 'Read a file.', available: true }] });
    expect(await call(r, turn, 'load_fns', { fns: ['fs/secret'] })).toEqual({ status: 'done', result: { loaded: [], refused: [{ fn: 'fs/secret', reason: 'no such fn' }] } });
    expect(await call(r, turn, 'search_context', { query: 'x' })).toEqual({ status: 'done', result: [{ context: 'fs/guide', description: 'guide' }] });
    expect(await call(r, turn, 'load_context', { context: ['fs/guide', 'fs/secret'] })).toEqual({ status: 'done', result: { loaded: ['fs/guide'] } });
    expect(await call(r, turn, 'search_resources', { query: 'x' })).toMatchObject({ status: 'done', result: [{ uri: 'file:///repo/README.md' }] });
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

describe('saved fns (build 5)', () => {
  it('lets a kind\'s system save fns of it, refuses a taken name, keeps the old version, and reads one back', async () => {
    const r = await executionRig();
    rig = r;
    addHubFn(r, hub.fns.save_fn);
    addHubFn(r, hub.fns.fn_get);
    const asker = r.catalog.add('input', 'ask', fn({ description: 'Ask.', args: g.obj({}), returns: g.bool(), tags: ['read'] }));
    r.catalog.set(asker.name, { decl: { ...asker.decl, deps: [hub.fns.save_fn.name, hub.fns.fn_get.name] } });
    const owned: Array<{ fn: string; owner: string; visibility: string }> = [];
    registerHubFns(r.module.hubFns, {
      store: () => r.store,
      catalog: () => ({
        fn: (name) => r.catalog.fn(name), fns: (filter) => r.catalog.fns(filter), availability: (name) => r.catalog.availability(name), context: (name) => r.catalog.context(name), type: () => r.catalog.type(),
        declare: (system, decl, by) => {
          const name = QualifiedName.parse(`${system}/${decl.name}`);
          const existing = r.catalog.records.get(name);
          if (existing === undefined) r.catalog.add(system, decl.name, fn({ description: decl.description, args: g.obj({}), returns: g.bool(), tags: ['read'] }));
          r.catalog.set(name, { decl, origin: 'runtime', addedBy: by, updatedAt: 3 });
          return Promise.resolve({ added: existing === undefined ? [name] : [], updated: existing === undefined ? [] : [name], removed: [], refused: [] });
        },
      }),
      search: () => ({ search: () => Promise.resolve([]) }),
      sessions: () => ({ load: () => Promise.reject(new Error('no loads here')) }),
      handlers: () => r.module.handlers,
      access: (actor) => Promise.resolve(openScope(actor)),
      sharing: () => ({
        sharing: () => Promise.resolve({ owner: ALICE, visibility: 'private', with: [] }),
        own: (target, owner, rule) => { if (target.kind === 'fn') owned.push({ fn: target.fn, owner, visibility: rule.visibility }); return Promise.resolve({ target, sharing: { owner, ...rule }, editable: true }); },
      }),
      fns: () => ({ search: { search: () => Promise.reject(new Error('no search')) }, examples: { sync: () => Promise.resolve(), page: () => Promise.reject(new Error('no examples')), forPrompt: () => Promise.resolve([]) } }),
    });
    await r.module.start();
    const input = r.connect('input');
    const results: unknown[] = [];
    const save = { kind: 'input/form', name: 'trip', description: 'Asks for a trip.', payload: { title: 'Trip' }, examples: [{ args: { to: 'Oslo' } }] };
    input.behaviour.run = async (request) => {
      const callHub = async (name: string, args: Json) => r.module.linkHandlers.call(linkPayload({ parent: request.run.id, fn: `hub/${name}`, args, key: `${name}-${results.length}`, handlers: [], background: false }, LinkSession.parse({ system: 'input', instance: 'main', boot: 'b' })));
      results.push(await callHub('save_fn', save));
      results.push(await callHub('save_fn', save));
      results.push(await callHub('save_fn', { ...save, description: 'Asks for a trip and who goes.', replace: true }));
      results.push(await callHub('fn_get', { fn: 'input/trip' }));
      results.push(await callHub('save_fn', { ...save, kind: 'database/query' }));
      return { status: 'done', result: true };
    };
    const turn = await r.turn();
    const { settled } = await r.module.runs.start({ fn: QualifiedName.parse('input/ask'), args: {}, turn: turn.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [] });
    await settled;
    expect(results[0]).toEqual({ status: 'done', result: { fn: 'input/trip', version: 1, created: true } });
    expect(results[1]).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'fn-taken' } });
    expect(results[2]).toEqual({ status: 'done', result: { fn: 'input/trip', version: 2, created: false } });
    expect(results[3]).toMatchObject({ status: 'done', result: { fn: 'input/trip', kind: 'input/form', description: 'Asks for a trip and who goes.', payload: { title: 'Trip' }, version: 2, owner: ALICE, available: true } });
    expect(results[4]).toMatchObject({ status: 'failed', error: { code: 'not-your-kind' } });
    expect(owned).toEqual([{ fn: 'input/trip', owner: ALICE, visibility: 'private' }]);
    // an example keeps only the parts it has, so the catalog can hash the decl as JSON
    expect(Object.keys(r.catalog.records.get(QualifiedName.parse('input/trip'))?.decl.examples?.[0] ?? {})).toEqual(['args']);
    expect((await r.store.table('fnVersions').find({ limit: 5 })).items).toMatchObject([{ fn: 'input/trip', number: 1, decl: { description: 'Asks for a trip.' } }]);
  });
});
