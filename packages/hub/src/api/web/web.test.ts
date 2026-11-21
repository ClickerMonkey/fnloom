/**
 * The web API end to end in one process: the real plugins, sign-in, middleware and store, with fakes for the modules
 * the handlers hand work to. Each test checks what reaches those modules and what the browser gets back.
 */
import { ApiError, manifestFromSpec } from '@ayepi/core';
import { describe, expect, it } from 'vitest';
import {
  ActorId, ContextDecl, DEFAULT_SIGN_IN_LIMITS, hubWebSpec, MAIN_INSTANCE, mintId, ModelCallId, NotificationId, QualifiedName, ResourceUri, RunId, SessionId, SystemName, TurnId, type ActorKind, type ModelForward, type ModelInfo, type ModelRoleView, type ResolvedLimits, type Run, type SettingDecl, type Session, type SystemRecord, type Tokens,
} from '@harness/core';
import { fn, g, wireType } from '@harness/sdk';
import { TestCatalog } from '../../execution/testing.ts';
import { ScryptHasher } from '../hash.ts';
import { settle } from '../../testing.ts';
import { instanceRow } from '../../catalog/fixtures.ts';
import { entriesFrom, rig, testManifest, webRig, type Fakes } from '../testing/rig.ts';
import { clientUrl } from './chat.ts';
import { testCall } from './review.ts';

const sessionId = SessionId.parse('ses_1');
const client = { timeZone: 'Europe/Paris', locale: 'fr', now: 1 };
/** The dictation role while it is off (no transcription model, no browser engine). */
const DICTATION_OFF: ModelRoleView = { role: 'dictate', from: 'none' };
/** Dictation through a transcription model that resolves. */
const DICTATION_MODEL: ModelRoleView = {
  role: 'dictate', from: 'setting', choice: { role: 'dictate', engine: { engine: 'model', model: { model: 'whisper-1' } }, language: 'en' },
  resolved: { model: 'whisper-1', provider: 'openai' },
};

function session(owner: ActorId, fields: Partial<Session> = {}): Session {
  return {
    id: sessionId, title: 'Plans', owner, agent: QualifiedName.parse('hub/chat'), participants: [], systems: 'all', tools: [], context: [], status: 'idle',
    transcript: [], createdAt: 1, updatedAt: 1, archived: false, ...fields,
  };
}

function runRow(id: string, fields: Partial<Run> = {}): Run {
  return {
    id: RunId.parse(id), fn: QualifiedName.parse('fs/read'), fnVersion: 'v1', kind: 'native', system: SystemName.parse('fs'), root: RunId.parse('run_root'),
    turn: TurnId.parse('trn_1'), session: sessionId, key: id, actor: ActorId.parse('act_x'), caller: ActorId.parse('act_x'), args: {}, status: 'done',
    allowed: { cancel: true, pause: false, background: true }, cost: 0, totalCost: 0, priority: 'interactive', background: false, attempt: 1, errors: [],
    stateChanges: [], createdAt: 1, ...fields,
  };
}

function systemRow(name: string, fields: Partial<SystemRecord> = {}): SystemRecord {
  return {
    name: SystemName.parse(name), description: `${name} system`, status: 'connected', enabled: { functions: true, renderers: true }, version: '1.0.0', manifestHash: 'h', actor: ActorId.parse(`act_${name}`), ...fields,
  };
}

/** A rig with the web API installed and an admin signed in; no embedder is up unless the test fakes one (`capabilities.meaning`). */
async function signedIn(fakes: Fakes = {}) {
  const r = await rig({ ...fakes, index: { ...fakes.index, embedders: { active: () => undefined, ...fakes.index?.embedders } } });
  const web = await webRig(r);
  const tokens = await web.admin();
  return { r, web, tokens, as: web.as(tokens), me: tokens.user.id };
}

/** A member who can sign in (members are added without a password; tests give them one). */
async function member(r: Awaited<ReturnType<typeof rig>>, web: Awaited<ReturnType<typeof webRig>>): Promise<Tokens> {
  const id = mintId('actor');
  await r.store.table('actors').insert({ id, kind: 'user', name: 'Mem', about: '', email: 'mem@example.com', role: 'member', createdAt: 1, disabled: false });
  await r.store.table('credentials').insert({ user: id, kind: 'password', secretHash: await new ScryptHasher(10).hash('member password'), createdAt: 1 });
  return web.client.call('signIn', { email: 'mem@example.com', password: 'member password' });
}

describe('the assembled web API', () => {
  it('serves exactly hubWebSpec', async () => {
    const { web } = await signedIn();
    const served = web.app.manifest();
    const wanted = manifestFromSpec(hubWebSpec);
    expect(Object.keys(served.endpoints).sort()).toEqual(Object.keys(wanted.endpoints).sort());
    expect(served.events).toEqual(wanted.events);
    for (const [name, endpoint] of Object.entries(wanted.endpoints)) { expect(served.endpoints[name]).toEqual(endpoint); }
  });
});

describe('sign-in', () => {
  it('makes the admin once, then signs in and out', async () => {
    const r = await rig();
    const web = await webRig(r);
    await expect(web.client.call('setup')).resolves.toMatchObject({ needsAdmin: true });
    const tokens = await web.admin();
    await expect(web.client.call('setup')).resolves.toMatchObject({ needsAdmin: false });
    await expect(web.admin()).rejects.toMatchObject({ status: 409, code: 'ADMIN_EXISTS' });
    await expect(web.client.call('me', web.as(tokens))).resolves.toEqual(tokens.user);
    await web.client.call('signOut', web.as(tokens));
    await expect(web.client.call('me', web.as(tokens))).rejects.toMatchObject({ status: 401 });
  });

  it('refuses to make the first admin without the setup code the hub logged (anyone on the network could otherwise)', async () => {
    const r = await rig();
    const web = await webRig(r);
    const mallory = { email: 'mallory@example.com', name: 'Mallory', password: 'correct horse battery' };
    // before the hub made a code, and with a wrong one after
    await expect(web.client.call('createAdmin', { ...mallory, setup: 'guess' })).rejects.toMatchObject({ status: 403, code: 'SETUP_CODE' });
    const code = await r.hub.api.auth.openSetup();
    await expect(web.client.call('createAdmin', { ...mallory, setup: 'guess' })).rejects.toMatchObject({ status: 403, code: 'SETUP_CODE' });
    await expect(web.client.call('setup')).resolves.toMatchObject({ needsAdmin: true });
    await expect(web.client.call('createAdmin', { ...mallory, email: 'admin@example.com', setup: code ?? '' })).resolves.toMatchObject({ user: { role: 'admin' } });
  });

  it('says why a sign-in failed, and slows down repeated tries', async () => {
    const r = await rig();
    const web = await webRig(r);
    await web.admin();
    const wrong = { email: 'admin@example.com', password: 'nope' };
    const error: unknown = await web.client.call('signIn', wrong).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, data: { reason: 'That email and password don’t match.' } });
    for (let i = 1; i < DEFAULT_SIGN_IN_LIMITS.account.limit; i++) { await web.client.call('signIn', wrong).catch(() => undefined); }
    await expect(web.client.call('signIn', { ...wrong, password: 'correct horse battery' })).rejects.toMatchObject({ status: 429 });
  });

  it('refreshes tokens and refuses a bad refresh token', async () => {
    const { web, tokens } = await signedIn();
    const next = await web.client.call('refresh', { refresh: tokens.refresh });
    await expect(web.client.call('me', web.as(next))).resolves.toMatchObject({ id: tokens.user.id });
    await expect(web.client.call('refresh', { refresh: 'aus_x.y' })).rejects.toMatchObject({ status: 401 });
  });

  it('refuses signed-in endpoints without a token', async () => {
    const { web } = await signedIn();
    await expect(web.client.call('sessions', {})).rejects.toMatchObject({ status: 401 });
  });

  it('keeps admin endpoints from members', async () => {
    const { r, web } = await signedIn();
    const mem = await member(r, web);
    await expect(web.client.call('systems', {}, web.as(mem))).rejects.toMatchObject({ status: 403, code: 'ADMIN_ONLY' });
    await expect(web.client.call('addGroup', { name: 'g', about: '' }, web.as(mem))).rejects.toMatchObject({ status: 403 });
  });
});

