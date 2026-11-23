import { agent, fn, g, hub, manifestOf, type FnRef } from '@harness/sdk';
import { ActorId, ContextCrawlResult, LinkSession, ModelCallId, QualifiedName, SystemName, type FnSearchHit, type FnSearchQuery, type Json, type SearchFiltered, type RegistryEffect, type SearchHit, type Session, type SessionId, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_KIND, type RunInput } from '../execution/index.ts';
import { AGENT, ALICE, calls, executionRig, says, SESSION, until, type ExecutionRig } from '../execution/testing.ts';
import { openScope, type AccessScope } from '../access/index.ts';
import { CONTEXT_CRAWL_PURPOSE, NO_DECISION_MODEL, registerHubFns, SEARCH_LOADED_NOTE, UNDECLARED_CHANGE } from './hub-fns.ts';
import { writeItemVersions } from '../catalog/versions.ts';
import { Json as JsonValue } from '@harness/core';
import { linkPayload } from '../testing.ts';
import { CatalogFnViews } from '../contextor/views.ts';
import { replyText } from '../execution/wire.ts';
import { HubDecider } from '../models/decide.ts';
import type { Decider, ModelSite } from '../models/index.ts';

/** What the model reads of a settled run's result. */
const reads = (settled: { status: string; result?: Json }): string => (settled.status === 'done' && settled.result !== undefined ? replyText(settled.result, { rows: 5, watched: true }) : '');

let rig: ExecutionRig | undefined;
/** The decider `hub/ctx_crawl` asks (none set by default). */
const NO_DECIDER: Pick<Decider, 'model' | 'ask'> = { model: () => Promise.resolve({ problem: 'No decision model is set (an admin sets the Decide role).' }), ask: () => Promise.reject(new Error('no decision model')) };
let decider = NO_DECIDER;
/** What the admin's search decisions did to the fake search's page (none by default). */
let filtered: SearchFiltered[] | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; decider = NO_DECIDER; filtered = undefined; });

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
  const { fns_search, fns_load, fns_drop, ctx_search, ctx_load, ctx_drop, ctx_crawl, search_resources, ask_user } = hub.fns;
  addHubFn(r, fns_search); addHubFn(r, fns_load); addHubFn(r, fns_drop); addHubFn(r, ctx_search); addHubFn(r, ctx_load); addHubFn(r, ctx_drop); addHubFn(r, ctx_crawl);
  addHubFn(r, search_resources); addHubFn(r, ask_user);
  r.catalog.add('fs', 'read', fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] }));
  r.catalog.add('shop', 'buy', fn({ description: 'Buy.', args: g.obj({}), returns: g.text() }), { available: { unavailable: 'system-disconnected', detail: 'shop is offline' } });
  const searched: Array<{ text: string; kinds: readonly string[] }> = [];
  const loads: Array<{ session: SessionId; tools?: readonly string[]; context?: readonly string[] }> = [];
  const fnSearches: FnSearchQuery[] = [];
  // the hub's one search, over a fixed set: what the asker's rule keeps
  const known: FnSearchHit[] = [
    { item: 'fn', name: QualifiedName.parse('fs/read'), system: SystemName.parse('fs'), description: 'Read a file.', available: true },
    { item: 'fn', name: QualifiedName.parse('shop/buy'), system: SystemName.parse('shop'), description: 'Buy.', available: false },
    { item: 'context', name: QualifiedName.parse('fs/guide'), system: SystemName.parse('fs'), description: 'guide', available: true },
  ];
  registerHubFns(r.module.hubFns, {
    store: () => r.store,
    catalog: () => r.catalog,
    decider: () => decider,
    views: () => new CatalogFnViews(r.catalog),
    facts: () => ({ registry: (names) => Promise.resolve(new Map(names.map((name) => [name, []]))) }),
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
    fns: () => ({ search: { search: (query, asker) => {
      fnSearches.push(query);
      const items = known.filter((hit) => (query.items ?? ['fn', 'context']).includes(hit.item) && (asker.keep === undefined || asker.keep(hit.item, hit.name)));
      // as the real search: a decision judges only the item kinds the page holds
      const judged = filtered?.filter((f) => items.some((hit) => hit.item === f.item));
      return Promise.resolve(judged === undefined || judged.length === 0 ? { items } : { items, filtered: judged });
    } }, examples: { sync: () => Promise.resolve(), page: () => Promise.reject(new Error('no examples here')), patch: () => Promise.reject(new Error('no examples here')), forPrompt: () => Promise.resolve([]) } }),
  });
  await r.session({ systems: [SystemName.parse('fs'), SystemName.parse('shop')], ...session });
  await r.module.start();
  return { r, searched, loads, fnSearches, turn: await r.turn({ session: SESSION, text: 'hello' }) };
}

/** Run a hub fn in the session's turn and return how it settled. */
async function call(r: ExecutionRig, turn: Turn, name: string, args: Json) {
  const input: RunInput = { fn: QualifiedName.parse(`hub/${name}`), args, turn: turn.id, session: SESSION, key: name, actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [] };
  return (await r.module.runs.start(input)).settled;
}

