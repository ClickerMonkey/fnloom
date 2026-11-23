import { ActorId, NotificationAlso, RunId, RunSummary, SessionId, UndoReport } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../app/App.vue';
import { createAppRouter } from '../app/router.ts';
import { ROUTES } from '../app/routes.ts';
import { approval, fakeChatApi, ME, run, tree } from '../chat/test/fakes.ts';
import { lookOf } from '../components/inbox/reasons.ts';
import { ALSO_ACTION, clickedPath, PushPayload, pushOpenPath, pushTag, pushTargets } from '../state/push-payload.ts';
import { STORES } from '../state/stores.ts';
import { failingCaller, fakeCaller, fakeStores, notification } from '../test/fakes.ts';
import { alsoOf, alsoParam, branchOf, canUndo, hasBranch, isLive, relatedLinks, undoSummary } from './logic.ts';
import { RunPageStore } from './store.ts';

const me = ActorId.parse(ME);
const HISTORY = NotificationAlso.parse({ label: 'History', link: { page: { system: 'schedule', segment: 'item', path: ['weekly'], query: { tab: 'history' } } } });

describe('the run page logic', () => {
  it('finds a run\'s own branch of its turn\'s tree, and whether it has anything under it', () => {
    const summary = (id: string, fn: string) => RunSummary.parse({ id, fn, status: 'done', cost: 0, totalCost: 0 });
    const leaf = tree({ run: summary('run_3', 'fs/read'), llmCalls: [], children: [] });
    const middle = tree({ run: summary('run_2', 'hub/agent'), llmCalls: [], children: [leaf] });
    const root = tree({ children: [middle] });
    expect(branchOf(root, RunId.parse('run_2'))?.run.id).toBe('run_2');
    expect(branchOf(root, RunId.parse('run_3'))?.children).toEqual([]);
    expect(branchOf(root, RunId.parse('run_9'))).toBeUndefined();
    expect(branchOf(undefined, RunId.parse('run_1'))).toBeUndefined();
    expect(hasBranch(middle)).toBe(true);
    expect(hasBranch(leaf)).toBe(false);
    expect(hasBranch(tree())).toBe(true);
  });

  it('offers Undo only on an ended first run of a turn outside any chat, to the person it ran for', () => {
    const done = run({ id: 'run_u', root: 'run_u', status: 'done' });
    expect(canUndo(done, me)).toBe(true);
    expect(canUndo({ ...done, status: 'failed' }, me)).toBe(true);
    expect(canUndo({ ...done, status: 'running' }, me)).toBe(false);
    expect(canUndo({ ...done, status: 'undone' }, me)).toBe(false);
    expect(canUndo({ ...done, session: SessionId.parse('ses_1') }, me)).toBe(false);
    expect(canUndo({ ...done, parent: RunId.parse('run_p'), root: RunId.parse('run_p') }, me)).toBe(false);
    // an admin looking at someone else's run: the hub undoes a turn outside a chat only for its own person
    expect(canUndo(done, ActorId.parse('act_bob'))).toBe(false);
    expect(canUndo(done, undefined)).toBe(false);
    expect(isLive(run({ status: 'awaiting-approval' }))).toBe(true);
    expect(isLive(done)).toBe(false);
    expect(isLive(undefined)).toBe(false);
  });

  it('carries a notification\'s second link in the URL and reads back only what fits', () => {
    expect(alsoOf(alsoParam(HISTORY))).toEqual(HISTORY);
    expect(alsoOf('')).toBeUndefined();
    expect(alsoOf('{not json')).toBeUndefined();
    expect(alsoOf(JSON.stringify({ label: 'History', link: { elsewhere: 'https://evil.example' } }))).toBeUndefined();
    expect(alsoOf(JSON.stringify({ label: 'x'.repeat(40), link: { run: 'run_1' } }))).toBeUndefined();
  });

  it('lists the pages a run relates to: the notification\'s second link, its chat, its caller and, for admins, Admin › Runs', () => {
    const routes = { session: (s: string) => `/chat/${s}`, run: (r: string) => `/run/${r}`, admin: (r: string) => `/admin/runs?run=${r}` };
    const inChat = run({ id: 'run_c', session: 'ses_1', parent: 'run_p' });
    expect(relatedLinks(inChat, routes, { admin: true, also: { label: 'History', to: '/s/schedule/item/weekly' } }).map((l) => [l.key, l.label, l.to])).toEqual([
      ['also', 'History', '/s/schedule/item/weekly'], ['chat', 'Open the chat', '/chat/ses_1'], ['parent', 'Called by', '/run/run_p'], ['admin', 'In Admin › Runs', '/admin/runs?run=run_c'],
    ]);
    expect(relatedLinks(run({ id: 'run_o' }), routes, { admin: false })).toEqual([]);
  });

  it('says what an undo did', () => {
    expect(undoSummary(UndoReport.parse({ turn: 'trn_1', undone: [], failed: [], notUndoable: [] }))).toEqual({ tone: 'ok', body: 'Nothing needed undoing.' });
    const mixed = UndoReport.parse({
      turn: 'trn_1', undone: [{ run: 'run_1', fn: 'fs/write', summary: 'restored' }], failed: [{ run: 'run_2', fn: 'fs/rm', error: { class: 'fatal', code: 'X', message: 'gone' } }], notUndoable: [{ run: 'run_3', fn: 'mail/send' }],
    });
    expect(undoSummary(mixed)).toEqual({ tone: 'warn', body: "1 undone, 1 couldn't be undone, 1 have no undo." });
  });
});