describe('chat', () => {
  it('creates a session for the signed-in person with the hub agent by default', async () => {
    const created: unknown[] = [];
    const { web, as, me } = await signedIn({ chat: { sessions: { create: (input) => { created.push(input); return Promise.resolve(session(input.owner)); } } } });
    await web.client.call('createSession', { title: 'Plans' }, as);
    expect(created).toEqual([{ title: 'Plans', owner: me, agent: 'hub/chat' }]);
  });

  it('creates a session from an empty body (New chat sends no fields)', async () => {
    const created: unknown[] = [];
    const { web, as, me } = await signedIn({ chat: { sessions: { create: (input) => { created.push(input); return Promise.resolve(session(input.owner)); } } } });
    await web.client.call('createSession', {}, as);
    expect(created).toEqual([{ owner: me, agent: 'hub/chat' }]);
  });

  it('answers 404 for a session the person may not see, and passes sends through as the author', async () => {
    const sends: unknown[] = [];
    const { web, as, me } = await signedIn({
      chat: {
        sessions: { get: (id, viewer) => Promise.resolve(id === sessionId ? session(viewer) : undefined) },
        turns: {
          send: (input) => {
            sends.push(input);
            return Promise.resolve({ turn: TurnId.parse('trn_1'), message: { id: mintId('message'), session: input.session, turn: TurnId.parse('trn_1'), author: input.author, role: 'user', parts: [], runs: [], status: 'done', replyAll: false, answerers: [], createdAt: 1 } });
          },
        },
      },
    });
    await expect(web.client.call('session', { session: SessionId.parse('ses_other') }, as)).rejects.toMatchObject({ status: 404 });
    await web.client.call('send', { session: sessionId, parts: [{ type: 'text', text: 'hi' }], client }, as);
    expect(sends).toEqual([{ session: sessionId, parts: [{ type: 'text', text: 'hi' }], client, author: me }]);
  });

  it('resolves the budget meter with the person’s groups and time zone', async () => {
    const resolved: unknown[] = [];
    const { r, web, as, me } = await signedIn({
      chat: { sessions: { get: (_id, viewer) => Promise.resolve(session(viewer)) } },
      execution: {
        limits: {
          resolve: (input) => {
            resolved.push(input);
            return Promise.resolve({ priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 1 }, budgets: [] });
          },
        },
      },
    });
    const group = mintId('actor');
    await r.store.table('actors').insert({ id: group, kind: 'group', name: 'Team', about: '', createdAt: 1, disabled: false });
    await r.store.table('memberships').insert({ group, user: me, addedBy: me, addedAt: 1 });
    await web.client.call('limits', { session: sessionId }, as);
    expect(resolved).toMatchObject([{ session: sessionId, user: { id: me, groups: [{ id: group, name: 'Team' }], timeZone: 'UTC', locale: 'en' } }]);
  });

  it('offers only what connected, enabled systems in the session serve', async () => {
    const fs = SystemName.parse('fs');
    const off = SystemName.parse('off');
    const { r, web, as, me } = await signedIn({
      chat: { sessions: { get: (_id, viewer) => Promise.resolve(session(viewer, { systems: [fs, off] })) } },
      catalog: {
        entries: entriesFrom({
          mentions: [
            { name: QualifiedName.parse('fs/file'), system: fs, decl: { name: 'file', title: 'Files', description: '', target: { name: 'text' } } },
            { name: QualifiedName.parse('off/x'), system: off, decl: { name: 'x', title: 'X', description: '', target: { name: 'text' } } },
          ],
          context: [
            { name: QualifiedName.parse('fs/guide'), system: fs, decl: ContextDecl.parse({ name: 'guide', description: 'Guide', command: { name: 'guide', args: [] }, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: [] }) },
            { name: QualifiedName.parse('off/notes'), system: off, decl: ContextDecl.parse({ name: 'notes', description: 'Notes', command: { name: 'notes', args: [] }, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: [] }) },
          ],
        }),
        fns: () => Promise.resolve([]),
        manifest: () => Promise.resolve(undefined),
      },
      models: { roles: { get: () => Promise.resolve(DICTATION_OFF) } },
      execution: { llm: { models: () => Promise.resolve([
        { id: 'openrouter/auto', provider: 'openrouter', name: 'Auto', capabilities: ['chat'] },
        { id: 'amazon/titan-embed', provider: 'openrouter', name: 'Titan Embeddings', capabilities: ['chat', 'embedding'] },
      ]) } },
    });
    await r.store.table('systems').insert(systemRow('fs'));
    await r.store.table('systems').insert(systemRow('off', { enabled: { functions: false, renderers: true } }));
    // a memory with a /command is the hub's own: always offered, never waiting on a system called memory
    await r.store.table('context').insert({
      name: QualifiedName.parse('memory/gollum-1a2b'), system: SystemName.parse('hub'), origin: { type: 'memory', scope: { to: 'everyone' }, author: me }, stale: false, updatedAt: 0,
      decl: ContextDecl.parse({ name: 'gollum-1a2b', description: 'Gollum', command: { name: 'gollum', args: [] }, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: [] }), mentions: { context: [], fns: [] }, tokens: { full: 1, summary: 1 },
    });
    const caps = await web.client.call('capabilities', { session: sessionId }, as);
    expect(caps.mentions).toEqual([{ provider: 'fs/file', title: 'Files' }]);
    // a command whose system can't run it now is listed greyed out, with the reason
    expect(caps.commands).toEqual([
      { name: 'guide', context: 'fs/guide', args: [], description: 'Guide' },
      { name: 'notes', context: 'off/notes', args: [], description: 'Notes', unavailable: 'the off system has its functions switched off' },
      { name: 'gollum', context: 'memory/gollum-1a2b', args: [], description: 'Gollum' },
    ]);
    expect(caps.systems).toEqual([{ name: fs, status: 'connected', enabled: true }, { name: off, status: 'connected', enabled: false }]);
    // the picker gets chat models with what it shows, and no embedding models
    expect(caps.models).toEqual([{ id: 'openrouter/auto', provider: 'openrouter', name: 'Auto', capabilities: ['chat'] }]);
    expect(caps).toMatchObject({ voiceInput: false, uploads: true, invocations: [], clients: [] });
  });

  it('ships a system’s client renderers by its renderers switch alone, apart from its fns switch', async () => {
    const fs = SystemName.parse('fs');
    const off = SystemName.parse('off');
    const dark = SystemName.parse('dark');
    const built = (system: SystemName) => ({ entry: 'index.js', hash: `b_${system}`, files: [{ path: 'index.js', size: 1, hash: 'f' }] });
    const asked: SystemName[] = [];
    const { r, web, as } = await signedIn({
      chat: { sessions: { get: (_id, viewer) => Promise.resolve(session(viewer, { systems: [fs, off, dark] })) } },
      catalog: {
        entries: entriesFrom({}),
        fns: () => Promise.resolve([]),
        manifest: (system) => { asked.push(system); return Promise.resolve(testManifest(system, { client: built(system) })); },
      },
      models: { roles: { get: () => Promise.resolve(DICTATION_OFF) } },
      execution: { llm: { models: () => Promise.resolve([]) } },
    });
    await r.store.table('systems').insert(systemRow('fs'));
    // fns off, renderers on: old cards keep rendering with its client
    await r.store.table('systems').insert(systemRow('off', { enabled: { functions: false, renderers: true } }));
    // fns on, renderers off: its client is withdrawn
    await r.store.table('systems').insert(systemRow('dark', { enabled: { functions: true, renderers: false } }));
    // renderers on, but not a system this session lets in
    await r.store.table('systems').insert(systemRow('elsewhere'));
    const caps = await web.client.call('capabilities', { session: sessionId }, as);
    const shipped = (system: SystemName) => ({ system, url: clientUrl(system, built(system).hash, 'index.js'), hash: built(system).hash });
    expect(caps.clients).toEqual([shipped(fs), shipped(off)]);
    expect(asked.sort()).toEqual([fs, off]);
    expect(caps.systems).toEqual([
      { name: dark, status: 'connected', enabled: true }, { name: fs, status: 'connected', enabled: true }, { name: off, status: 'connected', enabled: false },
    ]);
    // switching the renderers back on ships the client again; switching them off withdraws it
    await r.store.table('systems').update(dark, { enabled: { functions: true, renderers: true } });
    await r.store.table('systems').update(off, { enabled: { functions: false, renderers: false } });
    expect((await web.client.call('capabilities', { session: sessionId }, as)).clients).toEqual([shipped(dark), shipped(fs)]);
  });

  it('offers fns as `!` invocations, but not a type’s methods (those run on a value from its hover card)', async () => {
    const fs = SystemName.parse('fs');
    const fns = new TestCatalog();
    const read = fns.add('fs', 'read', fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text() }));
    const reveal = fns.add('fs', 'Entry.reveal', fn({ description: 'Show it in the file manager.', args: g.obj({ path: g.text() }), returns: g.bool() }));
    const { r, web, as } = await signedIn({
      chat: { sessions: { get: (_id, viewer) => Promise.resolve(session(viewer)) } },
      catalog: {
        entries: entriesFrom({
          types: [{
            name: QualifiedName.parse('fs/Entry'), system: fs,
            decl: { name: 'Entry', description: 'A file or folder.', def: wireType(g.obj({ path: g.text() })), display: { label: 'Entry' }, methods: ['reveal'] },
          }],
        }),
        fns: () => Promise.resolve([read, reveal]),
        manifest: () => Promise.resolve(undefined),
      },
      models: { roles: { get: () => Promise.resolve(DICTATION_OFF) } },
      execution: { llm: { models: () => Promise.resolve([]) } },
    });
    await r.store.table('systems').insert(systemRow('fs'));
    const caps = await web.client.call('capabilities', { session: sessionId }, as);
    expect(caps.invocations.map((i) => i.fn)).toEqual(['fs/read']);
  });
});

