import { ApiError } from '@ayepi/core/client';
import { ActorId, BudgetId, QualifiedName, LlmInteractionId, PairingId, PolicyId, ResourceUri, RunId, SessionId, SystemName, TurnId, type ListQuery } from '@harness/core';
import { flushPromises } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { fakeCaller } from '../../test/fakes.ts';
import { Loaded, Paged, Task } from '../../state/loaded.ts';
import { withPage } from '../../state/query.ts';
import { modelCallsBody } from './browsers.ts';
import { RESTART_REASON } from './system.ts';
import { budget, fakeAdmin, fakeAdminApi, installed, logLine, pairing, settingView, systemView, T0 } from '../test/fakes.ts';

const fs = SystemName.parse('fs');
const failure = new ApiError(500, 'boom', undefined);

describe('Loaded, Task and Paged', () => {
  it('keeps the newest load and turns failures into a sentence', async () => {
    const loaded = new Loaded<number>();
    let release: (value: number) => void = () => undefined;
    const slow = loaded.load(() => new Promise<number>((resolve) => { release = resolve; }), 'no');
    await loaded.load(() => Promise.resolve(2), 'no');
    release(1);
    await slow;
    expect(loaded.value.value).toBe(2);
    await loaded.load(() => Promise.reject(failure), "Couldn't.");
    expect(loaded.problem.value).toBe('The hub had a problem. Try again in a moment.');
    expect(loaded.value.value).toBe(2);
  });

  it('is busy while a task runs and says why it failed', async () => {
    const task = new Task();
    const run = task.run(() => Promise.resolve(3), 'no');
    expect(task.busy.value).toBe(true);
    expect(await run).toEqual({ ok: true, value: 3 });
    expect(task.busy.value).toBe(false);
    expect(await task.run(() => Promise.reject(new Error('x')), 'It failed.')).toEqual({ ok: false, problem: 'It failed.' });
    expect(task.problem.value).toBe('It failed.');
  });

  it('pages a list, drops repeats, refreshes the top quietly and ignores stale pages', async () => {
    const pages = new Map<string, { items: number[]; cursor?: string }>([['', { items: [3, 2], cursor: 'a' }], ['a', { items: [2, 1] }]]);
    const list = new Paged<number, { odd?: boolean }>({ fetch: (_f, cursor) => Promise.resolve(pages.get(cursor ?? '') ?? { items: [] }), key: String, failure: 'no', limit: 2 }, {});
    await list.load();
    expect(list.items.value).toEqual([3, 2]);
    expect(list.hasMore.value).toBe(true);
    await list.more();
    expect(list.items.value).toEqual([3, 2, 1]);
    expect(list.hasMore.value).toBe(false);
    pages.set('', { items: [4, 3], cursor: 'a' });
    await list.refresh();
    expect(list.items.value).toEqual([4, 3, 2, 1]);
    const first = list.load({ odd: true });
    pages.set('', { items: [9] });
    const second = list.load({});
    await Promise.all([first, second]);
    expect(list.filter.value).toEqual({});
    expect(list.items.value).toEqual([9]);
  });
});

describe('SystemsStore', () => {
  it('loads systems and pairings, and follows live status and pairing events', async () => {
    const { admin, user } = fakeAdmin();
    admin.start();
    await admin.systems.load();
    expect(admin.systems.sorted.value.map((s) => s.name)).toEqual(['notes', 'fs']);
    expect(admin.systems.pending.value).toBe(1);
    user.push({ type: 'system', system: fs, status: 'disconnected' });
    expect(admin.systems.list.value.value?.find((s) => s.name === 'fs')?.status).toBe('disconnected');
    const fresh = pairing({ id: 'par_live' });
    user.push({ type: 'pairing', pairing: fresh });
    expect(admin.systems.pending.value).toBe(2);
    user.push({ type: 'pairing', pairing: { ...fresh, status: 'expired' } });
    expect(admin.systems.pending.value).toBe(1);
    admin.stop();
    expect(user.size).toBe(0);
  });

  it('answers a pairing, marking it busy, and drops it from the list', async () => {
    const { admin, api } = fakeAdmin();
    await admin.systems.load();
    const id = admin.systems.pairings.value.value?.[0]?.id ?? PairingId.parse('par_x');
    const answering = admin.systems.answerPairing(id, true);
    expect(admin.systems.answering.value.has(id)).toBe(true);
    expect((await answering).ok).toBe(true);
    expect(admin.systems.answering.value.size).toBe(0);
    expect(admin.systems.pending.value).toBe(0);
    expect(api.approvePairing.calls[0]?.[0]).toEqual({ pairing: id, approve: true });
  });

  it('makes tokens and installs systems, reporting failures', async () => {
    const api = fakeAdminApi();
    const { admin } = fakeAdmin({ api: { ...api, installSystem: fakeCaller<'installSystem'>(() => Promise.reject(failure)) } });
    expect(await admin.systems.createToken(undefined, 60_000)).toEqual({ ok: true, value: { token: 'ptk-secret-123', expiresAt: T0 + 60_000 } });
    const result = await admin.systems.installSystem({ path: '/opt/x' }, true);
    expect(result.ok).toBe(false);
    expect(admin.systems.install.problem.value).not.toBe('');
  });
});

