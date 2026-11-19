/**
 * Every pass-through handler of the web API: each reaches the right module method with the person filled in, after
 * checking they may see what they ask about, and returns what the module answers.
 */
import { describe, expect, it } from 'vitest';
import {
  ActorId, ApprovalId, HandlerCallId, MAIN_INSTANCE, mintId, QualifiedName, RunId, SessionId, SystemName, TurnId, type Approval, type ChatMessage, type HandlerCall, type Run,
  type SearchHit, type Session,
} from '@harness/core';
import { openScope } from '../../access/index.ts';
import { rig, webRig, type Fakes } from '../testing/rig.ts';

const sessionId = SessionId.parse('ses_1');
const runId = RunId.parse('run_1');
const fs = SystemName.parse('fs');
const client = { timeZone: 'UTC', locale: 'en', now: 1 };

const session = (owner: ActorId): Session => ({
  id: sessionId, title: 'Plans', owner, agent: QualifiedName.parse('hub/chat'), participants: [], systems: 'all', tools: [], context: [], status: 'idle',
  transcript: [], createdAt: 1, updatedAt: 1, archived: false,
});

const run = (fields: Partial<Run> = {}): Run => ({
  id: runId, fn: QualifiedName.parse('fs/read'), fnVersion: 'v1', kind: 'native', system: fs, root: runId, turn: TurnId.parse('trn_1'), session: sessionId, key: 'k',
  actor: ActorId.parse('act_x'), caller: ActorId.parse('act_x'), args: {}, status: 'done', allowed: { cancel: true, pause: false, background: true }, cost: 0,
  totalCost: 0, priority: 'interactive', background: false, attempt: 1, errors: [], stateChanges: [], createdAt: 1, ...fields,
});

/** A rig with these fakes, where session `ses_1` and run `run_1` are visible, and an admin signed in. */
async function recorded(fakes: Fakes) {
  const r = await rig({
    ...fakes,
    chat: {
      ...fakes.chat,
      sessions: { get: (id, viewer) => Promise.resolve(id === sessionId ? session(viewer) : undefined), ...fakes.chat?.sessions },
    },
    execution: { ...fakes.execution, runs: { get: (id) => Promise.resolve(id === runId ? run() : undefined), ...fakes.execution?.runs } },
  });
  const web = await webRig(r);
  const tokens = await web.admin();
  return { r, web, as: web.as(tokens), me: tokens.user.id };
}

const message = (author: ActorId): ChatMessage => ({
  id: mintId('message'), session: sessionId, turn: TurnId.parse('trn_1'), author, role: 'user', parts: [], runs: [], status: 'done', replyAll: false, answerers: [], createdAt: 1,
});

describe('chat handlers', () => {
  it('list, update, page, invoke, control and presence go to the chat module as the person', async () => {
    const calls: unknown[][] = [];
    const push = (name: string, ...args: unknown[]) => { calls.push([name, ...args]); };
    const { web, as, me } = await recorded({
      chat: {
        sessions: {
          list: (viewer, query) => { push('list', viewer, query); return Promise.resolve({ items: [] }); },
          update: (id, patch, by) => { push('update', id, patch, by); return Promise.resolve(session(by)); },
          messages: (id, viewer, query) => { push('messages', id, viewer, query); return Promise.resolve({ items: [message(viewer)], cursor: 'next' }); },
          control: (id, action, by) => { push('control', id, action, by); return Promise.resolve({ pause: false, cancel: true, uncancellable: [], undoLastTurn: true }); },
          controls: (id) => { push('controls', id); return Promise.resolve({ pause: false, cancel: false, uncancellable: [], undoLastTurn: true, continueLastTurn: true }); },
          presence: (presence) => { push('presence', presence); return Promise.resolve(); },
        },
        turns: { invoke: (input) => { push('invoke', input); return Promise.resolve({ turn: TurnId.parse('trn_2'), run: runId }); } },
      },
    });
    await web.client.call('sessions', { limit: 5 }, as);
    await web.client.call('updateSession', { session: sessionId, title: 'New', archived: true }, as);
    await expect(web.client.call('messages', { session: sessionId, limit: 10 }, as)).resolves.toMatchObject({ cursor: 'next' });
    await web.client.call('invoke', { session: sessionId, fn: QualifiedName.parse('fs/read'), args: { path: 'a' }, client }, as);
    await web.client.call('control', { session: sessionId, action: 'cancel' }, as);
    await expect(web.client.call('controls', { session: sessionId }, as)).resolves.toMatchObject({ continueLastTurn: true });
    await web.client.call('presence', { session: sessionId, focused: true, typing: false }, as);
    expect(calls).toEqual([
      ['list', me, { limit: 5 }],
      ['update', sessionId, { title: 'New', archived: true }, me],
      ['messages', sessionId, me, { limit: 10 }],
      ['invoke', { session: sessionId, fn: 'fs/read', args: { path: 'a' }, client, author: me }],
      ['control', sessionId, 'cancel', me],
      ['controls', sessionId],
      ['presence', { session: sessionId, focused: true, typing: false, user: me }],
    ]);
  });
});