describe('runs', () => {
  it('builds a turn’s tree from its runs and LLM calls', async () => {
    const { r, web, as, me } = await signedIn({ chat: { sessions: { get: (_id, viewer) => Promise.resolve(session(viewer)) } } });
    const turn = TurnId.parse('trn_1');
    await r.store.table('turns').insert({
      id: turn, session: sessionId, actor: me, user: { id: me, name: 'A', email: 'a', role: 'admin', groups: [], timeZone: 'UTC', locale: 'en' },
      time: { now: 1, timeZone: 'UTC', local: 'x' }, root: RunId.parse('run_root'), status: 'done',
      limits: { priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 1 }, budgets: [] }, cost: 0, errors: 'feed-back', createdAt: 1,
    });
    await r.store.table('runs').insert(runRow('run_root', { fn: QualifiedName.parse('hub/chat'), createdAt: 1 }));
    await r.store.table('runs').insert(runRow('run_b', { parent: RunId.parse('run_root'), createdAt: 3 }));
    await r.store.table('runs').insert(runRow('run_a', { parent: RunId.parse('run_root'), createdAt: 2 }));
    await r.store.table('runs').insert(runRow('run_c', { parent: RunId.parse('run_a'), createdAt: 4 }));
    await r.store.table('llmInteractions').insert({
      id: mintId('llmInteraction'), turn, run: RunId.parse('run_root'), iteration: 0, provider: 'openrouter', model: 'm', request: { messages: [] }, cost: 0.01,
      status: 'done', priority: 'interactive', queuedAt: 1,
    });
    const tree = await web.client.call('tree', { turn }, as);
    expect(tree.run.id).toBe('run_root');
    expect(tree.llmCalls).toMatchObject([{ model: 'm', cost: 0.01, status: 'done' }]);
    expect(tree.children.map((c) => c.run.id)).toEqual(['run_a', 'run_b']);
    expect(tree.children[0]?.children.map((c) => c.run.id)).toEqual(['run_c']);
    await expect(web.client.call('tree', { turn: TurnId.parse('trn_none') }, as)).rejects.toMatchObject({ status: 404 });
  });

  it('checks a person may see a run before backgrounding it or reading its state', async () => {
    const backgrounded: RunId[] = [];
    const { r, web, as } = await signedIn({
      chat: { sessions: { get: (id, viewer) => Promise.resolve(id === sessionId ? session(viewer) : undefined) }, state: { forRun: () => Promise.resolve({ system: SystemName.parse('fs'), fields: [{ name: 'open', type: 't', value: true }] }) } },
      execution: {
        runs: {
          get: (id) => Promise.resolve(id === RunId.parse('run_1') ? runRow('run_1') : undefined),
          background: (id) => { backgrounded.push(id); return Promise.resolve(true); },
        },
      },
    });
    const mem = await member(r, web);
    await expect(web.client.call('background', { run: RunId.parse('run_1') }, as)).resolves.toEqual({ accepted: true });
    await expect(web.client.call('state', { run: RunId.parse('run_1') }, as)).resolves.toEqual({ system: 'fs', fields: [{ name: 'open', type: 't', value: true }] });
    await expect(web.client.call('background', { run: RunId.parse('run_2') }, as)).rejects.toMatchObject({ status: 404 });
    expect(backgrounded).toEqual(['run_1']);
    // A member who isn't in the session doesn't see its runs (admins see everything).
    r.hub.chat.sessions.get = () => Promise.resolve(undefined);
    await expect(web.client.call('state', { run: RunId.parse('run_1') }, web.as(mem))).rejects.toMatchObject({ status: 404 });
  });

  it('lists what waits on the person in a session: its pending approvals and the questions asked of them', async () => {
    const { r, web, as, me } = await signedIn({ chat: { sessions: { get: (id, viewer) => Promise.resolve(id === sessionId ? session(viewer) : undefined) } } });
    await r.store.table('runs').insert(runRow('run_here', { status: 'awaiting-approval' }));
    await r.store.table('runs').insert(runRow('run_away', { status: 'awaiting-approval', session: SessionId.parse('ses_other') }));
    const approval = (id: string, run: string, status: 'pending' | 'approved') => ({
      id: mintId('approval'), run: RunId.parse(run), fn: QualifiedName.parse('fs/bash'), approver: { by: 'turn-user' as const }, status, decisions: [], createdAt: id.length,
    });
    const here = approval('a', 'run_here', 'pending');
    await r.store.table('approvals').insert(here);
    await r.store.table('approvals').insert(approval('bb', 'run_here', 'approved'));
    await r.store.table('approvals').insert(approval('ccc', 'run_away', 'pending'));
    const asked = { id: mintId('handlerCall'), run: RunId.parse('run_here'), handler: 'confirm', args: {}, decl: { description: 'Confirm', args: { name: 'object' }, returns: { name: 'boolean' } }, status: 'pending' as const, createdAt: 2 };
    await r.store.table('handlerCalls').insert({ ...asked, answerer: { user: me } });
    await r.store.table('handlerCalls').insert({ ...asked, id: mintId('handlerCall'), answerer: { user: ActorId.parse('act_someone') } });
    const waiting = await web.client.call('waiting', { session: sessionId }, as);
    expect(waiting.approvals.map((a) => a.id)).toEqual([here.id]);
    expect(waiting.handlers.map((h) => h.id)).toEqual([asked.id]);
    await expect(web.client.call('waiting', { session: SessionId.parse('ses_nope') }, as)).rejects.toMatchObject({ status: 404 });
  });

  it('answers a handler as the person', async () => {
    const answers: unknown[] = [];
    const { r, web, as, me } = await signedIn({ execution: { handlers: { answer: (call, value, by) => { answers.push({ call, value, by }); return Promise.resolve(); } } } });
    const call = mintId('handlerCall');
    await r.store.table('handlerCalls').insert({
      id: call, run: RunId.parse('run_1'), handler: 'pick', args: {}, decl: { description: 'Pick one', args: { name: 'object' }, returns: { name: 'object' } },
      answerer: { user: me }, status: 'pending', createdAt: 1,
    });
    await web.client.call('answer', { call, value: { ok: true } }, as);
    expect(answers).toMatchObject([{ value: { ok: true }, by: me }]);
  });
});

