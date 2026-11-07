/**
 * The web API end to end in one process: the real plugins, sign-in, middleware and store, with fakes for the modules
 * the handlers hand work to. Each test checks what reaches those modules and what the browser gets back.
 */
import { ApiError, manifestFromSpec } from '@ayepi/core';
import { describe, expect, it } from 'vitest';
import {
  ActorId, compositeKey, hubWebSpec, mintId, NotificationId, QualifiedName, RunId, SessionId, SystemName, TurnId, type Run, type Session, type SystemRecord, type Tokens,
} from '@harness/core';
import { ScryptHasher } from '../hash.ts';
import { entriesFrom, rig, settle, webRig, type Fakes } from '../testing/rig.ts';

const sessionId = SessionId.parse('ses_1');
const client = { timeZone: 'Europe/Paris', locale: 'fr', now: 1 };

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
    name: SystemName.parse(name), description: `${name} system`, status: 'connected', enabled: { functions: true, renderers: true }, keyFingerprint: 'fp',
    publicKey: 'secret-key-material', version: '1.0.0', manifestHash: 'h', actor: ActorId.parse(`act_${name}`), ...fields,
  };
}

/** A rig with the web API installed and an admin signed in. */
async function signedIn(fakes: Fakes = {}) {
  const r = await rig(fakes);
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

  it('says why a sign-in failed, and slows down repeated tries', async () => {
    const r = await rig();
    const web = await webRig(r);
    await web.admin();
    const wrong = { email: 'admin@example.com', password: 'nope' };
    const error: unknown = await web.client.call('signIn', wrong).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, data: { reason: 'That email and password don’t match.' } });
    for (let i = 1; i < r.hub.settings.authEnv.HARNESS_SIGN_IN_LIMIT; i++) { await web.client.call('signIn', wrong).catch(() => undefined); }
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
    const { r, web, as } = await signedIn({
      chat: { sessions: { get: (_id, viewer) => Promise.resolve(session(viewer, { systems: [fs, off] })) } },
      catalog: {
        entries: entriesFrom({
          mentions: [
            { name: QualifiedName.parse('fs/file'), system: fs, decl: { name: 'file', title: 'Files', description: '', target: { name: 'text' } } },
            { name: QualifiedName.parse('off/x'), system: off, decl: { name: 'x', title: 'X', description: '', target: { name: 'text' } } },
          ],
        }),
        fns: () => Promise.resolve([]),
        manifest: () => Promise.resolve(undefined),
      },
      execution: { llm: { models: () => Promise.resolve([{ id: 'openrouter/auto', name: 'Auto' }]) } },
    });
    await r.store.table('systems').insert(systemRow('fs'));
    await r.store.table('systems').insert(systemRow('off', { enabled: { functions: false, renderers: true } }));
    const caps = await web.client.call('capabilities', { session: sessionId }, as);
    expect(caps.mentions).toEqual([{ provider: 'fs/file', title: 'Files' }]);
    expect(caps.systems).toEqual([{ name: fs, status: 'connected', enabled: true }, { name: off, status: 'connected', enabled: false }]);
    expect(caps.models).toEqual([{ id: 'openrouter/auto', name: 'Auto' }]);
    expect(caps).toMatchObject({ voiceInput: false, uploads: true, commands: [], invocations: [], clients: [] });
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
      chat: { sessions: { get: (id, viewer) => Promise.resolve(id === sessionId ? session(viewer) : undefined) }, state: { forRun: () => Promise.resolve({ open: true }) } },
      execution: {
        runs: {
          get: (id) => Promise.resolve(id === RunId.parse('run_1') ? runRow('run_1') : undefined),
          background: (id) => { backgrounded.push(id); return Promise.resolve(true); },
        },
      },
    });
    const mem = await member(r, web);
    await expect(web.client.call('background', { run: RunId.parse('run_1') }, as)).resolves.toEqual({ accepted: true });
    await expect(web.client.call('state', { run: RunId.parse('run_1') }, as)).resolves.toEqual({ values: { open: true } });
    await expect(web.client.call('background', { run: RunId.parse('run_2') }, as)).rejects.toMatchObject({ status: 404 });
    expect(backgrounded).toEqual(['run_1']);
    // A member who isn't in the session doesn't see its runs (admins see everything).
    r.hub.chat.sessions.get = () => Promise.resolve(undefined);
    await expect(web.client.call('state', { run: RunId.parse('run_1') }, web.as(mem))).rejects.toMatchObject({ status: 404 });
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
  });

  it('presigns uploads and has no transcription yet', async () => {
    const { web, as } = await signedIn();
    const presigned = await web.client.call('upload', { name: 'a.png', mime: 'image/png', size: 3 }, as);
    expect(presigned.url).toContain('/_files');
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
    expect(systems[0]).toMatchObject({ name: 'fs', fns: 0, needsConfig: true });
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
          approve: (pairing) => { calls.push(`approve ${pairing}`); return Promise.resolve(systemRow('fs')); },
          reject: (pairing) => { calls.push(`reject ${pairing}`); return Promise.resolve(); },
        },
      },
    });
    const pairing = mintId('pairing');
    await expect(web.client.call('approvePairing', { pairing, approve: true }, as)).resolves.toEqual({ system: 'fs' });
    await expect(web.client.call('approvePairing', { pairing, approve: false }, as)).resolves.toEqual({});
    expect(calls).toEqual([`approve ${pairing}`, `reject ${pairing}`]);
  });

  it('stores provider keys sealed and replaces a provider’s old key', async () => {
    const { r, web, as } = await signedIn({ execution: { llm: { models: () => Promise.resolve([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]) } } });
    await expect(web.client.call('configureProvider', { provider: 'openrouter', apiKey: 'sk-or-first' }, as)).resolves.toEqual({ models: 2 });
    await web.client.call('configureProvider', { provider: 'openrouter', apiKey: 'sk-or-second' }, as);
    const providers = (await r.store.table('providers').find({ limit: 10 })).items;
    expect(providers).toHaveLength(1);
    const config = providers[0]?.config;
    if (config?.provider !== 'openrouter') { throw new Error('expected an openrouter provider'); }
    await expect(r.api.secrets.reveal(config.apiKey)).resolves.toBe('sk-or-second');
    await expect(r.store.table('secrets').count()).resolves.toBe(1);
    await expect(web.client.call('providers', {}, as)).resolves.toEqual([{ id: providers[0]?.id, provider: 'openrouter', models: 2 }]);
  });

  it('adds users and groups, refusing duplicates and members that aren’t users', async () => {
    const { r, web, as } = await signedIn();
    const group = await web.client.call('addGroup', { name: 'Team', about: 'the team' }, as);
    const user = await web.client.call('addUser', { email: 'Ada@Example.com', name: 'Ada', role: 'member', groups: [group.id] }, as);
    await expect(r.store.table('memberships').get(compositeKey(group.id, user.id))).resolves.toBeDefined();
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
    await expect(r.store.table('actorSettings').get(compositeKey(setting, me))).resolves.toMatchObject({ value: '/home', setBy: me });
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