describe('SystemStore', () => {
  it('opens a system, follows its status, and forgets it on close', async () => {
    const { admin, user } = fakeAdmin();
    await admin.system.open(fs);
    expect(admin.system.view.value.value?.name).toBe('fs');
    user.push({ type: 'system', system: fs, status: 'needs-config' });
    expect(admin.system.view.value.value?.status).toBe('needs-config');
    admin.system.close();
    expect(admin.system.view.value.value).toBeUndefined();
    expect(user.size).toBe(0);
  });

  it('saves a config, or lists the problems the hub found', async () => {
    const api = fakeAdminApi();
    const { admin } = fakeAdmin({ api });
    await admin.system.open(fs);
    expect(await admin.system.configure({ roots: [] })).toEqual({ ok: true, version: 3 });
    const refusing = fakeAdmin({ api: { ...api, configureSystem: fakeCaller<'configureSystem'>(() => Promise.resolve({ problems: ['roots: at least 1'] })) } });
    await refusing.admin.system.open(fs);
    expect(await refusing.admin.system.configure({ roots: [] })).toEqual({ ok: false, problems: ['roots: at least 1'] });
    const failing = fakeAdmin({ api: { ...api, configureSystem: fakeCaller<'configureSystem'>(() => Promise.reject(failure)) } });
    await failing.admin.system.open(fs);
    expect(await failing.admin.system.configure({})).toMatchObject({ ok: false, problems: [expect.any(String)] });
  });

  it('switches renderers at once and puts them back if the hub refuses', async () => {
    const api = fakeAdminApi();
    const { admin } = fakeAdmin({ api: { ...api, enableSystem: fakeCaller<'enableSystem'>(() => Promise.reject(failure)) } });
    await admin.system.open(fs);
    const pending = admin.system.enable('renderers', false);
    expect(admin.system.view.value.value?.enabled.renderers).toBe(false);
    expect(await pending).toBe(false);
    expect(admin.system.view.value.value?.enabled.renderers).toBe(true);
  });

  it('runs lifecycle actions, restart in one call with its reason (a hosted system restarts through its host)', async () => {
    const { admin, api } = fakeAdmin();
    await admin.system.open(fs);
    expect(await admin.system.act('restart')).toEqual({ ok: true, value: { kind: 'done' } });
    expect(api.restartSystem.calls.map(([body]) => body)).toEqual([{ system: fs, reason: RESTART_REASON }]);
    expect(api.stopSystem.calls).toHaveLength(0);
    expect(await admin.system.act('upgrade', '1.0.0')).toEqual({ ok: true, value: { kind: 'upgrade', from: '0.4.0', to: '1.0.0' } });
    const reimport = await admin.system.act('reimport');
    expect(reimport.ok && reimport.value.kind).toBe('reimport');
    expect(admin.system.acting.value).toBeUndefined();
  });

  it('follows output live, keeping the newest lines', async () => {
    const { admin, logs } = fakeAdmin();
    await admin.system.open(fs);
    await admin.system.followLogs();
    expect(admin.system.logs.value.value).toHaveLength(2);
    logs.push({ system: fs, line: logLine('new line') });
    logs.push({ system: SystemName.parse('other'), line: logLine('not ours') });
    expect(admin.system.logs.value.value?.map((l) => l.text).at(-1)).toBe('new line');
    admin.system.unfollowLogs();
    expect(logs.size).toBe(0);
  });

  it('switches one fn at once, reads the fns again, and puts it back if the hub refuses', async () => {
    const { admin, api } = fakeAdmin();
    await admin.system.open(fs);
    await admin.system.loadFns();
    const read = QualifiedName.parse('fs/read_file');
    expect(await admin.system.switchFn(read, false)).toBe(true);
    expect(api.switchItem.calls.map(([body]) => body)).toEqual([{ section: 'fns', name: read, on: false }]);
    expect(api.systemFns.calls).toHaveLength(2);
    const refusing = fakeAdmin({ api: { ...fakeAdminApi(), switchItem: fakeCaller<'switchItem'>(() => Promise.reject(failure)) } });
    await refusing.admin.system.open(fs);
    await refusing.admin.system.loadFns();
    const pending = refusing.admin.system.switchFn(read, false);
    expect(refusing.admin.system.fns.value.value?.find((fn) => fn.name === read)?.disabled).toBe(true);
    expect(await pending).toBe(false);
    expect(refusing.admin.system.fns.value.value?.find((fn) => fn.name === read)?.disabled).toBe(false);
  });

  it('switches its context on the Overview, and reads its other parts and resource roots', async () => {
    const { admin, api } = fakeAdmin();
    await admin.system.open(fs);
    expect(await admin.system.enable('context', false)).toBe(true);
    expect(api.enableSystem.calls.at(-1)?.[0]).toEqual({ system: fs, context: false });
    expect(admin.system.view.value.value?.enabled.context).toBe(false);
    await admin.systemParts.loadOthers(fs);
    expect(admin.systemParts.others.value.value).toEqual({ parts: [], more: {} });
    expect(admin.systemParts.roots.value.value).toEqual([]);
    expect(api.exploreRoots.calls.map(([body]) => body)).toEqual([{ system: fs }]);
  });

  it('loads fns', async () => {
    const { admin } = fakeAdmin();
    await admin.system.open(fs);
    await admin.system.loadFns();
    expect(admin.system.fns.value.value).toHaveLength(2);
    expect(systemView({ installed: installed() }).installed?.status).toBe('running');
  });

  it('updates a fn’s numbers live as its runs settle, ignoring other systems’ fns', async () => {
    const { admin, user } = fakeAdmin();
    await admin.system.open(fs);
    await admin.system.loadFns();
    const [first] = admin.system.fns.value.value ?? [];
    if (first === undefined) { throw new Error('no fns'); }
    const stats = { outcomes: { done: 2, 'invalid-input': 0, failed: 1, cancelled: 0 }, averageCost: 0.01, averageTime: 120, tokens: 0, lastRunAt: 5 };
    user.push({ type: 'fn', fn: first.name, system: fs, stats });
    expect(admin.system.fns.value.value?.find((f) => f.name === first.name)?.stats).toEqual(stats);
    const before = admin.system.fns.value.value;
    user.push({ type: 'fn', fn: first.name, system: SystemName.parse('other'), stats: { ...stats, averageTime: 9 } });
    expect(admin.system.fns.value.value).toBe(before);
  });
});