describe('runs handlers', () => {
  it('undo, inspect, approve, act and submit go to their modules after the checks', async () => {
    const calls: unknown[][] = [];
    const push = (name: string, ...args: unknown[]) => { calls.push([name, ...args]); };
    const { r, web, as, me } = await recorded({
      chat: {
        undo: { undoTurn: (turn, by) => { push('undo', turn, by); return Promise.resolve({ turn, undone: [], failed: [], notUndoable: [] }); } },
        turns: { continueTurn: (turn, by) => { push('continue', turn, by); return Promise.resolve({ turn, run: runId }); } },
        deliveries: {
          act: (input) => { push('act', input); return Promise.resolve(mintId('delivery')); },
          submit: (input) => { push('submit', input); return Promise.resolve(mintId('delivery')); },
        },
      },
      execution: {
        policies: {
          answer: (approval, input) => {
            push('approve', approval, input);
            return Promise.resolve({ id: approval, run: runId, fn: QualifiedName.parse('fs/read'), approver: { by: 'turn-user' }, status: 'approved', decisions: [], createdAt: 1 });
          },
        },
      },
    });
    const turn = TurnId.parse('trn_1');
    await r.store.table('turns').insert({
      id: turn, session: sessionId, actor: me, user: { id: me, name: 'A', email: 'a', role: 'admin', groups: [], timeZone: 'UTC', locale: 'en' },
      time: { now: 1, timeZone: 'UTC', local: 'x' }, status: 'done', limits: { priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 1 }, budgets: [] },
      cost: 0, errors: 'feed-back', createdAt: 1,
    });
    const call = mintId('llmInteraction');
    await r.store.table('llmInteractions').insert({
      id: call, turn, run: runId, iteration: 0, provider: 'openrouter', model: 'm', request: { messages: [] }, cost: 0, status: 'done', priority: 'interactive', queuedAt: 1,
    });
    await web.client.call('undoTurn', { turn }, as);
    await expect(web.client.call('continueTurn', { turn }, as)).resolves.toEqual({ turn, run: runId });
    await expect(web.client.call('continueTurn', { turn: TurnId.parse('trn_none') }, as)).rejects.toMatchObject({ status: 404 });
    await expect(web.client.call('run', { run: runId }, as)).resolves.toMatchObject({ id: runId });
    await expect(web.client.call('llmCall', { id: call }, as)).resolves.toMatchObject({ model: 'm' });
    await expect(web.client.call('llmCall', { id: mintId('llmInteraction') }, as)).rejects.toMatchObject({ status: 404 });
    const approval = ApprovalId.parse('apr_1');
    await r.store.table('approvals').insert({ id: approval, run: runId, fn: QualifiedName.parse('fs/read'), approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: 1 });
    await web.client.call('approve', { approval, approve: true, remember: 'session', reason: 'fine' }, as);
    await web.client.call('act', { session: sessionId, system: fs, action: 'open', input: { path: 'a' }, client }, as);
    await web.client.call('submit', { run: runId, value: { name: 'x' } }, as);
    expect(calls).toEqual([
      ['undo', turn, me],
      ['continue', turn, me],
      ['approve', approval, { approve: true, remember: 'session', reason: 'fine', by: me }],
      ['act', { session: sessionId, system: 'fs', action: 'open', input: { path: 'a' }, client, actor: me }],
      ['submit', { run: runId, value: { name: 'x' }, actor: me }],
    ]);
  });
});