describe('inbox and content', () => {
  it('keeps one push subscription per browser endpoint', async () => {
    const { r, web, as } = await signedIn();
    const sub = { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' }, device: 'phone' };
    const first = await web.client.call('subscribePush', sub, as);
    const again = await web.client.call('subscribePush', { ...sub, keys: { p256dh: 'p2', auth: 'a2' } }, as);
    expect(again.id).toBe(first.id);
    await expect(r.store.table('pushSubscriptions').count()).resolves.toBe(1);
    await expect(web.client.call('pushKey', as)).resolves.toEqual({ publicKey: 'test-public-key' });
  });

  it('lists and reads the person’s notifications through the chat module', async () => {
    const read: unknown[] = [];
    const { web, as, me } = await signedIn({
      chat: {
        notifications: {
          list: (user, query) => Promise.resolve({ items: [{ id: NotificationId.parse('ntf_1'), user, reason: 'replied', title: 't', body: 'b', link: { session: sessionId }, read: query.unread === true ? false : true, pushed: false, createdAt: 1 }] }),
          read: (user, ids) => { read.push({ user, ids }); return Promise.resolve(ids.length); },
        },
      },
    });
    await expect(web.client.call('notifications', { unread: true }, as)).resolves.toMatchObject({ items: [{ read: false }] });
    await web.client.call('readNotifications', { ids: ['ntf_1'] }, as);
    expect(read).toEqual([{ user: me, ids: ['ntf_1'] }]);
    await expect(web.client.call('readNotifications', { ids: ['run_1'] }, as)).rejects.toThrow();
    expect(read).toHaveLength(1);
  });

  it('presigns uploads, and refuses to transcribe without a transcription model', async () => {
    const { web, as } = await signedIn({ models: { roles: { get: () => Promise.resolve(DICTATION_OFF) } } });
    const presigned = await web.client.call('upload', { name: 'a.png', mime: 'image/png', size: 3 }, as);
    expect(presigned.url).toContain('/_files');
    await expect(web.client.call('transcribe', { audio: { hash: 'a'.repeat(64), size: 1, mime: 'audio/webm' } }, as)).rejects.toMatchObject({ status: 501 });
  });

  it('transcribes an uploaded recording through the dictation role’s model, and offers voice input', async () => {
    const heard: Array<{ request: ModelForward; site: unknown; role: unknown }> = [];
    const { r, web, as } = await signedIn({
      models: {
        roles: { get: () => Promise.resolve(DICTATION_MODEL) },
        gateway: {
          forward: (request, site, _signal, role) => {
            heard.push({ request, site, role });
            return Promise.resolve({ modality: 'transcribe', text: 'book a table for two', call: ModelCallId.parse('mdl_1'), cost: 0.001, model: 'whisper-1' });
          },
        },
      },
      execution: { llm: { models: () => Promise.resolve([]) } },
      chat: { sessions: { get: (_id, viewer) => Promise.resolve(session(viewer)) } },
      catalog: { entries: entriesFrom({}), fns: () => Promise.resolve([]), manifest: () => Promise.resolve(undefined) },
    });
    const audio = await r.api.content.put(new Uint8Array([1, 2, 3, 4, 5]), 'audio/webm');
    await expect(web.client.call('transcribe', { audio }, as)).resolves.toEqual({ text: 'book a table for two' });
    // the dictation role's model and provider answer: the gateway resolves them, the provider a real field, not a name prefix
    expect(heard).toEqual([{ request: { modality: 'transcribe', audio, language: 'en' }, site: { purpose: 'dictation' }, role: 'dictate' }]);
    const picture = await r.api.content.put(new Uint8Array([9]), 'image/png');
    await expect(web.client.call('transcribe', { audio: picture }, as)).rejects.toMatchObject({ status: 422 });
    const caps = await web.client.call('capabilities', { session: sessionId }, as);
    expect(caps).toMatchObject({ voiceInput: true, dictation: { engine: 'model', language: 'en' } });
  });

  it('offers browser dictation without any model', async () => {
    const { web, as } = await signedIn({
      models: { roles: { get: () => Promise.resolve({ role: 'dictate', from: 'setting', choice: { role: 'dictate', engine: { engine: 'browser' } } }) } },
      execution: { llm: { models: () => Promise.resolve([]) } },
      chat: { sessions: { get: (_id, viewer) => Promise.resolve(session(viewer)) } },
      catalog: { entries: entriesFrom({}), fns: () => Promise.resolve([]), manifest: () => Promise.resolve(undefined) },
    });
    const caps = await web.client.call('capabilities', { session: sessionId }, as);
    expect(caps).toMatchObject({ voiceInput: true, dictation: { engine: 'browser' } });
    await expect(web.client.call('transcribe', { audio: { hash: 'a'.repeat(64), size: 1, mime: 'audio/webm' } }, as)).rejects.toMatchObject({ status: 501 });
  });
});

describe('admin', () => {
  it('lists systems without their keys, with fn counts and config types', async () => {
    const { r, web, as } = await signedIn({
      catalog: { fns: ({ system }) => Promise.resolve(system === SystemName.parse('fs') ? [] : []), manifest: () => Promise.resolve(undefined) },
    });
    await r.store.table('systems').insert(systemRow('fs', { status: 'needs-config' }));
    await r.store.table('systems').insert(systemRow('gone', { status: 'removed' }));
    const systems = await web.client.call('systems', {}, as);
    expect(systems).toHaveLength(1);
    expect(systems[0]).toMatchObject({ name: 'fs', counts: { fns: 0 }, needsConfig: true });
    expect(systems[0]).not.toHaveProperty('publicKey');
    await expect(web.client.call('system', { system: SystemName.parse('nope') }, as)).rejects.toMatchObject({ status: 404 });
  });

  it('turns a system’s parts on and off through the link module and announces it', async () => {
    const changes: unknown[] = [];
    const { r, web, as, me } = await signedIn({
      link: { admin: { setEnabled: (system, change, by) => { changes.push({ system, change, by }); return Promise.resolve({ functions: false, renderers: true }); } } },
    });
    await r.store.table('systems').insert(systemRow('fs'));
    let announced = 0;
    r.bus.subscribe('capabilities.changed', () => { announced += 1; });
    await expect(web.client.call('enableSystem', { system: SystemName.parse('fs'), functions: false }, as)).resolves.toEqual({ enabled: { functions: false, renderers: true } });
    await settle();
    expect(changes).toEqual([{ system: 'fs', change: { functions: false }, by: me }]);
    expect(announced).toBe(1);
  });

  it('approves and rejects pairings as the admin', async () => {
    const calls: string[] = [];
    const { web, as } = await signedIn({
      link: {
        pairing: {
          approve: (pairing) => { calls.push(`approve ${pairing}`); return Promise.resolve(instanceRow('fs', 'connected')); },
          reject: (pairing) => { calls.push(`reject ${pairing}`); return Promise.resolve(); },
        },
      },
    });
    const pairing = mintId('pairing');
    await expect(web.client.call('approvePairing', { pairing, approve: true }, as)).resolves.toEqual({ system: 'fs' });
    await expect(web.client.call('approvePairing', { pairing, approve: false }, as)).resolves.toEqual({});
    expect(calls).toEqual([`approve ${pairing}`, `reject ${pairing}`]);
  });

  it('passes the auto-pair choice on, and lists and revokes auto-pair secrets as the admin', async () => {
    const calls: unknown[] = [];
    const id = mintId('autoPair');
    const view = { id, system: SystemName.parse('fs'), instance: MAIN_INSTANCE, createdBy: mintId('actor'), createdAt: 1, uses: 0 };
    const { web, as } = await signedIn({
      link: {
        pairing: { approve: (_pairing, _by, choice) => { calls.push(choice); return Promise.resolve(instanceRow('fs', 'connected')); } },
        autoPairs: {
          list: (system) => { calls.push(system); return Promise.resolve([view]); },
          revoke: (revoked) => { calls.push(revoked); return Promise.resolve(true); },
        },
      },
    });
    await web.client.call('approvePairing', { pairing: mintId('pairing'), approve: true, autoPair: { expiresIn: null } }, as);
    await expect(web.client.call('autoPairs', { system: SystemName.parse('fs') }, as)).resolves.toEqual([view]);
    await expect(web.client.call('revokeAutoPair', { id }, as)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ autoPair: { expiresIn: null } }, 'fs', id]);
  });

  it('stores provider keys sealed and replaces a provider’s old key', async () => {
    let reloads = 0;
    const models: ModelInfo[] = [
      { id: 'a', provider: 'openrouter', name: 'A', capabilities: [] }, { id: 'b', provider: 'openrouter', name: 'B', capabilities: [] },
      { id: 'c', provider: 'openai', name: 'C', capabilities: [] },
    ];
    const { r, web, as } = await signedIn({
      execution: { llm: { models: () => Promise.resolve(models) }, providers: { reload: () => { reloads += 1; return Promise.resolve(); } } },
    });
    await expect(web.client.call('configureProvider', { provider: 'openrouter', apiKey: 'sk-or-first' }, as)).resolves.toEqual({ models: 2 });
    expect(reloads).toBe(1);
    await web.client.call('configureProvider', { provider: 'openrouter', apiKey: 'sk-or-second' }, as);
    const providers = (await r.store.table('providers').find({ limit: 10 })).items;
    expect(providers).toHaveLength(1);
    const config = providers[0]?.config;
    if (config?.provider !== 'openrouter') { throw new Error('expected an openrouter provider'); }
    await expect(r.api.secrets.reveal(config.apiKey)).resolves.toBe('sk-or-second');
    await expect(r.store.table('secrets').count()).resolves.toBe(1);
    await expect(web.client.call('providers', {}, as)).resolves.toEqual([{ id: providers[0]?.id, provider: 'openrouter', models: 2 }]);
    // each provider counts its own models
    await expect(web.client.call('configureProvider', { provider: 'openai', apiKey: 'sk-openai' }, as)).resolves.toEqual({ models: 1 });
    expect((await web.client.call('providers', {}, as)).map((p) => [p.provider, p.models]).sort()).toEqual([['openai', 1], ['openrouter', 2]]);
    expect(reloads).toBe(3);
  });

  it('adds users and groups, refusing duplicates and members that aren’t users', async () => {
    const { r, web, as } = await signedIn();
    const group = await web.client.call('addGroup', { name: 'Team', about: 'the team' }, as);
    const user = await web.client.call('addUser', { email: 'Ada@Example.com', name: 'Ada', role: 'member', groups: [group.id] }, as);
    await expect(r.store.table('memberships').get({ group: group.id, user: user.id })).resolves.toBeDefined();
    await expect(web.client.call('addUser', { email: 'ada@example.com', name: 'Ada 2', role: 'member' }, as)).rejects.toMatchObject({ status: 409 });
    await expect(web.client.call('addGroup', { name: 'Bad', about: '', members: [group.id] }, as)).rejects.toMatchObject({ status: 422 });
  });

  it('checks an actor setting against its declared type before storing it', async () => {
    const fsName = SystemName.parse('fs');
    const setting = QualifiedName.parse('fs/root');
    const { r, web, as, me } = await signedIn({
      catalog: {
        entries: entriesFrom({ settings: [{ name: setting, system: fsName, decl: { name: 'root', description: '', type: { name: 'text' }, appliesTo: ['user'], merge: 'user-wins', editableBy: [] } }] }),
        check: (_system, _type, value) => Promise.resolve(typeof value === 'string' ? [] : ['expected text']),
      },
    });
    await expect(web.client.call('setActorSetting', { setting, actor: me, value: 3 }, as)).rejects.toMatchObject({ status: 422, code: 'SETTING_INVALID' });
    await expect(web.client.call('setActorSetting', { setting, actor: me, value: '/home' }, as)).resolves.toEqual({ ok: true });
    await expect(r.store.table('actorSettings').get({ setting, actor: me })).resolves.toMatchObject({ value: '/home', setBy: me });
    await expect(web.client.call('setActorSetting', { setting: QualifiedName.parse('fs/none'), actor: me, value: 'x' }, as)).rejects.toMatchObject({ status: 404 });
  });

  it('records budgets, priorities and policies with who set them', async () => {
    const { r, web, as, me } = await signedIn();
    const budget = await web.client.call('setBudget', { target: { scope: 'hub' }, period: 'all-time', maxCost: 5, onLimit: 'refuse' }, as);
    await expect(r.store.table('budgets').get(budget.id)).resolves.toMatchObject({ maxCost: 5, setBy: me });
    const priority = await web.client.call('setPriority', { target: { scope: 'hub' }, default: 'normal' }, as);
    await expect(r.store.table('priorityRules').get(priority.id)).resolves.toMatchObject({ default: 'normal', setBy: me });
    const policy = await web.client.call('setPolicy', { description: 'read is fine', subject: { everyone: true }, target: { tags: ['read'] }, decision: { effect: 'allow' }, priority: 1 }, as);
    await expect(r.store.table('policies').get(policy.id)).resolves.toMatchObject({ createdBy: me, createdAt: r.now });
    const category = await web.client.call('setModelCategory', { name: 'fast', description: '', models: ['a'] }, as);
    const same = await web.client.call('setModelCategory', { name: 'fast', description: 'quick', models: ['b'] }, as);
    expect(same.id).toBe(category.id);
  });
});