describe('finding and loading fns', () => {
  it('searches with fns_search, keeping to the session\'s systems', async () => {
    const { r, turn, fnSearches } = await started([], { systems: [SystemName.parse('fs')] });
    const settled = await call(r, turn, 'fns_search', { text: 'open a file' });
    expect(settled).toEqual({ status: 'done', result: { items: [{ item: 'fn', name: 'fs/read', system: 'fs', description: 'Read a file.', available: true }] } });
    expect(fnSearches[0]).toMatchObject({ text: 'open a file' });
  });

  it('fns_search finds fns only and ctx_search context only, on the one search', async () => {
    const { r, turn, fnSearches } = await started();
    const fns = await call(r, turn, 'fns_search', { text: 'read' });
    expect(fns).toMatchObject({ status: 'done', result: { items: [{ name: 'fs/read' }, { name: 'shop/buy' }] } });
    expect(fns.status === 'done' && JSON.stringify(fns.result)).not.toContain('fs/guide');
    const context = await call(r, turn, 'ctx_search', { text: 'read', origins: ['system'], scopes: ['user'], tags: ['files'] });
    expect(context).toEqual({ status: 'done', result: { items: [{ item: 'context', name: 'fs/guide', system: 'fs', description: 'guide', available: true }] } });
    // one search, asked for one kind of item each: ctx_search's origins and tags are the context list's filters
    expect(fnSearches).toEqual([
      { text: 'read', items: ['fn'], available: false },
      { text: 'read', items: ['context'], scopes: ['user'], available: false, filters: [{ field: 'origin', op: 'in', values: ['system'] }, { field: 'tags', op: 'in', values: ['files'] }] },
    ]);
  });

  it('drops context items with ctx_drop, leaving the fns they brought', async () => {
    const { r, turn } = await started([], { context: [QualifiedName.parse('fs/guide'), QualifiedName.parse('fs/paths')], tools: [QualifiedName.parse('fs/read')] });
    expect(await call(r, turn, 'ctx_drop', { context: ['fs/guide: how to work with files', 'fs/other'] })).toEqual({ status: 'done', result: { dropped: ['fs/guide'] } });
    const session = await r.store.table('sessions').get(SESSION);
    expect(session?.context).toEqual(['fs/paths']);
    expect(session?.tools).toEqual(['fs/read']);
  });

  it('marks the context hits already in the prompt, injected or loaded, and never loads them again', async () => {
    const { r, turn } = await started();
    r.catalog.contexts.set(QualifiedName.parse('fs/guide'), 'How to work with files.');
    const guide = QualifiedName.parse('fs/guide');
    filtered = [{ item: 'context', by: 'decision', dropped: [], action: 'load' }];
    // in the agent's injected section (the fixed region's stamp): marked so, and the load decision leaves it
    await r.store.table('sessions').update(SESSION, { fixed: { hash: 'h', injected: [guide], at: turn.id } });
    const injected = await call(r, turn, 'ctx_search', { text: 'files' });
    expect(injected).toEqual({ status: 'done', result: { items: [{ item: 'context', name: 'fs/guide', system: 'fs', description: 'guide', available: true, inPrompt: 'injected' }], filtered } });
    expect((await r.store.table('sessions').get(SESSION))?.context).toEqual([]);
    // in neither: loaded by the decision, and the hit says it is loaded now
    await r.store.table('sessions').update(SESSION, { fixed: { hash: 'h', injected: [], at: turn.id } });
    const loadedNow = await call(r, turn, 'ctx_search', { text: 'files' });
    expect(loadedNow).toMatchObject({ status: 'done', result: { items: [{ name: 'fs/guide', inPrompt: 'loaded' }], loaded: { context: ['fs/guide'] } } });
    // loaded in the chat before: marked loaded, nothing loaded again
    const again = await call(r, turn, 'ctx_search', { text: 'files' });
    expect(again).toEqual({ status: 'done', result: { items: [{ item: 'context', name: 'fs/guide', system: 'fs', description: 'guide', available: true, inPrompt: 'loaded' }], filtered } });
    // fns are never marked
    const fns = await call(r, turn, 'fns_search', { text: 'read' });
    expect(fns.status === 'done' && JSON.stringify(fns.result)).not.toContain('inPrompt');
  });

  it('applies each search decision to its own search: the fn one to fns_search, the context one to ctx_search', async () => {
    const { r, turn } = await started();
    r.catalog.contexts.set(QualifiedName.parse('fs/guide'), 'How to work with files.');
    // both decisions load: fns_search loads the usable fn (not the offline one) and never context
    filtered = [{ item: 'fn', by: 'decision', dropped: [], action: 'load' }, { item: 'context', by: 'decision', dropped: [], action: 'load' }];
    const fnsOnly = await call(r, turn, 'fns_search', { text: 'read' });
    expect(fnsOnly).toMatchObject({ status: 'done', result: { filtered: [{ item: 'fn' }], loaded: { fns: ['fs/read'], context: [], note: SEARCH_LOADED_NOTE } } });
    expect((await r.store.table('sessions').get(SESSION))?.context).toEqual([]);
    // ctx_search loads the context, with what it brings, and never fns; what is loaded already is left as it is
    const ctxOnly = await call(r, turn, 'ctx_search', { text: 'read' });
    expect(ctxOnly).toMatchObject({ status: 'done', result: { filtered: [{ item: 'context' }], loaded: { fns: [], context: ['fs/guide'] } } });
    const session = await r.store.table('sessions').get(SESSION);
    expect(session?.tools).toEqual(['fs/read']);
    expect(session?.context).toEqual(['fs/guide']);
    // the context decision alone loading leaves fns_search to only return its hits
    await r.store.table('sessions').update(SESSION, { tools: [], context: [] });
    filtered = [{ item: 'fn', by: 'decision', dropped: [] }, { item: 'context', by: 'decision', dropped: [], action: 'load' }];
    const fnsFiltered = await call(r, turn, 'fns_search', { text: 'read' });
    expect(fnsFiltered.status === 'done' && typeof fnsFiltered.result === 'object' && fnsFiltered.result !== null && 'loaded' in fnsFiltered.result).toBe(false);
    expect((await r.store.table('sessions').get(SESSION))?.tools).toEqual([]);
    // a filter that failed loads nothing, and neither does a decision that only filters
    filtered = [{ item: 'fn', by: 'decision', dropped: [], action: 'load', failed: 'The decision model failed (down), so every hit was kept.' }, { item: 'context', by: 'llm', dropped: [] }];
    const failed = await call(r, turn, 'fns_search', { text: 'read' });
    expect(failed.status === 'done' && typeof failed.result === 'object' && failed.result !== null && 'loaded' in failed.result).toBe(false);
    expect((await r.store.table('sessions').get(SESSION))?.tools).toEqual([]);
  });

  it('loads usable fns into the session and says why the rest were refused', async () => {
    const { r, turn } = await started([], { systems: [SystemName.parse('fs')] });
    const settled = await call(r, turn, 'fns_load', { fns: ['fs/read', 'shop/buy', 'fs/nothing', 'nothing'] });
    // the model reads the XML cards, not the name lists: the loaded fn's card, then each refused name with why
    expect(reads(settled)).toBe([
      '<loaded_fns>', 'In your tools from your next step:', '<fn name="fs/read" label="Read" mode="read" available="yes">Read a file.</fn>', '</loaded_fns>',
      '<refused_fns>', 'Not loaded. Don\'t load these again; if you need one, tell the person what blocks it:',
      '<refused name="nothing" code="not-a-name" available="no">not the name of a fn</refused>',
      '<refused name="shop/buy" code="other-system" available="no">this session does not use shop</refused>',
      '<refused name="fs/nothing" code="no-such-fn" available="no">no such fn</refused>', '</refused_fns>',
    ].join('\n'));
    expect(settled).toMatchObject({ status: 'done', result: {
      loaded: ['fs/read'],
      refused: [
        { fn: 'nothing', code: 'not-a-name', reason: 'not the name of a fn' },
        { fn: 'shop/buy', code: 'other-system', reason: 'this session does not use shop', system: 'shop' },
        { fn: 'fs/nothing', code: 'no-such-fn', reason: 'no such fn' },
      ],
    } });
    expect((await r.store.table('sessions').get(SESSION))?.tools).toEqual(['fs/read']);
    expect(await call(r, turn, 'fns_drop', { fns: ['fs/read', 'fs/other'] })).toEqual({ status: 'done', result: { dropped: ['fs/read'] } });
    expect((await r.store.table('sessions').get(SESSION))?.tools).toEqual([]);
  });

  it('refuses a fn not meant for the model, as hub/load does', async () => {
    const { r, turn } = await started();
    r.catalog.add('fs', 'raw', fn({ description: 'Raw.', args: g.obj({}), returns: g.text(), visibility: 'user' }));
    expect(await call(r, turn, 'fns_load', { fns: ['fs/raw'] })).toMatchObject({ status: 'done', result: { loaded: [], refused: [{ fn: 'fs/raw', code: 'not-for-model', reason: 'not for the model', system: 'fs' }] } });
  });

  it('refuses a held fn with the hub\'s reason, not a bare "unavailable" (regression: "You there?")', async () => {
    const { r, turn } = await started();
    const held = { unavailable: 'held' as const, detail: 'database/create_table changed and waits for an admin to approve it' };
    r.catalog.add('database', 'create_table', fn({ description: 'Create a table.', args: g.obj({}), returns: g.text() }), { available: held });
    await r.store.table('sessions').update(SESSION, { systems: 'all' });
    const settled = await call(r, turn, 'fns_load', { fns: ['database/create_table'] });
    expect(settled).toMatchObject({ status: 'done', result: {
      loaded: [], refused: [{ fn: 'database/create_table', code: 'held', reason: held.detail, system: 'database' }],
    } });
    expect(reads(settled)).toContain(`<refused name="database/create_table" code="held" available="no">${held.detail}</refused>`);
    expect(reads(settled)).not.toContain('<loaded_fns');
  });

  it('gives a held fn from hub/fns_get with what blocks it, as fns_search hits say it, not a bare available: false', async () => {
    const { r, turn } = await started();
    addHubFn(r, hub.fns.fns_get);
    const held = { unavailable: 'held' as const, detail: 'database/create_table changed and waits for an admin to approve it' };
    r.catalog.add('database', 'create_table', fn({ description: 'Create a table.', args: g.obj({}), returns: g.text() }), { available: held });
    expect(await call(r, turn, 'fns_get', { fn: 'database/create_table' })).toMatchObject({ status: 'done', result: {
      fn: 'database/create_table', available: false, blocked: { code: 'held', reason: held.detail, system: 'database' },
    } });
    const usable = await call(r, turn, 'fns_get', { fn: 'fs/read' });
    expect(usable).toMatchObject({ status: 'done', result: { fn: 'fs/read', available: true } });
    expect(usable.status === 'done' ? usable.result : undefined).not.toHaveProperty('blocked');
  });

  it('keeps the context page\'s own filters out of the model\'s search, so its tool spec stays small', async () => {
    // regression: `filters` and `off` (the context page's) made static mode's `find` spec too big for a small window
    const spec = JSON.stringify(hub.fns.fns_search.args);
    expect(spec).toContain('"names"');
    expect(spec).not.toContain('"filters"');
    expect(spec).not.toContain('"off"');
    const { r, turn, fnSearches } = await started();
    await call(r, turn, 'fns_search', { text: 'buy', filters: [{ field: 'origin', op: 'eq', value: 'memory' }], off: true });
    expect(fnSearches).toHaveLength(1);
    expect(fnSearches[0]).toMatchObject({ text: 'buy' });
    expect(fnSearches[0]).not.toHaveProperty('filters');
    expect(fnSearches[0]).not.toHaveProperty('off');
  });

  it('searches unavailable fns too for the model, unless it asks for usable ones only', async () => {
    const { r, turn, fnSearches } = await started();
    await call(r, turn, 'fns_search', { text: 'buy' });
    await call(r, turn, 'fns_search', { text: 'buy', available: true });
    expect(fnSearches.map((q) => q.available)).toEqual([false, true]);
  });

  it('refuses outside a chat session', async () => {
    const { r } = await started();
    const loose = await r.turn();
    const input: RunInput = { fn: QualifiedName.parse('hub/fns_load'), args: { fns: ['fs/read'] }, turn: loose.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [] };
    expect(await (await r.module.runs.start(input)).settled).toMatchObject({ status: 'failed', error: { message: 'this fn only works inside a chat session' } });
  });
});