describe('approvals and handler answers', () => {
  const approvalRow = (fields: Partial<Approval> = {}): Approval => ({
    id: ApprovalId.parse('apr_1'), run: runId, fn: QualifiedName.parse('fs/read'), approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: 1, ...fields,
  });
  const callRow = (answerer: HandlerCall['answerer'], fields: Partial<HandlerCall> = {}): HandlerCall => ({
    id: HandlerCallId.parse('hcl_1'), run: runId, handler: 'confirm', args: {}, decl: { description: 'Sure?', args: { name: 'object' }, returns: { name: 'boolean' } },
    answerer, status: 'pending', createdAt: 1, ...fields,
  });

  it('answers 404 for an approval that is missing or on a run the person may not see, and 409 once it is settled', async () => {
    const answered: unknown[] = [];
    const { r, web, as } = await recorded({
      execution: { policies: { answer: (approval) => { answered.push(approval); return Promise.resolve(approvalRow({ status: 'approved' })); } } },
    });
    const ask = (approval: ApprovalId) => web.client.call('approve', { approval, approve: true, remember: 'once' }, as);
    await expect(ask(ApprovalId.parse('apr_none'))).rejects.toMatchObject({ status: 404, code: 'APPROVAL_NOT_FOUND' });
    await r.store.table('approvals').insert(approvalRow({ id: ApprovalId.parse('apr_hidden'), run: RunId.parse('run_hidden') }));
    await expect(ask(ApprovalId.parse('apr_hidden'))).rejects.toMatchObject({ status: 404, code: 'RUN_NOT_FOUND' });
    await r.store.table('approvals').insert(approvalRow({ id: ApprovalId.parse('apr_done'), status: 'denied' }));
    await expect(ask(ApprovalId.parse('apr_done'))).rejects.toMatchObject({ status: 409, code: 'APPROVAL_SETTLED' });
    expect(answered).toEqual([]);
  });

  it('only lets the person a handler call asked answer it, once', async () => {
    const answered: unknown[] = [];
    const { r, web, as, me } = await recorded({
      execution: { handlers: { answer: (call, value, by) => { answered.push({ call, value, by }); return Promise.resolve(); } } },
    });
    const answer = (call: string) => web.client.call('answer', { call: HandlerCallId.parse(call), value: true }, as);
    await expect(answer('hcl_none')).rejects.toMatchObject({ status: 404, code: 'HANDLER_CALL_NOT_FOUND' });
    await r.store.table('handlerCalls').insert(callRow({ user: ActorId.parse('act_someone') }, { id: HandlerCallId.parse('hcl_other') }));
    await expect(answer('hcl_other')).rejects.toMatchObject({ status: 404, code: 'HANDLER_CALL_NOT_FOUND' });
    await r.store.table('handlerCalls').insert(callRow({ system: fs, run: runId }, { id: HandlerCallId.parse('hcl_system') }));
    await expect(answer('hcl_system')).rejects.toMatchObject({ status: 404, code: 'HANDLER_CALL_NOT_FOUND' });
    await r.store.table('handlerCalls').insert(callRow({ user: me }, { id: HandlerCallId.parse('hcl_done'), status: 'answered' }));
    await expect(answer('hcl_done')).rejects.toMatchObject({ status: 409, code: 'HANDLER_CALL_SETTLED' });
    await r.store.table('handlerCalls').insert(callRow({ user: me }));
    await answer('hcl_1');
    expect(answered).toEqual([{ call: 'hcl_1', value: true, by: me }]);
  });
});

