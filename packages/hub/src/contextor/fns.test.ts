import { openScope } from '../access/index.ts';
import { fn, g, hub } from '@harness/sdk';
import { ActorId, INVALID_INPUT_CODE, QualifiedName, SessionId, TypeRecord, type ContextRecord, type Json, type RunSettled } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT, ALICE, executionRig, SESSION, type ExecutionRig } from '../execution/testing.ts';
import { createContextor } from './create.ts';
import { contextorEnv } from './env.ts';
import { registerContextorFns, type FnScope } from './fns.ts';
import { contextRecord, FixedSearch, sessionLoader } from './testing.ts';
import { CatalogFnViews } from './views.ts';

let rig: ExecutionRig | undefined;
/** The actor of a hub MCP, whose runs keep to its scope. */
const MCP_CALLER = ActorId.parse('act_mcp_small');
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

async function started(options: { scope?: FnScope } = {}) {
  const r = await executionRig();
  rig = r;
  r.catalog.add('fs', 'read', fn({ description: 'Read a text file.', args: g.obj({ path: g.text() }), returns: g.text() }));
  r.catalog.add('fs', 'off', fn({ description: 'Switched off.', args: g.obj({}), returns: g.text() }), { disabled: true });
  r.catalog.contexts.set('fs/guide', 'Use fs/read for files.');
  for (const name of ['find', 'inspect', 'load', 'unload', 'model_limits'] as const) r.catalog.add('hub', name, hub.defs.fns[name]);
  const search = new FixedSearch();
  // memory of three scopes, and a named type, over the rig's catalog
  const BOB = ActorId.parse('act_bob');
  const memories = new Map<QualifiedName, ContextRecord>([
    ['memory/mine', contextRecord('memory/mine', { content: 'Alice likes tea.', origin: { type: 'memory', scope: { to: 'user', user: ALICE }, author: ALICE } })],
    ['memory/bobs', contextRecord('memory/bobs', { content: 'Bob likes coffee.', origin: { type: 'memory', scope: { to: 'user', user: BOB }, author: BOB } })],
    ['fs/tree', contextRecord('fs/tree', { description: 'The folder tree.' })],
    ['memory/elsewhere', contextRecord('memory/elsewhere', { content: 'Another chat.', origin: { type: 'memory', scope: { to: 'session', session: SessionId.parse('ses_other') }, author: BOB } })],
  ]);
  const entry = TypeRecord.parse({ name: 'fs/Entry', system: 'fs', description: 'One file.', display: { label: 'Entry' }, def: { name: 'obj', props: { path: { type: { name: 'text' } } } }, references: [], updatedAt: 0 });
  const catalog = {
    fn: (name: QualifiedName) => r.catalog.fn(name), availability: (name: QualifiedName) => r.catalog.availability(name), signature: (name: QualifiedName) => r.catalog.signature(name),
    context: async (name: QualifiedName) => memories.get(name) ?? r.catalog.context(name),
    type: (name: QualifiedName) => Promise.resolve(name === entry.name ? entry : undefined),
    typeClosure: (names: readonly QualifiedName[]) => Promise.resolve({ order: names.filter((n) => n === entry.name), missing: names.filter((n) => n !== entry.name) }),
  };
  const contextor = createContextor({
    store: r.store, catalog: r.catalog, search, settings: contextorEnv.parse(), modelSettings: { HARNESS_DEFAULT_MODEL: 'test-model' }, models: () => r.module.llm.models(),
    log: r.log, clock: () => r.time.now, probes: () => undefined,
    // dynamic context, written by its system for the person
    dynamic: { resolve: (record, ask) => Promise.resolve(record.decl.content !== undefined ? record : { ...record, decl: { ...record.decl, content: `tree for ${ask.user?.name ?? '?'}` } }) },
  });
  registerContextorFns(r.module.hubFns, {
    store: () => r.store, catalog: () => catalog, search: () => search, sessions: () => sessionLoader(r.store),
    contextor: () => contextor, views: () => new CatalogFnViews(catalog), mcpScope: (caller) => Promise.resolve(caller === MCP_CALLER ? options.scope : undefined), access: (actor) => Promise.resolve(openScope(actor)),
  });
  await r.module.start();
  await r.session({ tools: ['fs/read'] });
  const turn = await r.turn({ session: SESSION });
  let n = 0;
  const call = async (name: QualifiedName, args: Json, caller: ActorId = AGENT): Promise<RunSettled> => {
    const { settled } = await r.module.runs.start({
      fn: name, args, turn: turn.id, session: SESSION, key: `k${++n}`, actor: ALICE, caller, priority: 'interactive', background: false, handlers: [],
    });
    return settled;
  };
  return { r, search, call };
}

