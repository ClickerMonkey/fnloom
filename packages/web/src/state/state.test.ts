import { ApiError } from '@ayepi/core/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { z } from 'zod';
import { failingCaller, fakeApi, fakeCaller, fakeConnection, fakeMedia, fakeUserEvents, memoryStore, notification, tokens } from '../test/fakes.ts';
import { BrowserLock, LocalLock, REFRESH_AHEAD, REFRESH_LOCK, SessionKeeper, SignInForm } from './auth.ts';
import { BACK_ONLINE_FOR, ConnectionStore, OFFLINE_AFTER } from './connection.ts';
import { INBOX_PAGE, InboxStore } from './inbox.ts';
import { LAYOUT_KEY, LayoutStore } from './layout.ts';
import { persisted, readStored, type KeyValueStore, type StorageChanges } from './persisted.ts';
import { checkForm, problemText } from './problems.ts';
import { SESSION_KEY, SessionStore } from './session.ts';
import { THEME_KEY, ThemeStore } from './theme.ts';
import { TOAST_DEFAULTS, Toasts } from './toasts.ts';

describe('persisted', () => {
  it('reads through the schema, saves changes, and removes on undefined', () => {
    const store = memoryStore({ k: JSON.stringify({ n: 2 }) });
    const value = persisted(store, 'k', z.object({ n: z.number() }).optional(), undefined);
    expect(value.value).toEqual({ n: 2 });
    value.value = { n: 3 };
    expect(store.data.get('k')).toBe('{"n":3}');
    value.value = undefined;
    expect(store.data.has('k')).toBe(false);
  });

  it('ignores stored values that are not JSON or no longer match', () => {
    expect(readStored(memoryStore({ k: '{oops' }), 'k', z.number())).toBeUndefined();
    expect(persisted(memoryStore({ k: '"text"' }), 'k', z.number(), 7).value).toBe(7);
  });
});

describe('SessionStore', () => {
  it('keeps tokens across a reload with when they expire, and forgets them', () => {
    const store = memoryStore();
    const first = new SessionStore(store, () => 1_000);
    expect(first.signedIn.value).toBe(false);
    first.keep(tokens());
    expect(first.accessToken.value).toBe('access.token');
    expect(first.expiresAt.value).toBe(1_000 + 900_000);

    const reloaded = new SessionStore(store);
    expect(reloaded.signedIn.value).toBe(true);
    expect(reloaded.user.value?.name).toBe('Ada Lovelace');
    expect(reloaded.refreshToken.value).toBe('refresh-token');

    reloaded.forget();
    expect(reloaded.signedIn.value).toBe(false);
    expect(store.data.has(SESSION_KEY)).toBe(false);
  });

  it('treats a stored session in an old shape as signed out', () => {
    expect(new SessionStore(memoryStore({ [SESSION_KEY]: JSON.stringify({ access: 1 }) })).signedIn.value).toBe(false);
  });
});

describe('SignInForm', () => {
  it('signs in with the hub, keeping the tokens', async () => {
    const api = fakeApi();
    const session = new SessionStore(memoryStore());
    const form = new SignInForm(api.auth, session);
    await form.load();
    expect(form.needsAdmin).toBe(false);
    expect(form.loading.value).toBe(false);
    expect(await form.submit({ email: 'ada@example.com', password: 'secret', name: '' })).toBe(true);
    expect(api.auth.signIn.calls[0]).toEqual([{ email: 'ada@example.com', password: 'secret' }, { transport: 'http' }]);
    expect(session.signedIn.value).toBe(true);
  });

  it('makes the admin account on a new hub, checked by the endpoint schema first', async () => {
    const api = fakeApi();
    api.auth.setup = fakeCaller<'setup'>(async () => ({ needsAdmin: true, name: 'New hub', version: '1' }));
    const form = new SignInForm(api.auth, new SessionStore(memoryStore()));
    await form.load();
    expect(form.needsAdmin).toBe(true);
    expect(await form.submit({ email: 'nope', password: 'short', name: '' })).toBe(false);
    expect(form.fields.value).toEqual({ email: 'Enter an email address.', password: 'At least 10 characters.', name: 'Required.' });
    expect(api.auth.createAdmin.calls).toHaveLength(0);
    expect(await form.submit({ email: 'ada@example.com', password: 'long enough pass', name: 'Ada' })).toBe(true);
    expect(form.fields.value).toEqual({});
    expect(api.auth.createAdmin.calls).toHaveLength(1);
  });

  it('says why sign-in failed, using the hub reason when it gives one', async () => {
    const api = fakeApi();
    api.auth.signIn = failingCaller<'signIn'>(new ApiError(401, 'UNAUTHORIZED', 'no', { reason: 'Wrong email or password.' }));
    const form = new SignInForm(api.auth, new SessionStore(memoryStore()));
    await form.load();
    expect(await form.submit({ email: 'ada@example.com', password: 'x', name: '' })).toBe(false);
    expect(form.problem.value).toBe('Wrong email or password.');
    expect(form.busy.value).toBe(false);
  });

  it('reports a hub it cannot reach', async () => {
    const api = fakeApi();
    api.auth.setup = failingCaller<'setup'>(new ApiError(0, 'DISCONNECTED'));
    const form = new SignInForm(api.auth, new SessionStore(memoryStore()));
    await form.load();
    expect(form.problem.value).toBe("Can't reach the hub. Check the connection and try again.");
  });
});