describe('finding handlers', () => {
  it('suggest, mentions, hover and resource reach the index, chat and link modules', async () => {
    const calls: unknown[][] = [];
    const push = (name: string, ...args: unknown[]) => { calls.push([name, ...args]); };
    const { r, web, as, me } = await recorded({
      index: {
        suggest: { consider: (input) => { push('suggest', input); return Promise.resolve({ offered: [{ kind: 'fn', name: QualifiedName.parse('fs/read'), description: 'Read', score: 0.9 }], hidden: [] }); } },
        search: { search: (query) => { push('search', query); return Promise.resolve([]); } },
      },
      chat: {
        mentions: {
          search: (request, query) => { push('mentions', request, query); return Promise.resolve([{ label: 'a.txt', target: 'a.txt' }]); },
          hover: (request, target) => { push('hover', request, target); return Promise.resolve(undefined); },
        },
      },
      link: {
        resources: {
          read: (uri, want) => {
            push('read', uri, want);
            return Promise.resolve({ stat: { uri, name: 'a', type: 'file', version: '1' }, text: { inline: 'hi' } });
          },
        },
      },
    });
    await expect(web.client.call('suggest', { session: sessionId, text: '   ' }, as)).resolves.toEqual([]);
    await expect(web.client.call('suggest', { session: sessionId, text: 'read a file' }, as)).resolves.toHaveLength(1);
    const provider = QualifiedName.parse('fs/file');
    await expect(web.client.call('mentions', { session: sessionId, provider, query: 'a' }, as)).resolves.toEqual([{ label: 'a.txt', target: 'a.txt' }]);
    await expect(web.client.call('mentionHover', { session: sessionId, provider, target: 'a.txt' }, as)).resolves.toEqual({});
    await expect(web.client.call('resource', { uri: 'fs://root/a', want: ['text'] }, as)).resolves.toMatchObject({ text: { inline: 'hi' } });
    expect(calls).toEqual([
      ['suggest', { session: sessionId, text: 'read a file', pool: r.hub.settings.modelEnv.HARNESS_SUGGESTIONS * 2 }],
      ['mentions', { session: sessionId, actor: me, provider }, 'a'],
      ['hover', { session: sessionId, actor: me, provider }, 'a.txt'],
      ['read', 'fs://root/a', ['text']],
    ]);
  });
});

describe('finding as a member', () => {
  it('leaves out what the person may not see and reads a hidden resource as missing', async () => {
    const secret = QualifiedName.parse('fs/secret');
    const read = QualifiedName.parse('fs/read');
    const hits: SearchHit[] = [
      { kind: 'fn', key: 'fs/read', score: 0.9, text: 'read' }, { kind: 'fn', key: secret, score: 1, text: 'secret' },
      { kind: 'section', key: 'fs://private/crawl.md#Top', score: 1, text: 'private' }, { kind: 'message', key: 'msg_1', score: 1, text: 'hi' },
    ];
    let reads = 0;
    const { web, as } = await recorded({
      access: { scope: (actor) => Promise.resolve({ ...openScope(actor), admin: false, seesFn: (fn) => fn.name !== secret, mayUse: (fn) => fn.name !== secret, seesUri: (uri) => !uri.startsWith('fs://private/') }) },
      index: {
        suggest: { consider: () => Promise.resolve({ offered: [secret, read].map((name) => ({ kind: 'fn' as const, name, description: name, score: 0.9 })), hidden: [] }) },
        search: { search: async (query) => { const kept: SearchHit[] = []; for (const hit of hits) { if (await query.keep?.(hit) ?? true) { kept.push(hit); } } return kept; } },
      },
      link: { resources: { read: (uri) => { reads += 1; return Promise.resolve({ stat: { uri, name: 'a', type: 'file', version: '1' } }); } } },
    });
    expect((await web.client.call('suggest', { session: sessionId, text: 'x' }, as)).map((s) => s.name)).toEqual([read]);
    await expect(web.client.call('resource', { uri: 'fs://private/crawl.md', want: ['text'] }, as)).rejects.toMatchObject({ status: 404 });
    expect(reads).toBe(0);
  });
});