describe('admin reads', () => {
  it('lists models, narrowed to a provider, even when the body is empty', async () => {
    const models: ModelInfo[] = [{ id: 'a', provider: 'openrouter', name: 'A', capabilities: ['chat'] }, { id: 'b', provider: 'openai', name: 'B', capabilities: [] }];
    const { r, web, as } = await signedIn({ execution: { llm: { models: () => Promise.resolve(models) } } });
    await expect(web.client.call('models', {}, as)).resolves.toEqual(models);
    const provider = mintId('provider');
    await r.store.table('providers').insert({ id: provider, config: { provider: 'openrouter', apiKey: mintId('secret') }, createdAt: 1 });
    await expect(web.client.call('models', { provider }, as)).resolves.toEqual([models[0]]);
    await expect(web.client.call('models', { provider: mintId('provider') }, as)).resolves.toEqual([]);
  });

  it('shows budgets with what they have spent, and removes rules by kind', async () => {
    const { r, web, as, me } = await signedIn({ execution: { ledger: { spent: () => Promise.resolve(1.5) } } });
    const { id } = await web.client.call('setBudget', { target: { scope: 'hub' }, period: 'all-time', maxCost: 10, onLimit: 'refuse' }, as);
    await expect(web.client.call('budgets', {}, as)).resolves.toEqual([expect.objectContaining({ id, maxCost: 10, spent: 1.5, setBy: me })]);
    await web.client.call('setBudget', { id: id, target: { scope: 'hub' }, period: 'all-time', maxCost: 20, onLimit: 'wait' }, as);
    await expect(r.store.table('budgets').count()).resolves.toBe(1);
    await expect(web.client.call('removeRule', { kind: 'budget', id: id }, as)).resolves.toEqual({ ok: true });
    await expect(web.client.call('removeRule', { kind: 'budget', id: id }, as)).resolves.toEqual({ ok: false });
  });

  it('pages runs and LLM calls newest first without their bodies, and filters by what is asked', async () => {
    const { r, web, as } = await signedIn();
    await r.store.table('runs').insert(runRow('run_a', { createdAt: 1, status: 'done' }));
    await r.store.table('runs').insert(runRow('run_b', { createdAt: 2, status: 'failed' }));
    expect((await web.client.call('runs', {}, as)).items.map((run) => run.id)).toEqual(['run_b', 'run_a']);
    expect((await web.client.call('runs', { query: { filters: [{ field: 'status', op: 'is', value: 'done' }] } }, as)).items.map((run) => run.id)).toEqual(['run_a']);
    expect((await web.client.call('llmCalls', {}, as)).items).toEqual([]);
  });

  it('answers every list by the query standard: on its own endpoint, through query, with values, and refuses a bad query', async () => {
    const { r, web, as } = await signedIn();
    await r.store.table('runs').insert(runRow('run_a', { createdAt: 1, status: 'done', cost: 0.5 }));
    await r.store.table('runs').insert(runRow('run_b', { createdAt: 2, status: 'failed', cost: 0.01 }));
    const query = { filters: [{ field: 'status', op: 'isNot' as const, value: 'failed' }] };
    expect((await web.client.call('runs', { query }, as)).items.map((run) => run.id)).toEqual(['run_a']);
    const found = await web.client.call('query', { list: 'runs', query: { sort: [{ field: 'cost', dir: 'asc' }] } }, as);
    expect(found).toMatchObject({ total: 2, sort: [{ field: 'cost', dir: 'asc' }], items: [{ id: 'run_b' }, { id: 'run_a' }] });
    await expect(web.client.call('listValues', { list: 'runs', field: 'status', prefix: 'do' }, as)).resolves.toEqual([{ value: 'done', count: 1 }]);
    await expect(web.client.call('query', { list: 'runs', query: { sort: [{ field: 'nope', dir: 'asc' }] } }, as)).rejects.toMatchObject({ status: 422 });
    expect((await web.client.call('fns', {}, as)).items).toBeInstanceOf(Array);
  });

  it('serves the review page\'s calls to admins, refusing a system or fn it doesn\'t know', async () => {
    const decided: string[] = [];
    const { web, as, me } = await signedIn({ link: { lifecycle: {
      review: () => Promise.resolve(undefined),
      goLive: (request, by) => { decided.push(`live ${request.hash} ${by}`); return Promise.resolve({ stage: 'live', hash: request.hash }); },
      approve: (request) => { decided.push(`approve ${request.hash}`); return Promise.resolve({ hash: request.hash }); },
      reject: (_system, hash) => { decided.push(`reject ${hash}`); return Promise.resolve({ ok: true }); },
      decide: (decision, by) => { decided.push(`decide ${decision.hash} +${decision.approve.length} -${decision.decline.length} ${by}`); return Promise.resolve({ hash: 'h0', waiting: 1 }); },
    } }, catalog: { fn: () => Promise.resolve(undefined), manifest: () => Promise.resolve(undefined), fns: () => Promise.resolve([]) } });
    const ghost = SystemName.parse('ghost');
    const status = (promise: Promise<unknown>) => promise.then(() => 'answered', (error: unknown) => (error instanceof ApiError ? error.status : 'thrown'));
    expect(await status(web.client.call('systemReview', { system: ghost }, as))).toBe(404);
    expect(await web.client.call('goLive', { system: ghost, hash: 'h1', off: [] }, as)).toEqual({ stage: 'live', hash: 'h1' });
    expect(await web.client.call('approveReview', { system: ghost, hash: 'h2', off: [] }, as)).toEqual({ hash: 'h2' });
    expect(await web.client.call('rejectReview', { system: ghost, hash: 'h3' }, as)).toEqual({ ok: true });
    expect(await web.client.call('decideReview', { system: ghost, hash: 'h4', approve: [{ section: 'fns', name: 'ghost/a' }], decline: [], off: [] }, as)).toEqual({ hash: 'h0', waiting: 1 });
    // nothing to decide is refused before the hub is asked
    expect(await status(web.client.call('decideReview', { system: ghost, hash: 'h5', approve: [], decline: [], off: [] }, as))).toBe(400);
    expect(decided).toEqual([`live h1 ${me}`, 'approve h2', 'reject h3', `decide h4 +1 -0 ${me}`]);
    expect(await status(web.client.call('testCall', { fn: QualifiedName.parse('ghost/nothing'), args: {} }, as))).toBe(404);
    expect(await web.client.call('refusals', { system: ghost }, as)).toMatchObject({ items: [] });
  });

  it('runs a test call as the admin in a turn of its own, and closes the turn as the run settles', async () => {
    const fns = new TestCatalog();
    const ping = fns.add('notes', 'ping', fn({ description: 'Ping.', args: g.obj({}), returns: g.text() }));
    const resolved: ResolvedLimits = { priority: 'normal', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 1_000 }, budgets: [] };
    const started: Array<{ fn: string; key: string; test?: boolean; turn: TurnId; on?: string }> = [];
    const outcomes = [
      () => Promise.resolve({ status: 'done' as const, result: 'pong' }),
      () => Promise.resolve({ status: 'failed' as const, error: { class: 'fatal' as const, message: 'no' } }),
      () => Promise.reject(new Error('lost')),
    ];
    const { r, web, as, me } = await signedIn({
      catalog: { fn: (name) => Promise.resolve(name === ping.name ? ping : undefined) },
      execution: {
        limits: { resolve: () => Promise.resolve(resolved) },
        runs: { start: (input) => {
          started.push({ fn: input.fn, key: input.key, turn: input.turn, ...(input.test === undefined ? {} : { test: input.test }), ...(input.on === undefined ? {} : { on: input.on }) });
          const outcome = outcomes[started.length - 1];
          if (outcome === undefined) { throw new Error('one test call too many'); }
          return Promise.resolve({ run: RunId.parse(`run_${String(started.length)}`), settled: outcome() });
        } },
      },
    });
    const done = await web.client.call('testCall', { fn: ping.name, args: {} }, as);
    const failed = await web.client.call('testCall', { fn: ping.name, args: {}, instance: MAIN_INSTANCE }, as);
    await web.client.call('testCall', { fn: ping.name, args: {} }, as);
    await settle();
    expect(started.map((s) => ({ fn: s.fn, key: s.key, test: s.test, on: s.on }))).toEqual([
      { fn: 'notes/ping', key: 'test:notes/ping', test: true, on: undefined },
      { fn: 'notes/ping', key: 'test:notes/ping', test: true, on: MAIN_INSTANCE },
      { fn: 'notes/ping', key: 'test:notes/ping', test: true, on: undefined },
    ]);
    const [first, second, third] = await Promise.all(started.map((s) => r.store.table('turns').get(s.turn)));
    expect(first).toMatchObject({ actor: me, root: done.run, status: 'done', limits: resolved, endedAt: r.now });
    expect(second).toMatchObject({ root: failed.run, status: 'failed', endedAt: r.now });
    // a run that never settles leaves its turn running, and the hub logs why
    expect(third).toMatchObject({ status: 'running' });
    expect(r.records.some((record) => record.msg === 'review.test-call-failed')).toBe(true);
  });

  it('refuses a test call from anyone but a person', async () => {
    const fns = new TestCatalog();
    const ping = fns.add('notes', 'ping', fn({ description: 'Ping.', args: g.obj({}), returns: g.text() }));
    const r = await rig({ catalog: { fn: () => Promise.resolve(ping) } });
    const group = mintId('actor');
    await r.store.table('actors').insert({ id: group, kind: 'group', name: 'Team', about: '', createdAt: 1, disabled: false });
    await expect(testCall(r.hub, { fn: ping.name, args: {} }, group)).rejects.toMatchObject({ status: 403, code: 'NOT_A_PERSON' });
  });

  it('draws the graph of the systems the signed-in person sees', async () => {
    const notes = SystemName.parse('notes');
    const { r, web, as } = await signedIn({ catalog: { manifest: (system) => Promise.resolve(system === notes ? testManifest(notes) : undefined) } });
    await r.store.table('systems').insert(systemRow('notes'));
    await r.store.table('systems').insert(systemRow('gone', { status: 'removed' }));
    const page = await web.client.call('graph', {}, as);
    expect(page.nodes.map((node) => node.system)).toEqual(['notes']);
    expect(page.edges).toEqual([]);
    // the endpoint takes the query standard's filters, and refuses one the graph list doesn't have (422)
    const systems = await web.client.call('graph', { filters: [{ field: 'nodeKind', op: 'is', value: 'system' }] }, as);
    expect(systems.nodes.map((node) => node.id)).toEqual(['system:notes']);
    await expect(web.client.call('graph', { filters: [{ field: 'cost', op: 'gt', value: 1 }] }, as)).rejects.toMatchObject({ status: 422 });
  });

  it('shows a system\'s output and its fns', async () => {
    const lines = [{ at: 1, stream: 'stdout' as const, text: 'info fs.ready' }];
    const { web, as } = await signedIn({
      link: { output: { tail: (_system, limit) => lines.slice(0, limit) } },
      catalog: { fns: () => Promise.resolve([]) },
    });
    await expect(web.client.call('systemLogs', { system: SystemName.parse('fs') }, as)).resolves.toEqual(lines);
    await expect(web.client.call('systemFns', { system: SystemName.parse('fs') }, as)).resolves.toEqual([]);
  });

  it('lists model categories, priority rules and policies as they were set', async () => {
    const { web, as, me } = await signedIn();
    const category = await web.client.call('setModelCategory', { name: 'fast', description: 'quick', models: ['a', 'b'] }, as);
    const priority = await web.client.call('setPriority', { target: { scope: 'hub' }, default: 'normal', max: 'interactive' }, as);
    const policy = await web.client.call('setPolicy', { description: 'read is fine', subject: { everyone: true }, target: { tags: ['read'] }, decision: { effect: 'allow' }, priority: 1 }, as);
    await expect(web.client.call('modelCategories', {}, as)).resolves.toEqual([{ id: category.id, name: 'fast', description: 'quick', models: ['a', 'b'] }]);
    await expect(web.client.call('priorityRules', {}, as)).resolves.toEqual([{ id: priority.id, target: { scope: 'hub' }, default: 'normal', max: 'interactive', setBy: me }]);
    await expect(web.client.call('policies', {}, as)).resolves.toEqual([expect.objectContaining({ id: policy.id, description: 'read is fine', priority: 1, createdBy: me })]);
  });

  it('resolves the limits a user would get, and refuses a group or an unknown actor', async () => {
    const resolved: ResolvedLimits = { priority: 'normal', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 1_000 }, budgets: [] };
    const asked: Array<{ user: ActorId; groups: ActorId[]; session?: SessionId }> = [];
    const { r, web, as, me } = await signedIn({
      execution: { limits: { resolve: (input) => {
        asked.push({ user: input.user.id, groups: input.user.groups.map((g) => g.id), ...(input.session === undefined ? {} : { session: input.session }) });
        return Promise.resolve(resolved);
      } } },
    });
    const group = mintId('actor');
    await r.store.table('actors').insert({ id: group, kind: 'group', name: 'Team', about: '', createdAt: 1, disabled: false });
    await r.store.table('memberships').insert({ group, user: me, addedBy: me, addedAt: 1 });
    await expect(web.client.call('resolveLimits', { user: me }, as)).resolves.toEqual(resolved);
    await expect(web.client.call('resolveLimits', { user: me, session: sessionId }, as)).resolves.toEqual(resolved);
    expect(asked).toEqual([{ user: me, groups: [group] }, { user: me, groups: [group], session: sessionId }]);
    await expect(web.client.call('resolveLimits', { user: group }, as)).rejects.toMatchObject({ status: 404, code: 'USER_NOT_FOUND' });
    await expect(web.client.call('resolveLimits', { user: mintId('actor') }, as)).rejects.toMatchObject({ status: 404, code: 'USER_NOT_FOUND' });
    expect(asked).toHaveLength(2);
  });

  it('lists actors, narrowed to a kind, and the declared settings with their values', async () => {
    const setting = QualifiedName.parse('fs/home');
    const decl: SettingDecl = { name: 'home', description: 'Home folder.', type: { name: 'text' }, appliesTo: ['user'], merge: 'user-wins', editableBy: [] };
    const { r, web, as, me } = await signedIn({ catalog: { entries: entriesFrom({ settings: [{ name: setting, system: SystemName.parse('fs'), decl }] }) } });
    const group = mintId('actor');
    await r.store.table('actors').insert({ id: group, kind: 'group', name: 'Team', about: '', createdAt: 1, disabled: false });
    const ids = async (kind?: ActorKind): Promise<string[]> => (await web.client.call('actors', kind === undefined ? {} : { kind }, as)).map((a) => a.id).sort();
    expect(await ids()).toEqual([me, group].sort());
    expect(await ids('group')).toEqual([group]);
    expect(await ids('user')).toEqual([me]);
    expect(await ids('system')).toEqual([]);
    await r.store.table('actorSettings').put({ setting, actor: me, value: '/home', setBy: me, updatedAt: 1 });
    await expect(web.client.call('actorSettings', {}, as)).resolves.toEqual({
      declared: [{ setting, system: 'fs', decl }],
      values: [{ setting, actor: me, value: '/home', setBy: me, updatedAt: 1 }],
    });
  });

  it('pages resources newest first', async () => {
    const { r, web, as } = await signedIn();
    const fs = SystemName.parse('fs');
    // 250 resources over three store pages; the newest is the highest number
    for (let n = 0; n < 250; n++) {
      const uri = ResourceUri.parse(`fs://files/${n % 10 === 0 ? 'match' : 'other'}-${n}.md`);
      await r.store.table('resources').insert({ uri, system: fs, stat: { uri, name: `${n}.md`, type: 'file', version: 'v1' }, links: [], seenAt: n });
    }
    const first = await web.client.call('resources', { limit: 3 }, as);
    expect(first.items.map((item) => item.seenAt)).toEqual([249, 248, 247]);
    const next = await web.client.call('resources', { limit: 3, ...(first.cursor === undefined ? {} : { cursor: first.cursor }) }, as);
    expect(next.items.map((item) => item.seenAt)).toEqual([246, 245, 244]);
    const matching = await web.client.call('resources', { query: { text: 'match-24', limit: 5 } }, as);
    expect(matching.items.map((item) => item.seenAt)).toEqual([240]);
  });

  it('refuses members', async () => {
    const { r, web } = await signedIn();
    const tokens = await member(r, web);
    await expect(web.client.call('budgets', {}, web.as(tokens))).rejects.toMatchObject({ status: 403 });
  });
});