describe('SessionKeeper', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('refreshes a minute before the access token expires', async () => {
    const api = fakeApi();
    const session = new SessionStore(memoryStore(), () => Date.now());
    session.keep(tokens({ expiresIn: 5 * 60_000 }));
    const keeper = new SessionKeeper(api.auth, session, () => Date.now());
    keeper.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000 - REFRESH_AHEAD - 1);
    expect(api.auth.refresh.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.auth.refresh.calls).toEqual([[{ refresh: 'refresh-token' }, { transport: 'http' }]]);
    expect(session.accessToken.value).toBe('access.fresh');
    keeper.stop();
  });

  it('signs out when the refresh is refused, and on sign-out even if the hub fails', async () => {
    const api = fakeApi();
    api.auth.refresh = failingCaller<'refresh'>(new ApiError(401, 'UNAUTHORIZED'));
    const session = new SessionStore(memoryStore());
    session.keep(tokens());
    const keeper = new SessionKeeper(api.auth, session);
    expect(await keeper.refresh('refused')).toBe(false);
    expect(session.signedIn.value).toBe(false);
    expect(await keeper.refresh('refused')).toBe(false);

    session.keep(tokens());
    api.auth.signOut = failingCaller<'signOut'>(new ApiError(500, 'ERROR'));
    await keeper.signOut();
    expect(session.signedIn.value).toBe(false);
  });
});

describe('the session across tabs', () => {
  /** Storage shared by tabs, with each write announced to the other tabs (as the browser's storage event is). */
  function sharedStorage() {
    const store = memoryStore();
    const listeners = new Set<(key: string | null) => void>();
    const tab = (): { store: KeyValueStore; changes: StorageChanges } => {
      let mine: ((key: string | null) => void) | undefined;
      const own: KeyValueStore = {
        getItem: (key) => store.getItem(key),
        setItem: (key, value) => { store.setItem(key, value); for (const l of listeners) { if (l !== mine) { l(key); } } },
        removeItem: (key) => { store.removeItem(key); for (const l of listeners) { if (l !== mine) { l(key); } } },
      };
      return { store: own, changes: (listener) => { mine = listener; listeners.add(listener); return () => { listeners.delete(listener); }; } };
    };
    return { tab };
  }

  it("follows another tab's rotated tokens and its sign-out", () => {
    const shared = sharedStorage();
    const a = shared.tab();
    const b = shared.tab();
    const one = new SessionStore(a.store, Date.now, a.changes);
    const two = new SessionStore(b.store, Date.now, b.changes);
    one.keep(tokens());
    expect(two.accessToken.value).toBe('access.token');
    one.keep(tokens({ access: 'access.2', refresh: 'refresh.2' }));
    expect(two.refreshToken.value).toBe('refresh.2');
    one.forget();
    expect(two.signedIn.value).toBe(false);
  });

  it('refreshes once when every tab finds the token due, and the others take the tokens it got', async () => {
    const shared = sharedStorage();
    const lock = new LocalLock();
    const api = fakeApi();
    api.auth.refresh = fakeCaller<'refresh'>(() => Promise.resolve(tokens({ access: 'access.2', refresh: 'refresh.2' })));
    const now = { at: 0 };
    const tabs = [shared.tab(), shared.tab(), shared.tab()].map((tab) => {
      const session = new SessionStore(tab.store, () => now.at, tab.changes);
      return { session, keeper: new SessionKeeper(api.auth, session, () => now.at, lock) };
    });
    tabs[0]?.session.keep(tokens({ expiresIn: 5 * 60_000 }));
    now.at = 5 * 60_000 - REFRESH_AHEAD;
    const results = await Promise.all(tabs.map((t) => t.keeper.refresh()));
    expect(results).toEqual([true, true, true]);
    expect(api.auth.refresh.calls).toHaveLength(1);
    expect(tabs.map((t) => t.session.refreshToken.value)).toEqual(['refresh.2', 'refresh.2', 'refresh.2']);
  });

  it('takes the tokens another tab rotated while this one waited, rather than spending the old refresh token', async () => {
    const store = memoryStore();
    const api = fakeApi();
    const session = new SessionStore(store);
    session.keep(tokens());
    const keeper = new SessionKeeper(api.auth, session, Date.now, new LocalLock());
    // another tab wrote new tokens straight to storage, with no storage event seen here yet
    store.setItem(SESSION_KEY, JSON.stringify({ access: 'access.other', refresh: 'refresh.other', user: tokens().user, expiresAt: Date.now() + 900_000 }));
    expect(await keeper.refresh('refused')).toBe(true);
    expect(api.auth.refresh.calls).toHaveLength(0);
    expect(session.accessToken.value).toBe('access.other');
  });

  it('recovers from a refused token once, however many calls were refused together', async () => {
    const api = fakeApi();
    const session = new SessionStore(memoryStore());
    session.keep(tokens());
    const keeper = new SessionKeeper(api.auth, session);
    expect(await Promise.all([keeper.recover(), keeper.recover(), keeper.recover()])).toEqual([true, true, true]);
    expect(api.auth.refresh.calls).toHaveLength(1);
    api.auth.refresh = failingCaller<'refresh'>(new ApiError(401, 'UNAUTHORIZED'));
    expect(await keeper.recover()).toBe(false);
    expect(session.signedIn.value).toBe(false);
  });

  it('runs under the tab lock where the browser has no Web Locks', async () => {
    const order: string[] = [];
    const lock = new BrowserLock(undefined);
    const first = lock.run(REFRESH_LOCK, async () => { order.push('first'); await Promise.resolve(); order.push('first done'); return 1; });
    const second = lock.run(REFRESH_LOCK, () => { order.push('second'); return Promise.resolve(2); });
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(['first', 'first done', 'second']);
  });
});