describe('ModelsStore, LimitsStore, PoliciesStore and ActorSettingsStore', () => {
  it('loads providers, models and categories, and saves and removes', async () => {
    const { admin, api } = fakeAdmin();
    await admin.models.load();
    expect(admin.models.modelIds.value).toEqual(['openai/gpt-oss-20b:free']);
    expect((await admin.models.saveProvider({ provider: 'openrouter', apiKey: 'k' })).ok).toBe(true);
    expect((await admin.models.saveCategory({ name: 'fast', description: '', models: ['m'] })).ok).toBe(true);
    const id = admin.models.categories.value.value?.[0]?.id;
    if (id !== undefined) { expect(await admin.models.removeCategory(id)).toBe(true); }
    expect(api.removeRule.calls[0]?.[0]).toEqual({ kind: 'category', id: 'mct_1' });
  });

  it('loads budgets and priorities, removes them, and resolves limits for a person', async () => {
    const { admin, api } = fakeAdmin();
    await admin.limits.load();
    expect(admin.limits.budgets.value.value).toEqual([budget()]);
    expect(await admin.limits.removeBudget(BudgetId.parse('bgt_1'))).toBe(true);
    expect(admin.limits.budgets.value.value).toEqual([]);
    await admin.limits.resolve(ActorId.parse('act_ada'), SessionId.parse('ses_1'));
    expect(api.resolveLimits.calls[0]?.[0]).toEqual({ user: 'act_ada', session: 'ses_1' });
    expect(admin.limits.resolved.value.value?.limitedBy).toBe('bgt_1');
    expect((await admin.limits.saveBudget({ target: { scope: 'hub' }, period: 'all-time', maxCost: 1, onLimit: 'refuse' })).ok).toBe(true);
  });

  it('sorts policies and removes one', async () => {
    const { admin } = fakeAdmin();
    await admin.policies.load();
    expect(admin.policies.sorted.value).toHaveLength(1);
    expect(await admin.policies.removePolicy(PolicyId.parse('pol_1'))).toBe(true);
    expect(admin.policies.sorted.value).toHaveLength(0);
  });

  it('groups settings by system and shows a saved value', async () => {
    const api = fakeAdminApi();
    const { admin } = fakeAdmin({ api: { ...api, actorSettings: fakeCaller<'actorSettings'>(() => Promise.resolve({ declared: [settingView(), settingView({ setting: 'crm/view', system: 'crm' })], values: [] })) } });
    await admin.settings.load();
    expect(admin.settings.groups.value.map((g) => g.system)).toEqual(['crm', 'db']);
    expect(await admin.settings.set('db/rows', ActorId.parse('act_eng'), { tables: [], readOnly: false }, ActorId.parse('act_ada'), T0)).toBe(true);
    expect(admin.settings.groups.value.find((g) => g.system === 'db')?.settings[0]?.values).toHaveLength(1);
  });

  it('names actors and offers them by kind', async () => {
    const { admin, api } = fakeAdmin();
    await admin.actors.load();
    await admin.actors.load();
    expect(api.actors.calls).toHaveLength(1);
    expect(admin.actors.nameOf(ActorId.parse('act_eng'))).toBe('Engineering');
    expect(admin.actors.nameOf(ActorId.parse('act_who'))).toBe('act_who');
    expect(admin.actors.options(['group']).map((a) => a.name)).toEqual(['Engineering']);
  });
});