describe('the contextor\'s hub fns', () => {
  it('find marks what the session has loaded, across kinds', async () => {
    const { search, call } = await started();
    search.hits = [
      { kind: 'fn', key: 'fs/read', score: 1, text: '' },
      { kind: 'context', key: 'fs/guide', score: 0.5, text: '' },
      { kind: 'section', key: 'file:///a.md#Usage', score: 0.4, text: 'Usage\nHow to use it.' },
      { kind: 'fn', key: 'fs/gone', score: 0.1, text: '' },
    ];
    expect(await call('hub/find', { query: 'read files' })).toEqual({
      status: 'done', result: [
        { name: 'fs/read', kind: 'fn', description: 'Read a text file.', loaded: true },
        { name: 'fs/guide', kind: 'context', description: 'guide', loaded: false },
        { name: 'file:///a.md#Usage', kind: 'resource', description: 'Usage', loaded: false },
      ],
    });
    expect(await call('hub/find', { query: 'read', kinds: ['context'] })).toMatchObject({ status: 'done', result: [{ name: 'fs/guide' }] });
  });

  it('inspect shows a fn\'s card and a context item\'s text at a detail, and refuses what isn\'t there', async () => {
    const { r, call } = await started();
    expect(await call('hub/inspect', { name: 'fs/read', detail: 'listed' })).toEqual({ status: 'done', result: { name: 'fs/read', kind: 'fn', detail: 'listed', text: '### fs/read — Read a text file.' } });
    expect(await call('hub/inspect', { name: 'fs/guide' })).toEqual({ status: 'done', result: { name: 'fs/guide', kind: 'context', detail: 'full', text: 'Use fs/read for files.' } });
    // a bad name is the model's mistake, which it can retry: the run is invalid input (a code caller sees the code), not a failure
    const nothing = await call('hub/inspect', { name: 'fs/nothing' });
    expect(nothing).toMatchObject({ status: 'failed', error: { class: 'caller', code: INVALID_INPUT_CODE, data: { source: 'validation', problems: [{ path: 'name' }] } } });
    expect(nothing.status === 'failed' ? nothing.error.message : '').toContain('use find');
    expect((await r.store.table('runs').find({ where: { fn: 'hub/inspect', status: 'invalid-input' }, limit: 5 })).items).toHaveLength(1);
    const notAName = await call('hub/inspect', { name: 'not a name' });
    expect(notAName).toMatchObject({ error: { code: INVALID_INPUT_CODE } });
    expect(notAName.status === 'failed' ? notAName.error.message : '').toContain('is not a name');
    expect(await call('hub/inspect', { name: 'fs/off' })).toMatchObject({ error: { code: INVALID_INPUT_CODE, message: "name: fs/off can't be used here" } });
  });

  it('load and unload change the session\'s loaded fns and context, refusing what can\'t be loaded', async () => {
    const { r, call } = await started();
    expect(await call('hub/load', { names: ['fs/guide', 'fs/off', 'nope', 'fs/missing'] })).toEqual({
      status: 'done', result: {
        loaded: ['fs/guide'],
        refused: [{ name: 'fs/off', reason: 'switched off' }, { name: 'nope', reason: 'not a name (system/name)' }, { name: 'fs/missing', reason: 'no fn or context has that name' }],
      },
    });
    expect((await r.store.table('sessions').get(SESSION))?.context).toEqual(['fs/guide']);
    expect(await call('hub/unload', { names: ['fs/read', 'fs/guide', 'fs/other'] })).toEqual({
      status: 'done', result: { unloaded: ['fs/read', 'fs/guide'], refused: [{ name: 'fs/other', reason: 'not loaded' }] },
    });
    const session = await r.store.table('sessions').get(SESSION);
    expect([session?.tools, session?.context]).toEqual([[], []]);
  });

  it('inspect and load show memory only in its scope, as every reader of context does', async () => {
    const { r, call } = await started();
    expect(await call('hub/inspect', { name: 'memory/mine' })).toMatchObject({ status: 'done', result: { kind: 'context', text: 'Alice likes tea.' } });
    for (const name of ['memory/bobs', 'memory/elsewhere']) expect(await call('hub/inspect', { name })).toMatchObject({ status: 'failed', error: { code: INVALID_INPUT_CODE } });
    expect(await call('hub/load', { names: ['memory/mine', 'memory/bobs'] })).toEqual({
      status: 'done', result: { loaded: ['memory/mine'], refused: [{ name: 'memory/bobs', reason: 'no fn or context has that name' }] },
    });
    expect((await r.store.table('sessions').get(SESSION))?.context).toEqual(['memory/mine']);
  });

  it('inspect shows a named type as gin code, and only its line when listed', async () => {
    const { call } = await started();
    expect(await call('hub/inspect', { name: 'fs/Entry' })).toEqual({ status: 'done', result: { name: 'fs/Entry', kind: 'type', detail: 'full', text: '// One file.\ntype fs/Entry = obj{path: text}' } });
    expect(await call('hub/inspect', { name: 'fs/Entry', detail: 'listed' })).toMatchObject({ status: 'done', result: { text: 'fs/Entry — One file.' } });
  });

  it('model_limits gives each model\'s limits with their sources', async () => {
    const { call } = await started();
    expect(await call('hub/model_limits', { model: 'test-model' })).toMatchObject({
      status: 'done', result: [{ model: 'test-model', limits: { contextWindow: 100_000, maxOutputTokens: 1_024 }, sources: { contextWindow: 'model-info', maxOutputTokens: 'default' } }],
    });
  });

  it('inspect shows dynamic context with the text its system writes for the person', async () => {
    const { call } = await started();
    expect(await call('hub/inspect', { name: 'fs/tree' })).toMatchObject({ status: 'done', result: { kind: 'context', text: 'tree for Alice' } });
    expect(await call('hub/inspect', { name: 'fs/tree', detail: 'signature' })).toMatchObject({ status: 'done', result: { text: 'The folder tree.' } });
  });

  it('find and inspect keep to a hub MCP\'s scope when its client runs them', async () => {
    const scope: FnScope = {
      fns: new Set([QualifiedName.parse('fs/read')]), types: new Set(), context: new Set([QualifiedName.parse('fs/guide')]), allowsResource: (uri) => uri.startsWith('file:///docs/'),
    };
    const { search, call } = await started({ scope });
    search.hits = [
      { kind: 'fn', key: 'fs/off', score: 1, text: '' },
      { kind: 'fn', key: 'fs/read', score: 0.9, text: '' },
      { kind: 'context', key: 'memory/mine', score: 0.8, text: '' },
      { kind: 'context', key: 'fs/guide', score: 0.7, text: '' },
      { kind: 'section', key: 'file:///a.md#Usage', score: 0.6, text: 'Usage' },
      { kind: 'section', key: 'file:///docs/b.md#Intro', score: 0.5, text: 'Intro' },
    ];
    const found = await call('hub/find', { query: 'read', limit: 2 }, MCP_CALLER);
    expect(found.status === 'done' ? found.result : found).toMatchObject([{ name: 'fs/read' }, { name: 'fs/guide' }]);
    const all = await call('hub/find', { query: 'read' }, MCP_CALLER);
    expect(all.status === 'done' ? all.result : all).toMatchObject([{ name: 'fs/read' }, { name: 'fs/guide' }, { name: 'file:///docs/b.md#Intro' }]);
    expect(await call('hub/inspect', { name: 'fs/read', detail: 'listed' }, MCP_CALLER)).toMatchObject({ status: 'done' });
    // what the MCP leaves out is not there for its client, even what the chat can see
    for (const name of ['fs/Entry', 'memory/mine']) {
      const hidden = await call('hub/inspect', { name }, MCP_CALLER);
      expect(hidden).toMatchObject({ status: 'failed', error: { code: INVALID_INPUT_CODE } });
      expect(hidden.status === 'failed' ? hidden.error.message : '').toContain('there is no fn, context or type');
      expect(await call('hub/inspect', { name })).toMatchObject({ status: 'done' });
    }
  });
});