describe('ThemeStore', () => {
  it('follows the device until a theme is chosen, and sets data-theme', () => {
    const device = fakeMedia(false);
    const root = document.createElement('html');
    const store = memoryStore();
    const theme = new ThemeStore({ store, media: device.media, root });
    expect(theme.theme.value).toBe('light');
    expect(root.dataset['theme']).toBe('light');
    device.set(true);
    expect(theme.theme.value).toBe('dark');
    expect(root.dataset['theme']).toBe('dark');
    theme.choice.value = 'light';
    expect(root.dataset['theme']).toBe('light');
    expect(store.data.get(THEME_KEY)).toBe('"light"');
    theme.dispose();
    expect(new ThemeStore({ store, media: device.media, root }).choice.value).toBe('light');
  });
});

describe('LayoutStore', () => {
  it('saves the collapsed sidebar, not the drawer', () => {
    const store = memoryStore();
    const layout = new LayoutStore(store);
    expect(layout.collapsed).toBe(false);
    layout.toggleSidebar();
    layout.drawerOpen.value = true;
    expect(store.data.get(LAYOUT_KEY)).toBe('{"collapsed":true}');
    const reloaded = new LayoutStore(store);
    expect(reloaded.collapsed).toBe(true);
    expect(reloaded.drawerOpen.value).toBe(false);
  });
});

describe('Toasts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows toasts that leave on their own, waiting while held', () => {
    const toasts = new Toasts();
    const id = toasts.ok('Saved', 'All good');
    expect(toasts.items).toEqual([{ id, tone: 'ok', title: 'Saved', body: 'All good' }]);
    toasts.hold(id);
    vi.advanceTimersByTime(TOAST_DEFAULTS.duration * 2);
    expect(toasts.items).toHaveLength(1);
    toasts.release(id);
    vi.advanceTimersByTime(TOAST_DEFAULTS.duration);
    expect(toasts.items).toHaveLength(0);
  });

  it('runs an action once and dismisses, keeps sticky toasts, and drops the oldest past the cap', () => {
    const toasts = new Toasts({ duration: 1_000, max: 2 });
    const run = vi.fn();
    const withAction = toasts.push({ title: 'Undone', action: { label: 'Redo', run }, duration: 0 });
    expect(toasts.items[0]?.action).toBe('Redo');
    vi.advanceTimersByTime(10_000);
    expect(toasts.items).toHaveLength(1);
    toasts.act(withAction);
    toasts.act(withAction);
    expect(run).toHaveBeenCalledOnce();
    toasts.error('a');
    toasts.error('b');
    toasts.error('c');
    expect(toasts.items.map((t) => t.title)).toEqual(['b', 'c']);
    toasts.dismiss(999);
    toasts.hold(999);
    toasts.release(999);
  });
});