describe('the run page store', () => {
  it('loads the run, its tree and, while it waits, its approval; answers it and refreshes', async () => {
    const api = fakeChatApi();
    let status: 'awaiting-approval' | 'done' = 'awaiting-approval';
    api.run = fakeCaller<'run'>(({ run: id }) => Promise.resolve(run({ id, root: id, status })));
    api.approvals = fakeCaller<'approvals'>(({ runs }) => Promise.resolve(runs.map((r) => approval({ run: r }))));
    const store = new RunPageStore(api);
    await store.open(RunId.parse('run_1'));
    expect(store.run.value.value?.id).toBe('run_1');
    expect(store.branch.value?.run.id).toBe('run_1');
    expect(store.approval.value?.run).toBe('run_1');
    status = 'done';
    expect(await store.decide(true, '', undefined)).toBe(true);
    expect(api.approve.calls[0]?.[0]).toMatchObject({ approve: true, remember: 'once' });
    await flushPromises();
    expect(store.approval.value).toBeUndefined();
    expect(store.run.value.value?.status).toBe('done');
  });

  it('undoes the run\'s turn and moves it to the background, saying why when the hub refuses', async () => {
    const api = fakeChatApi();
    api.run = fakeCaller<'run'>(({ run: id }) => Promise.resolve(run({ id, root: id, turn: 'trn_9', status: 'done' })));
    const store = new RunPageStore(api);
    expect((await store.undo()).ok).toBe(false);
    await store.open(RunId.parse('run_1'));
    const undone = await store.undo();
    expect(undone.ok).toBe(true);
    expect(api.undoTurn.calls[0]?.[0]).toEqual({ turn: 'trn_9' });
    expect(await store.background()).toEqual({ ok: true, value: true });
    store.acting.problem.value = '';
    const refusing = new RunPageStore({ ...api, undoTurn: failingCaller<'undoTurn'>(new Error('A later turn was built on this one.')) });
    await refusing.open(RunId.parse('run_1'));
    const refused = await refusing.undo();
    expect(refused.ok).toBe(false);
    expect(refusing.acting.problem.value).not.toBe('');
  });

  it('reads a run it may not see as a problem, and a missing approval as none', async () => {
    const api = fakeChatApi();
    const store = new RunPageStore({ ...api, run: failingCaller<'run'>(new Error('no such run')), approvals: failingCaller<'approvals'>(new Error('down')) });
    await store.open(RunId.parse('run_404'));
    expect(store.run.value.value).toBeUndefined();
    expect(store.run.problem.value).not.toBe('');
    const waiting = new RunPageStore({ ...api, run: fakeCaller<'run'>(({ run: id }) => Promise.resolve(run({ id, status: 'awaiting-approval' }))), approvals: failingCaller<'approvals'>(new Error('down')) });
    await waiting.open(RunId.parse('run_w'));
    expect(waiting.approval.value).toBeUndefined();
  });
});

describe('notification targets: tone, the second link, pushes', () => {
  it('shows a notification\'s tone in its icon and colour, keeping its reason\'s label', () => {
    expect(lookOf({ reason: 'system-message', tone: 'ok' })).toEqual({ icon: 'success', tone: 'ok', label: 'Update' });
    expect(lookOf({ reason: 'system-message', tone: 'failed' })).toEqual({ icon: 'error', tone: 'danger', label: 'Update' });
    expect(lookOf({ reason: 'system-message', tone: 'info' })).toEqual({ icon: 'info', tone: 'neutral', label: 'Update' });
    expect(lookOf({ reason: 'system-message' })).toEqual({ icon: 'info', tone: 'neutral', label: 'Update' });
    expect(lookOf({ reason: 'system-message', tone: 'failed', resolved: 'Seen' })).toEqual({ icon: 'check', tone: 'neutral', label: 'Update · Seen' });
  });

  it('tags a push by its key, offers its second link as an action, and opens either from a click', () => {
    const payload = PushPayload.parse({ id: 'ntf_1', title: 'Weekly sales ran', body: '12 rows', link: { run: 'run_1' }, reason: 'system-message', also: HISTORY, key: 'schedule:s/weekly', tone: 'ok' });
    expect(pushTag(payload)).toBe('schedule:s/weekly');
    expect(pushTag({ id: payload.id })).toBe('ntf_1');
    const targets = pushTargets(payload);
    expect(targets).toEqual({ link: pushOpenPath(payload), also: '/inbox?open=ntf_1&via=also' });
    expect(pushTargets({ id: payload.id })).toEqual({ link: '/inbox?open=ntf_1' });
    expect(clickedPath(targets, '')).toBe('/inbox?open=ntf_1');
    expect(clickedPath(targets, ALSO_ACTION)).toBe('/inbox?open=ntf_1&via=also');
    // an older push kept a bare path; anything not in the app opens the inbox
    expect(clickedPath('/inbox?open=ntf_2', '')).toBe('/inbox?open=ntf_2');
    expect(clickedPath('https://evil.example', '')).toBe('/inbox');
    expect(clickedPath({ link: '//evil.example' }, '')).toBe('/inbox');
    expect(clickedPath(undefined, ALSO_ACTION)).toBe('/inbox');
  });
});