describe('context and resources', () => {
  it('loads context with what it imports and the fns it brings, and refuses a wrong name with the closest', async () => {
    const { r, turn } = await started();
    r.catalog.contexts.set(QualifiedName.parse('fs/guide'), 'How to work with files.');
    r.catalog.contexts.set(QualifiedName.parse('fs/guide.paths'), 'Paths are relative to the root.');
    r.catalog.contextDecls.set(QualifiedName.parse('fs/guide'), { imports: [QualifiedName.parse('fs/guide.paths')], fns: [QualifiedName.parse('fs/read')] });
    const settled = await call(r, turn, 'ctx_load', { context: ['fs/guide: how to work with files', 'fs/missing'] });
    expect(reads(settled)).toBe([
      '<loaded_ctx>', 'Their text is in front of you from your next step:',
      '<ctx key="fs/guide">guide</ctx>', '<ctx key="fs/guide.paths">guide.paths</ctx>', '</loaded_ctx>',
      '<brought_fns in_tools="yes">In your tools from your next step: fs/read</brought_fns>',
      '<refused_ctx>', 'Not loaded:', '<refused name="fs/missing" available="no">no context you can load has that name. The closest: fs/guide.</refused>', '</refused_ctx>',
    ].join('\n'));
    expect(settled).toMatchObject({ status: 'done', result: {
      loaded: ['fs/guide', 'fs/guide.paths'], fns: ['fs/read'], fnsRefused: [],
      refused: [{ context: 'fs/missing', reason: 'no context you can load has that name', closest: ['fs/guide'] }],
    } });
    expect(await r.store.table('sessions').get(SESSION)).toMatchObject({ context: ['fs/guide', 'fs/guide.paths'], tools: ['fs/read'] });
  });

  it('reports the brought fns it could not add, with the hub\'s reason, instead of fns: [] (regression: "You there?")', async () => {
    const { r, turn } = await started();
    await r.store.table('sessions').update(SESSION, { systems: 'all' });
    const held = { unavailable: 'held' as const, detail: 'database/create_table changed and waits for an admin to approve it' };
    r.catalog.add('database', 'create_table', fn({ description: 'Create a table.', args: g.obj({}), returns: g.text() }), { available: held });
    r.catalog.add('database', 'raw', fn({ description: 'Raw.', args: g.obj({}), returns: g.text(), visibility: 'user' }));
    r.catalog.contexts.set(QualifiedName.parse('database/guide'), 'How to make tables.');
    r.catalog.contextDecls.set(QualifiedName.parse('database/guide'), { fns: [QualifiedName.parse('database/create_table'), QualifiedName.parse('fs/read'), QualifiedName.parse('database/raw'), QualifiedName.parse('database/gone')] });
    const settled = await call(r, turn, 'ctx_load', { context: ['database/guide'] });
    expect(reads(settled)).toContain('<brought_fns in_tools="no" available="no">You can\'t use these now: database/create_table (changed and waits for an admin to approve it).');
    expect(reads(settled)).not.toContain('database/gone');
    expect(settled).toMatchObject({ status: 'done', result: {
      // a fn never meant for the model, or one that doesn't exist, reads as missing and is not named
      loaded: ['database/guide'], fns: ['fs/read'], refused: [],
      fnsRefused: [{ fn: 'database/create_table', code: 'held', reason: held.detail, system: 'database' }],
    } });
    expect(await r.store.table('sessions').get(SESSION)).toMatchObject({ tools: ['fs/read'] });
  });

  it('never loads a switched-off item, by name or as an import, nor the fns only it brings (build 6)', async () => {
    const { r, turn } = await started();
    r.catalog.contexts.set(QualifiedName.parse('fs/guide'), 'How to work with files.');
    r.catalog.contexts.set(QualifiedName.parse('fs/old'), 'Forgotten.');
    r.catalog.contexts.set(QualifiedName.parse('fs/old.more'), 'Only the forgotten item imports this.');
    r.catalog.contextDecls.set(QualifiedName.parse('fs/guide'), { imports: [QualifiedName.parse('fs/old')] });
    r.catalog.contextDecls.set(QualifiedName.parse('fs/old'), { imports: [QualifiedName.parse('fs/old.more')], fns: [QualifiedName.parse('fs/read')] });
    r.catalog.contextsOff.add(QualifiedName.parse('fs/old'));
    expect(await call(r, turn, 'ctx_load', { context: ['fs/guide', 'fs/old'] })).toMatchObject({ status: 'done', result: {
      loaded: ['fs/guide'], fns: [], refused: [{ context: 'fs/old', reason: 'no context you can load has that name' }],
    } });
    expect(await r.store.table('sessions').get(SESSION)).toMatchObject({ context: ['fs/guide'], tools: [] });
  });

  /**
   * Plan item 7: a guide (importing its paths, bringing fs/read) that offers two choices, and the hub decider over a
   * gateway that says yes to fs/kinds (0.9) and no to fs/tables (0.1); every item is 40 characters (10 tokens).
   */
  function crawlable(r: ExecutionRig): { sites: ModelSite[] } {
    const text = 'x'.repeat(40);
    for (const name of ['fs/guide', 'fs/guide.paths', 'fs/kinds', 'fs/tables']) r.catalog.contexts.set(QualifiedName.parse(name), text);
    r.catalog.contextDecls.set(QualifiedName.parse('fs/guide'), {
      imports: [QualifiedName.parse('fs/guide.paths')], fns: [QualifiedName.parse('fs/read')],
      choices: [{ to: QualifiedName.parse('fs/kinds'), when: 'the task declares a kind' }, { to: QualifiedName.parse('fs/tables'), when: 'the task makes tables' }],
    });
    const yes: Record<string, number> = { 'fs/kinds': 0.9, 'fs/tables': 0.1 };
    const sites: ModelSite[] = [];
    decider = new HubDecider({
      roles: {
        get: () => Promise.resolve({ role: 'decide', from: 'setting', choice: { role: 'decide', model: { model: 'judge' }, threshold: 0.5 }, resolved: { model: 'judge', provider: 'ollama' } }),
        resolveModel: () => Promise.resolve({ problem: 'not here' }),
      },
      llm: {
        models: () => Promise.resolve([]),
        decide: (input, site) => {
          sites.push(site);
          const answers = Object.fromEntries(Object.entries(input.questions).map(([key, question]) => [key, { type: 'predicate' as const, probability: yes[/^Load (\S+)/.exec(question.instructions)?.[1] ?? ''] ?? 0 }]));
          return Promise.resolve({ value: { answers, model: 'judge' }, call: ModelCallId.parse(`mdl_${sites.length}`), cost: 0.01, model: 'judge' });
        },
      },
    });
    return { sites };
  }

  it('crawls from a guide by the decision model, loads what it took like ctx_load, and says what it skipped and why it stopped (plan item 7)', async () => {
    const { r, turn } = await started();
    const { sites } = crawlable(r);
    const settled = await call(r, turn, 'ctx_crawl', { context: ['fs/guide: how to work with files', 'fs/missing'], guidance: 'Declare a new kind.' });
    expect(reads(settled)).toBe([
      '<crawled_ctx decisions="2" tokens="30">', 'Their text is in front of you from your next step:',
      '<ctx key="fs/guide" depth="0" via="start" tokens="10">guide</ctx>',
      '<ctx key="fs/guide.paths" depth="0" via="import" from="fs/guide" tokens="10">guide.paths</ctx>',
      '<ctx key="fs/kinds" depth="1" via="choice" from="fs/guide" yes="0.90" tokens="10">kinds</ctx>', '</crawled_ctx>',
      '<brought_fns in_tools="yes">In your tools from your next step: fs/read</brought_fns>',
      '<skipped_ctx>', 'Not taken:', '<skipped key="fs/tables" from="fs/guide" depth="1" reason="declined" yes="0.10" />', '</skipped_ctx>',
      '<refused_ctx>', 'Not loaded:', '<refused name="fs/missing" available="no">no context you can load has that name. The closest: fs/guide.</refused>', '</refused_ctx>',
      '<crawl_stop reason="complete">It followed every choice there was.</crawl_stop>',
    ].join('\n'));
    expect(settled).toMatchObject({ status: 'done', result: {
      loaded: ['fs/guide', 'fs/guide.paths', 'fs/kinds'], fns: ['fs/read'], fnsRefused: [],
      refused: [{ context: 'fs/missing', reason: 'no context you can load has that name', closest: ['fs/guide'] }],
      crawled: [
        { name: 'fs/guide', depth: 0, via: 'start', tokens: 10, content: 'x'.repeat(40) },
        { name: 'fs/guide.paths', depth: 0, via: 'import', from: 'fs/guide', tokens: 10 },
        { name: 'fs/kinds', depth: 1, via: 'choice', from: 'fs/guide', probability: 0.9, tokens: 10 },
      ],
      skipped: [{ context: 'fs/tables', from: 'fs/guide', depth: 1, reason: 'declined', probability: 0.1 }],
      stop: { reason: 'complete' }, depth: 1, decisions: 2, tokens: 30, calls: ['mdl_1'], metadataOnly: false,
    } });
    expect(await r.store.table('sessions').get(SESSION)).toMatchObject({ context: ['fs/guide', 'fs/guide.paths', 'fs/kinds'], tools: ['fs/read'] });
    // the decide call is the crawl's: charged to its run, for its purpose
    const run = (await r.store.table('runs').find({ where: { fn: hub.fns.ctx_crawl.name }, limit: 1 })).items[0];
    expect(sites).toEqual([{ purpose: CONTEXT_CRAWL_PURPOSE, run: run?.id }]);
  });

  it('with metadataOnly, says what a crawl would take without loading it or giving its content (plan item 7)', async () => {
    const { r, turn } = await started();
    crawlable(r);
    const settled = await call(r, turn, 'ctx_crawl', { context: ['fs/guide'], guidance: 'Declare a new kind.', metadataOnly: true });
    expect(reads(settled)).toContain('<crawled_ctx decisions="2" tokens="30">\nNot loaded (metadata only): load what fits with hub/ctx_load.\n<ctx key="fs/guide"');
    expect(reads(settled)).not.toContain('<brought_fns');
    expect(settled).toMatchObject({ status: 'done', result: { loaded: [], fns: [], metadataOnly: true } });
    const crawled = settled.status === 'done' ? ContextCrawlResult.parse(settled.result).crawled : [];
    expect(crawled.map((item) => [item.name, item.content])).toEqual([['fs/guide', undefined], ['fs/guide.paths', undefined], ['fs/kinds', undefined]]);
    expect(await r.store.table('sessions').get(SESSION)).toMatchObject({ context: [], tools: [] });
  });

  it('refuses a crawl while no decision model can be used, with the hub\'s reason (plan item 7)', async () => {
    const { r, turn } = await started();
    expect(await call(r, turn, 'ctx_crawl', { context: ['fs/guide'], guidance: 'Anything.' })).toMatchObject({
      status: 'failed', error: { class: 'caller', code: NO_DECISION_MODEL, message: 'No decision model is set (an admin sets the Decide role).' },
    });
  });

  it('declares that hub/ctx_crawl needs the decide role, so the catalog keeps it off until one is set (plan item 7)', async () => {
    const decl = (await manifestOf(hub, { version: '0.0.0' })).fns.find((fn) => fn.name === 'ctx_crawl');
    expect(decl?.roles).toEqual(['decide']);
    expect(decl?.examples?.length).toBeGreaterThan(0);
    expect(decl?.instructions).toContain('levels');
  });

  it('searches sections and gives each hit its resource, section, title and preview, narrowed to roots', async () => {
    const { r, turn } = await started([
      { kind: 'section', key: 'file:///repo/README.md#Intro', rank: 0.8, similarity: 0.8, text: 'README.md > Intro\n\nA harness.' },
      { kind: 'section', key: 'file:///other/notes.md#Top', rank: 0.4, similarity: 0.4, text: 'notes.md\n\nElsewhere.' },
    ]);
    expect(await call(r, turn, 'search_resources', { query: 'harness', roots: ['file:///repo'] })).toEqual({ status: 'done', result: [
      { uri: 'file:///repo/README.md', section: 'Intro', title: 'README.md > Intro', preview: 'README.md > Intro\n\nA harness.', rank: 0.8 },
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
      { kind: 'section', key: 'file:///repo/README.md#Intro', rank: 0.5, similarity: 0.5, text: 'README.md\n\nOpen.' },
      { kind: 'section', key: 'file:///private/crawl.md#Top', rank: 0.9, similarity: 0.9, text: 'crawl.md\n\nPrivate.' },
    ], {}, member);
    r.catalog.add('fs', 'secret', fn({ description: 'Secret.', args: g.obj({}), returns: g.text() }));
    r.catalog.contexts.set(QualifiedName.parse('fs/guide'), 'How to work with files.');
    r.catalog.contexts.set(QualifiedName.parse('fs/secret'), 'Private notes.');
    r.catalog.contextDecls.set(QualifiedName.parse('fs/guide'), { imports: [QualifiedName.parse('fs/secret')], fns: [QualifiedName.parse('fs/secret')] });
    expect(await call(r, turn, 'fns_load', { fns: ['fs/secret'] })).toMatchObject({ status: 'done', result: { loaded: [], refused: [{ fn: 'fs/secret', code: 'no-such-fn', reason: 'no such fn' }] } });
    // what it imports and brings is still kept to what the person may see
    expect(await call(r, turn, 'ctx_load', { context: ['fs/guide', 'fs/secret'] })).toMatchObject({ status: 'done', result: { loaded: ['fs/guide'], fns: [], fnsRefused: [] } });
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
    tools: [hub.fns.fns_search, hub.fns.fns_load, hub.fns.ctx_load],
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
    const { r, turn } = await started([{ kind: 'fn', key: 'fs/read', rank: 0.9, similarity: 0.9, text: 'read' }], { systems: [SystemName.parse('fs')] });
    r.catalog.add('tools', 'chat', chatAgent());
    r.catalog.contexts.set(QualifiedName.parse('fs/guide'), 'How to work with files.');
    const files = r.connect('fs');
    files.behaviour.run = () => Promise.resolve({ status: 'done', result: 'hello from a.txt' });
    // the scripted model reuses its tool call ids each iteration (call_1, call_2), as some real models do
    r.provider.script(
      calls([['hub__fns_search', { text: 'read a file' }]]),
      calls([['hub__fns_load', { fns: ['fs/read'] }], ['hub__ctx_load', { context: ['fs/guide'] }]]),
      calls([['fs__read', { path: 'a.txt' }]]),
      says('It says hello.'),
    );
    expect(await answer(r, turn)).toEqual({ status: 'done', result: 'It says hello.' });

    expect(sent(r, 0).tools).toEqual(['hub__ctx_load', 'hub__fns_load', 'hub__fns_search']);
    expect(sent(r, 0).system).not.toContain('<ctx');
    expect(sent(r, 2).tools).toEqual(['fs__read', 'hub__ctx_load', 'hub__fns_load', 'hub__fns_search']);
    expect(sent(r, 2).system).toContain('<ctx key="fs/guide">How to work with files.</ctx>');
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
    expect(sent(r, 0).tools).toEqual(['fs__write', 'hub__ctx_load', 'hub__fns_load', 'hub__fns_search']);
  });
});

describe('saved fns (build 5)', () => {
  it('lets a kind\'s system save fns of it, refuses a taken name, keeps the old version, and reads one back', async () => {
    const r = await executionRig();
    rig = r;
    addHubFn(r, hub.fns.fns_save);
    addHubFn(r, hub.fns.fns_get);
    const asker = r.catalog.add('input', 'ask', fn({ description: 'Ask.', args: g.obj({}), returns: g.bool(), tags: ['read'] }));
    // it declares that it creates and updates input/form fns (build 6): the hub refuses what it did not declare
    const declares = (registry: RegistryEffect[]): void => {
      r.catalog.set(asker.name, { decl: { ...asker.decl, deps: [hub.fns.fns_save.name, hub.fns.fns_get.name], effects: { registry } } });
    };
    declares([{ thing: 'fns', action: 'create', kind: 'input/form' }, { thing: 'fns', action: 'update', kind: 'input/form' }]);
    const owned: Array<{ fn: string; owner: string; visibility: string }> = [];
    registerHubFns(r.module.hubFns, {
      store: () => r.store,
      catalog: () => ({
        fn: (name) => r.catalog.fn(name), fns: (filter) => r.catalog.fns(filter), availability: (name) => r.catalog.availability(name), context: (name) => r.catalog.context(name), type: () => r.catalog.type(), kind: () => r.catalog.kind(),
        declare: async (system, decl, by) => {
          const name = QualifiedName.parse(`${system}/${decl.name}`);
          const existing = r.catalog.records.get(name);
          if (existing === undefined) r.catalog.add(system, decl.name, fn({ description: decl.description, args: g.obj({}), returns: g.bool(), tags: ['read'] }));
          r.catalog.set(name, { decl, origin: 'runtime', addedBy: by, updatedAt: 3 });
          // as the store catalog does: every save is a version
          await writeItemVersions(r.store, system, [{ section: 'fns', name, change: existing === undefined ? 'added' : 'changed', decl: JsonValue.parse(decl) }], 3, by);
          return { added: existing === undefined ? [name] : [], updated: existing === undefined ? [] : [name], removed: [], refused: [] };
        },
      }),
      views: () => new CatalogFnViews(r.catalog),
      decider: () => decider,
      facts: () => ({ registry: (names) => Promise.resolve(new Map(names.map((name) => [name, r.catalog.records.get(name)?.decl.effects?.registry ?? []]))) }),
      search: () => ({ search: () => Promise.resolve([]) }),
      sessions: () => ({ load: () => Promise.reject(new Error('no loads here')) }),
      handlers: () => r.module.handlers,
      access: (actor) => Promise.resolve(openScope(actor)),
      sharing: () => ({
        sharing: () => Promise.resolve({ owner: ALICE, visibility: 'private', with: [] }),
        own: (target, owner, rule) => { if (target.kind === 'fn') owned.push({ fn: target.fn, owner, visibility: rule.visibility }); return Promise.resolve({ target, sharing: { owner, ...rule }, editable: true }); },
      }),
      fns: () => ({ search: { search: () => Promise.reject(new Error('no search')) }, examples: { sync: () => Promise.resolve(), page: () => Promise.reject(new Error('no examples')), patch: () => Promise.reject(new Error('no examples')), forPrompt: () => Promise.resolve([]) } }),
    });
    await r.module.start();
    const input = r.connect('input');
    const results: unknown[] = [];
    const save = { kind: 'input/form', name: 'project', description: 'Asks for a project.', payload: { title: 'Project' }, examples: [{ args: { owner: 'Ann' } }] };
    input.behaviour.run = async (request) => {
      const callHub = async (name: string, args: Json) => r.module.linkHandlers.call(linkPayload({ parent: request.run.id, fn: `hub/${name}`, args, key: `${name}-${results.length}`, handlers: [], background: false }, LinkSession.parse({ system: 'input', instance: 'main', boot: 'b' })));
      results.push(await callHub('fns_save', save));
      results.push(await callHub('fns_save', save));
      results.push(await callHub('fns_save', { ...save, description: 'Asks for a project and who owns it.', replace: true }));
      results.push(await callHub('fns_get', { fn: 'input/project' }));
      results.push(await callHub('fns_save', { ...save, kind: 'database/query' }));
      // now it only declares creating: saving over its fn is an update it did not declare
      declares([{ thing: 'fns', action: 'create', kind: 'input/form' }]);
      results.push(await callHub('fns_save', { ...save, replace: true }));
      return { status: 'done', result: true };
    };
    const turn = await r.turn();
    const { settled } = await r.module.runs.start({ fn: QualifiedName.parse('input/ask'), args: {}, turn: turn.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [] });
    await settled;
    expect(results[0]).toEqual({ status: 'done', result: { fn: 'input/project', version: 1, created: true } });
    expect(results[1]).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'fn-taken' } });
    expect(results[2]).toEqual({ status: 'done', result: { fn: 'input/project', version: 2, created: false } });
    expect(results[3]).toMatchObject({ status: 'done', result: { fn: 'input/project', kind: 'input/form', description: 'Asks for a project and who owns it.', payload: { title: 'Project' }, version: 2, owner: ALICE, available: true } });
    expect(results[4]).toMatchObject({ status: 'failed', error: { code: 'not-your-kind' } });
    expect(results[5]).toMatchObject({ status: 'failed', error: { class: 'caller', code: UNDECLARED_CHANGE } });
    expect(owned).toEqual([{ fn: 'input/project', owner: ALICE, visibility: 'private' }]);
    // an example keeps only the parts it has, so the catalog can hash the decl as JSON
    expect(Object.keys(r.catalog.records.get(QualifiedName.parse('input/project'))?.decl.examples?.[0] ?? {})).toEqual(['args']);
    expect((await r.store.table('itemVersions').find({ order: [['number', 'asc']], limit: 5 })).items).toMatchObject([
      { name: 'input/project', section: 'fns', number: 1, change: 'added', decl: { description: 'Asks for a project.' }, savedBy: ALICE },
      { name: 'input/project', number: 2, change: 'changed', decl: { description: 'Asks for a project and who owns it.' } },
    ]);
  });
});