describe('ConnectionStore', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('says offline only after a lasting drop, then back online for a moment, and tells listeners', () => {
    const connection = fakeConnection();
    const store = new ConnectionStore(connection);
    const reconnected = vi.fn();
    const stop = store.onReconnect(reconnected);
    connection.set('online');
    expect(reconnected).not.toHaveBeenCalled();

    connection.set('offline');
    vi.advanceTimersByTime(OFFLINE_AFTER - 1);
    expect(store.state.value).toBe('online');
    connection.set('online');
    expect(store.state.value).toBe('online');
    expect(reconnected).toHaveBeenCalledOnce();

    connection.set('offline');
    connection.set('offline');
    vi.advanceTimersByTime(OFFLINE_AFTER);
    expect(store.state.value).toBe('offline');
    connection.set('online');
    expect(store.state.value).toBe('back');
    expect(reconnected).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(BACK_ONLINE_FOR);
    expect(store.state.value).toBe('online');
    stop();
    store.dispose();

    const startsOffline = new ConnectionStore(fakeConnection('offline'));
    vi.advanceTimersByTime(OFFLINE_AFTER);
    expect(startsOffline.state.value).toBe('offline');
  });
});

describe('InboxStore', () => {
  it('loads a page, counts the unread, and pages back', async () => {
    const api = fakeApi();
    const first = [notification(), notification({ read: true })];
    const older = [notification()];
    api.notifications.list = fakeCaller<'notifications'>(async (data) => (data?.unread === true ? { items: [first[0], older[0]].filter((n) => n !== undefined) } : data?.cursor === 'c2' ? { items: older } : { items: first, cursor: 'c2' }));
    const events = fakeUserEvents();
    const inbox = new InboxStore(api.notifications, events.subscribe);
    inbox.start();
    await inbox.load('all');
    await flush();
    expect(inbox.items.value).toEqual(first);
    expect(inbox.unread.value).toBe(2);
    expect(inbox.hasMore.value).toBe(true);
    expect(api.notifications.list.calls[0]).toEqual([{ limit: 100, unread: true }]);
    await inbox.loadMore();
    expect(inbox.items.value).toHaveLength(3);
    expect(inbox.hasMore.value).toBe(false);
    await inbox.loadMore();
    expect(api.notifications.list.calls.at(-1)).toEqual([{ limit: INBOX_PAGE, cursor: 'c2' }]);
    inbox.stop();
    expect(events.listeners).toBe(0);
  });

  it('adds live arrivals once and counts them', async () => {
    const api = fakeApi();
    const events = fakeUserEvents();
    const inbox = new InboxStore(api.notifications, events.subscribe);
    inbox.start();
    inbox.start();
    expect(events.listeners).toBe(1);
    await inbox.load();
    const arrived = notification();
    events.push({ type: 'notification', notification: arrived });
    events.push({ type: 'notification', notification: arrived });
    events.push({ type: 'capabilities' });
    expect(inbox.items.value).toEqual([arrived]);
    expect(inbox.unread.value).toBe(1);
  });

  it('sends the search with every page and leaves live arrivals out while it narrows the list', async () => {
    const api = fakeApi();
    api.notifications.list = fakeCaller<'notifications'>(async (data) => (data?.cursor === undefined ? { items: [], cursor: 'c2' } : { items: [] }));
    const events = fakeUserEvents();
    const inbox = new InboxStore(api.notifications, events.subscribe);
    inbox.start();
    const query = { filters: [{ field: 'kind', op: 'is' as const, value: 'approval' }] };
    await inbox.load('unread', query);
    await inbox.loadMore();
    expect(api.notifications.list.calls.slice(-2)).toEqual([[{ unread: true, query: { ...query, limit: INBOX_PAGE } }], [{ unread: true, query: { ...query, limit: INBOX_PAGE, cursor: 'c2' } }]]);
    events.push({ type: 'notification', notification: notification() });
    expect(inbox.items.value).toEqual([]);
    await inbox.load('all', {});
    expect(api.notifications.list.calls.at(-1)).toEqual([{ limit: INBOX_PAGE }]);
  });

  it('shows a notification the hub resolved as it is now, and stops counting it', async () => {
    const api = fakeApi();
    const events = fakeUserEvents();
    const inbox = new InboxStore(api.notifications, events.subscribe);
    inbox.start();
    await inbox.load();
    const asking = { ...notification(), reason: 'approval-needed' as const };
    events.push({ type: 'notification', notification: asking });
    expect(inbox.unread.value).toBe(1);
    const resolved = { ...asking, read: true, resolved: 'Approved' };
    events.push({ type: 'notification', notification: resolved });
    expect(inbox.items.value).toEqual([resolved]);
    expect(inbox.unread.value).toBe(0);
    await inbox.load('unread');
    events.push({ type: 'notification', notification: asking });
    events.push({ type: 'notification', notification: resolved });
    expect(inbox.items.value).toEqual([]);
  });

  it('marks read at once and puts it back if the hub refuses', async () => {
    const api = fakeApi();
    const unread = [notification(), notification()];
    api.notifications.list = fakeCaller<'notifications'>(async () => ({ items: unread }));
    const inbox = new InboxStore(api.notifications, fakeUserEvents().subscribe);
    await inbox.load('all');
    await inbox.countUnread();
    expect(await inbox.markAllRead()).toBe(true);
    expect(inbox.items.value.every((n) => n.read)).toBe(true);
    expect(inbox.unread.value).toBe(0);
    expect(await inbox.markRead([])).toBe(true);

    api.notifications.markRead = failingCaller<'readNotifications'>(new ApiError(500, 'ERROR'));
    const again = new InboxStore(api.notifications, fakeUserEvents().subscribe);
    await again.load('unread');
    await again.countUnread();
    const target = unread[0];
    if (target === undefined) { throw new Error('no notification'); }
    expect(await again.markRead([target.id])).toBe(false);
    expect(again.items.value).toEqual(unread);
    expect(again.unread.value).toBe(2);
    expect(again.problem.value).toBe('The hub had a problem. Try again in a moment.');
  });

  it('removes read ones from the unread view, and shows load problems', async () => {
    const api = fakeApi();
    const items = [notification(), notification()];
    api.notifications.list = fakeCaller<'notifications'>(async () => ({ items }));
    const inbox = new InboxStore(api.notifications, fakeUserEvents().subscribe);
    await inbox.load('unread');
    const first = items[0];
    if (first === undefined) { throw new Error('no notification'); }
    await inbox.markRead([first.id]);
    expect(inbox.items.value).toEqual([items[1]]);

    api.notifications.list = failingCaller<'notifications'>(new ApiError(0, 'DISCONNECTED'));
    const broken = new InboxStore(api.notifications, fakeUserEvents().subscribe);
    await broken.load();
    expect(broken.problem.value).toBe("Can't reach the hub. Check the connection and try again.");
    await broken.countUnread();
    expect(broken.unread.value).toBe(0);
    await broken.refresh();
  });
});