describe('the run page', () => {
  async function open(path: string, setup: (fakes: ReturnType<typeof fakeStores>) => void = () => undefined) {
    const fakes = fakeStores({ signedIn: true });
    setup(fakes);
    const router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push(path);
    await router.isReady();
    const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
    await flushPromises();
    return { ...fakes, router, app };
  }

  it('shows a run outside a chat with its result, details, related pages and Undo, and undoes it', async () => {
    const { app, router, chat } = await open(`/run/run_5?also=${encodeURIComponent(alsoParam(HISTORY))}`, (fakes) => {
      fakes.chat.api.run.call = ({ run: id }) => Promise.resolve(run({ id, root: id, status: 'done', outcome: { status: 'done', result: 'Read 12 lines.' } }));
    });
    expect(router.currentRoute.value.name).toBe(ROUTES.run);
    const page = app.get('[data-testid="run-page"]');
    expect(page.attributes('data-run')).toBe('run_5');
    expect(page.find('[data-testid="run-card"]').exists()).toBe(true);
    expect(page.text()).toContain('Read 12 lines.');
    expect(app.find('[data-testid="run-details"]').exists()).toBe(true);
    expect(app.find('[data-testid="run-related-also"]').text()).toBe('History');
    await app.get('[data-testid="run-undo"]').trigger('click');
    await flushPromises();
    expect(chat.api.undoTurn.calls).toHaveLength(1);
    await app.get('[data-testid="run-related-also"]').trigger('click');
    // the system page loads on first visit
    await vi.waitFor(() => { expect(router.currentRoute.value.fullPath).toBe('/s/schedule/item/weekly?tab=history'); });
    app.unmount();
  });

  it('shows the approval card while the run waits, and no Undo on a run in a chat', async () => {
    const { app } = await open('/run/run_6', (fakes) => {
      fakes.chat.api.run.call = ({ run: id }) => Promise.resolve(run({ id, root: id, session: 'ses_1', status: 'awaiting-approval' }));
    });
    expect(app.find('[data-testid="run-approval"]').exists()).toBe(true);
    expect(app.find('[data-testid="run-undo"]').exists()).toBe(false);
    expect(app.find('[data-testid="run-related-chat"]').exists()).toBe(true);
    app.unmount();
  });

  it('says a run it may not see is missing, and a bad address names no run', async () => {
    const missing = await open('/run/run_404', (fakes) => { fakes.chat.api.run.call = () => Promise.reject(new Error('no such run')); });
    expect(missing.app.find('[data-testid="run-page"]').exists()).toBe(false);
    expect(missing.app.find('[data-testid="retry"]').exists()).toBe(true);
    missing.app.unmount();
    const bad = await open('/run/not-a-run');
    expect(bad.app.find('[data-testid="run-missing"]').exists()).toBe(true);
    bad.app.unmount();
  });

  it('opens a notification\'s second link from the inbox\'s second button', async () => {
    const told = notification({ reason: 'system-message', title: 'Weekly sales ran', link: { run: 'run_7' }, also: HISTORY, tone: 'ok' });
    const { app, router } = await open('/inbox', (fakes) => { fakes.api.notifications.list.call = async () => ({ items: [told] }); });
    const row = app.get(`[data-testid="notification-${told.id}"]`);
    expect(row.find('.mark').classes()).toContain('tone-ok');
    await row.get('[data-testid="notification-also"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/s/schedule/item/weekly?tab=history');
    app.unmount();
  });

  it('opens a push\'s action by the notification\'s second link', async () => {
    const told = notification({ reason: 'system-message', link: { run: 'run_7' }, also: HISTORY });
    const { app, router } = await open(`/inbox?open=${told.id}&via=also`, (fakes) => { fakes.api.notifications.list.call = async () => ({ items: [told] }); });
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/s/schedule/item/weekly?tab=history');
    app.unmount();
  });
});