describe('system handlers', () => {
  it('pairing, config, install, start, stop, upgrade, remove and reimport reach the link module', async () => {
    const calls: unknown[][] = [];
    const push = (name: string, ...args: unknown[]) => { calls.push([name, ...args]); };
    const { r, web, as, me } = await recorded({
      link: {
        pairing: { createToken: (input) => { push('token', input); return Promise.resolve({ token: 't', expiresAt: 9 }); } },
        config: { set: (system, value, by) => { push('config', system, value, by); return Promise.resolve({ problems: ['root is required'] }); } },
        supervisor: {
          install: (input) => {
            push('install', input);
            return Promise.resolve({
              name: fs, instance: MAIN_INSTANCE, source: { path: '/x' }, dir: '/d', command: { run: 'node', args: [], env: {} }, version: '1', autoStart: true,
              restart: { policy: 'on-failure', backoff: 1, maxPerHour: 1 }, status: 'stopped', installedBy: me, installedAt: 1,
            });
          },
          start: (system) => { push('start', system); return Promise.resolve(); },
          stop: (system, reason) => { push('stop', system, reason); return Promise.resolve(); },
          upgrade: (system, version) => { push('upgrade', system, version); return Promise.resolve({ from: '1', to: '2' }); },
        },
        admin: {
          remove: (system, by) => { push('remove', system, by); return Promise.resolve({ fnsUnavailable: 3 }); },
          reimport: (system) => { push('reimport', system); return Promise.resolve({ added: [], updated: [], removed: [], refused: [] }); },
        },
      },
    });
    await r.store.table('systems').insert({
      name: fs, description: '', status: 'connected', enabled: { functions: true, renderers: true }, version: '1', manifestHash: 'h',
      actor: ActorId.parse('act_fs'),
    });
    await r.store.table('pairings').insert({
      id: mintId('pairing'), name: fs, keyFingerprint: 'f', publicKey: 'k', version: '1', address: 'a', method: 'code', status: 'pending', createdAt: 1, expiresAt: 2,
    });
    await expect(web.client.call('pairings', { status: 'pending' }, as)).resolves.toHaveLength(1);
    await expect(web.client.call('pairings', { status: 'approved' }, as)).resolves.toHaveLength(0);
    await web.client.call('createPairingToken', { expiresIn: 60_000 }, as);
    await expect(web.client.call('configureSystem', { system: fs, config: {} }, as)).resolves.toEqual({ problems: ['root is required'] });
    await expect(web.client.call('installSystem', { source: { path: '/x' }, autoStart: true }, as)).resolves.toEqual({ name: 'fs' });
    await web.client.call('startSystem', { system: fs }, as);
    await web.client.call('stopSystem', { system: fs }, as);
    await expect(web.client.call('upgradeSystem', { system: fs }, as)).resolves.toEqual({ from: '1', to: '2' });
    await expect(web.client.call('removeSystem', { system: fs }, as)).resolves.toEqual({ fnsUnavailable: 3 });
    await web.client.call('reimport', { system: fs }, as);
    await expect(web.client.call('configureSystem', { system: SystemName.parse('nope'), config: {} }, as)).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual([
      ['token', { expiresIn: 60_000, by: me }],
      ['config', fs, {}, me],
      ['install', { source: { path: '/x' }, autoStart: true, by: me }],
      ['start', fs],
      ['stop', fs, 'shutdown'],
      ['upgrade', fs, undefined],
      ['remove', fs, me],
      ['reimport', fs],
    ]);
  });
});

describe('content handlers', () => {
  it('finishes an upload into a content ref', async () => {
    const { r, web, as } = await recorded({});
    const presigned = await web.client.call('upload', { name: 'a.txt', mime: 'text/plain', size: 2 }, as);
    await r.files.put(`uploads/${presigned.upload}`, 'hi');
    await expect(web.client.call('uploaded', { upload: presigned.upload }, as)).resolves.toMatchObject({ size: 2, mime: 'text/plain' });
  });
});