describe('browsers', () => {
  it("pages inside the query when there is one, and names a run's model calls by the old field", () => {
    expect(withPage({ query: { text: 'x' } }, 50, 'c2')).toEqual({ query: { text: 'x', limit: 50, cursor: 'c2' } });
    expect(withPage({ archived: false }, 40, undefined)).toEqual({ archived: false, limit: 40 });
    const run = RunId.parse('run_a');
    expect(modelCallsBody({ query: { text: 'x' }, run })).toEqual({ run });
    expect(modelCallsBody({ query: {} })).toEqual({ query: {} });
  });


  it('lists runs for a filter and opens one whole', async () => {
    const { admin, api } = fakeAdmin();
    const failed: ListQuery = { filters: [{ field: 'status', op: 'is', value: 'failed' }] };
    await admin.runs.list.load(failed);
    expect(api.runs.calls[0]?.[0]).toEqual({ query: { ...failed, limit: 50 } });
    expect(admin.runs.list.items.value.map((r) => r.id)).toEqual(['run_a', 'run_b']);
    await admin.runs.open(RunId.parse('run_a'));
    expect(admin.runs.opened.value.value?.id).toBe('run_a');
    admin.runs.close();
    expect(admin.runs.opened.value.value).toBeUndefined();
  });

  it('moves a run to the background and undoes a turn', async () => {
    const { admin, chatApi } = fakeAdmin();
    expect((await admin.runs.background(RunId.parse('run_a'))).ok).toBe(true);
    expect(chatApi.background.calls[0]?.[0]).toEqual({ run: 'run_a' });
    expect((await admin.runs.undoTurn(TurnId.parse('trn_1'))).ok).toBe(true);
    await flushPromises();
  });

  it('opens LLM calls and resources', async () => {
    const { admin } = fakeAdmin();
    await admin.llm.list.load({});
    await admin.llm.open(LlmInteractionId.parse('llm_a'));
    expect(admin.llm.opened.value.value?.id).toBe('llm_a');
    await admin.resources.list.load({ text: 'harness' });
    await admin.resources.open(ResourceUri.parse('fs://work/docs/harness.md'));
    expect(admin.resources.opened.value.value?.stat.name).toBe('harness.md');
  });
});