async function flush(): Promise<void> {
  await nextTick();
  await Promise.resolve();
}

describe('problems', () => {
  it('turns failures into sentences', () => {
    expect(problemText(new ApiError(429, 'RATE'))).toBe('Too many tries. Wait a moment and try again.');
    expect(problemText(new ApiError(403, 'FORBIDDEN'))).toBe("You don't have access to that.");
    expect(problemText(new ApiError(403, 'NOT_A_MEMORY', 'fs/guide is not a memory; only memories can be forgotten'))).toBe('fs/guide is not a memory; only memories can be forgotten.');
    expect(problemText(new ApiError(404, 'GONE', 'That run ended.'))).toBe('That run ended.');
    expect(problemText(new ApiError(400, 'BAD', 'body.name: expected string'), 'Fallback.')).toBe('Fallback.');
    expect(problemText(new ApiError(418, 'TEAPOT'), 'Fallback.')).toBe('Fallback.');
    expect(problemText(new DOMException('x', 'AbortError'))).toBe('Cancelled.');
    expect(problemText(new Error('raw'))).toBe('Something went wrong. Try again.');
  });

  it('gives one message per field', () => {
    const schema = z.object({ a: z.string().max(2), b: z.number().min(3), c: z.url(), d: z.string().min(1) });
    const checked = checkForm(schema, { a: 'long', b: 1, c: 'x', d: '' });
    expect(checked).toEqual({ ok: false, problems: { a: 'At most 2 characters.', b: 'At least 3.', c: 'Enter a web address.', d: 'Required.' } });
    expect(checkForm(schema, { a: 'ok', b: 3, c: 'https://x.y', d: 'z' }).ok).toBe(true);
  });
});
