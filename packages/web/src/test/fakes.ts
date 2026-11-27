/**
 * Test doubles for the web app: callers that answer from a function and record their calls, an in-memory storage,
 * a connection whose status a test sets, and a full set of stores built on them.
 */
import type { CallArgs, CallReturn } from '@ayepi/core';
import { ActorId, Notification, Tokens, type HttpsView, type SystemPageView, type UserEvent } from '@harness/core';
import type { HubWebSpec } from '@harness/core';
import { createHub, type CallerOf, type Connection, type Endpoint } from '../api/client.ts';
import { SessionKeeper, SignInForm } from '../state/auth.ts';
import { AccountStore } from '../state/account.ts';
import { ConnectionStore } from '../state/connection.ts';
import { PushStore, type PushKeys, type PushPlatform } from '../state/push.ts';
import { HttpsStore } from '../state/https.ts';
import { InstallStore, type InstallPlatform, type InstallPrompt } from '../state/install.ts';
import { InboxStore } from '../state/inbox.ts';
import { LayoutStore } from '../state/layout.ts';
import type { KeyValueStore } from '../state/persisted.ts';
import { SessionStore } from '../state/session.ts';
import type { Stores } from '../state/stores.ts';
import { ThemeStore, type DeviceQuery } from '../state/theme.ts';
import { Toasts } from '../state/toasts.ts';
import { fakeChat } from '../chat/test/fakes.ts';
import { fakeAdmin } from '../admin/test/fakes.ts';
import { fakeResources } from '../resources/test/fakes.ts';
import { fakeContext } from '../context/test/fakes.ts';
import { fakeFnsApi } from '../fns/test/fakes.ts';
import { FnInfoStore } from '../fns/state/fn-info.ts';
import { FnNotices } from '../fns/state/fn-notices.ts';
import { ModelNamesStore } from '../fns/state/model-names.ts';
import { DataStore } from '../data/state/data.ts';
import { fakeDataApi } from '../data/test/fakes.ts';
import { IdentityStore } from '../state/identity.ts';
import { OutsideImagesStore } from '../state/outside-images.ts';
import { GraphStore } from '../graph/state/graph.ts';
import { RunPageStore } from '../runs/store.ts';
import { fakeGraphApi } from '../graph/test/fakes.ts';
import { ClientLogs } from '../state/client-logs.ts';
import { SystemPagesStore } from '../system-pages/store.ts';

type EndpointOf<K extends Endpoint> = HubWebSpec['endpoints'][K];

/** A caller of endpoint `K` that answers with `impl` and keeps every call's arguments in `calls`. */
export interface FakeCaller<K extends Endpoint> extends CallerOf<K> {
  readonly calls: CallArgs<EndpointOf<K>>[];
}

/** Make a fake caller for endpoint `K`. */
export function fakeCaller<K extends Endpoint>(impl: (...args: CallArgs<EndpointOf<K>>) => CallReturn<EndpointOf<K>>): FakeCaller<K> {
  const calls: CallArgs<EndpointOf<K>>[] = [];
  return {
    calls,
    call: (...args) => { calls.push(args); return impl(...args); },
    cancel: () => undefined,
    invalidate: () => undefined,
    pending: 0,
  };
}

/**
 * Answers held back the way a `lastOnly` caller holds them: `next(result)` is an answer still on its way, which
 * resolves when the test settles it (`settle`, oldest first). A newer `next`, or `cancel`, makes the answers still
 * waiting reject with an `AbortError`, as a superseded or cancelled call does. Give a fake caller `next` as its answer
 * and `cancel` as its cancel.
 */
export function supersedingAnswers<R>(): { readonly next: (result: R) => Promise<R>; readonly cancel: () => void; readonly settle: () => Promise<void> } {
  const waiting: Array<{ go: () => void; stop: (error: unknown) => void }> = [];
  const cancel = (): void => { for (const w of waiting.splice(0)) { w.stop(new DOMException('superseded', 'AbortError')); } };
  return {
    next: (result) => {
      cancel();
      return new Promise<R>((resolve, reject) => { waiting.push({ go: () => { resolve(result); }, stop: reject }); });
    },
    cancel,
    settle: async () => { waiting.shift()?.go(); await Promise.resolve(); },
  };
}

/** A caller of endpoint `K` that fails every call with `error`. */
export function failingCaller<K extends Endpoint>(error: unknown): FakeCaller<K> {
  return fakeCaller<K>(() => { throw error; });
}

/** Storage backed by a map. */
export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

/** A connection whose status the test sets with `set`. */
export function fakeConnection(initial: 'online' | 'offline' = 'online'): Connection & { set(status: 'online' | 'offline'): void } {
  let status = initial;
  const listeners = new Set<(status: 'online' | 'offline') => void>();
  return {
    get status() { return status; },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: (next) => { status = next; for (const listener of listeners) { listener(next); } },
  };
}

/** A media query list whose `matches` the test sets with `set`. */
export function fakeMedia(matches = false): { media: () => DeviceQuery; set(matches: boolean): void } {
  let current = matches;
  const listeners = new Set<(event: { readonly matches: boolean }) => void>();
  const list: DeviceQuery = {
    get matches() { return current; },
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
  };
  return {
    media: () => list,
    set: (next) => { current = next; for (const listener of listeners) { listener({ matches: next }); } },
  };
}

/** Tokens for a signed-in admin. */
export function tokens(overrides: Partial<Tokens> = {}): Tokens {
  return Tokens.parse({
    access: 'access.token', refresh: 'refresh-token', expiresIn: 900_000,
    user: { id: 'act_ada', kind: 'user', name: 'Ada Lovelace', email: 'ada@example.com', role: 'admin' },
    ...overrides,
  });
}

let nextNotification = 1;
/** A notification, parsed through the hub's schema so its ids are the real branded types. */
export function notification(overrides: Partial<Record<keyof Notification, unknown>> = {}): Notification {
  const n = nextNotification++;
  return Notification.parse({
    id: `ntf_${n}`, user: 'act_ada', reason: 'turn-finished', title: `Notification ${n}`, body: 'Done.', link: { session: 'ses_1' },
    read: false, pushed: false, createdAt: 1_700_000_000_000 + n, ...overrides,
  });
}

/** The callers the stores use, each answering with a sensible default. */
export function fakeApi() {
  return {
    auth: {
      setup: fakeCaller<'setup'>(() => Promise.resolve({ needsAdmin: false, name: 'Test hub', version: '1.0.0', sso: [] })),
      createAdmin: fakeCaller<'createAdmin'>(() => Promise.resolve(tokens())),
      signIn: fakeCaller<'signIn'>(() => Promise.resolve(tokens())),
      refresh: fakeCaller<'refresh'>(() => Promise.resolve(tokens({ access: 'access.fresh' }))),
      redeemSso: fakeCaller<'redeemSso'>(() => Promise.resolve(tokens({ access: 'access.sso' }))),
      signOut: fakeCaller<'signOut'>(() => Promise.resolve()),
      me: fakeCaller<'me'>(() => Promise.resolve(tokens().user)),
      account: fakeCaller<'account'>(() => Promise.resolve({
        ...tokens().user, disabled: false, createdAt: 0, breakGlass: false, password: false,
        identities: [{ provider: 'acme', label: 'Acme', email: tokens().user.email, lastSignInAt: 0 }], groups: [{ id: ActorId.parse('act_team'), name: 'Team', synced: true }],
      })),
    },
    identity: {
      identity: fakeCaller<'identity'>(() => Promise.resolve({ name: 'Test hub', source: 'setting' as const, version: '1.0.0' })),
      setHubName: fakeCaller<'setHubName'>(({ name }) => Promise.resolve({ name: name ?? 'Harness', source: name === null ? 'default' as const : 'setting' as const, version: '1.0.0' })),
    },
    outsideImages: {
      outsideImages: fakeCaller<'outsideImages'>(() => Promise.resolve({ value: 'ask' as const })),
      setOutsideImages: fakeCaller<'setOutsideImages'>(({ value }) => Promise.resolve({ value, setBy: tokens().user.id, updatedAt: 1 })),
    },
    https: {
      https: fakeCaller<'https'>(() => Promise.resolve(HTTPS_VIEW)),
      setHttps: fakeCaller<'setHttps'>(({ on }) => Promise.resolve({ ...HTTPS_VIEW, on, links: on ? HTTPS_VIEW.links : [], setBy: tokens().user.id, updatedAt: 1 })),
    },
    notifications: {
      list: fakeCaller<'notifications'>(() => Promise.resolve({ items: [] })),
      markRead: fakeCaller<'readNotifications'>(() => Promise.resolve()),
      pushKey: fakeCaller<'pushKey'>(() => Promise.resolve({ publicKey: 'BPub_key-1' })),
      subscribePush: fakeCaller<'subscribePush'>(() => Promise.resolve({ id: 'psh_1' })),
    },
  };
}

/** A user-event channel a test pushes events into. */
export function fakeUserEvents(): { subscribe: (listener: (event: UserEvent) => void) => () => void; push(event: UserEvent): void; readonly listeners: number } {
  const listeners = new Set<(event: UserEvent) => void>();
  return {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    push: (event) => { for (const listener of listeners) { listener(event); } },
    get listeners() { return listeners.size; },
  };
}

/** A browser's push side, as a test sets it up: what it supports, what the person answers, its subscription. */
export function fakePush(options: { supported?: boolean; answer?: NotificationPermission } = {}): PushPlatform & { permissionNow: NotificationPermission; subscription: PushKeys | undefined } {
  const state: { permissionNow: NotificationPermission; subscription: PushKeys | undefined } = { permissionNow: 'default', subscription: undefined };
  const platform = {
    ...state,
    supported: () => options.supported ?? true,
    permission: () => platform.permissionNow,
    current: () => Promise.resolve(platform.subscription),
    subscribe: (publicKey: string) => {
      platform.permissionNow = options.answer ?? 'granted';
      platform.subscription = platform.permissionNow === 'granted' ? { endpoint: `https://push.example/${publicKey}`, keys: { p256dh: 'p', auth: 'a' } } : undefined;
      return Promise.resolve(platform.subscription);
    },
    unsubscribe: () => { platform.subscription = undefined; return Promise.resolve(); },
  };
  return platform;
}

/** What the fake hub says about its https: on, its own authority, two addresses. */
export const HTTPS_VIEW: HttpsView = {
  on: true, source: 'own', host: 'bagend', fingerprint: 'AB:CD', authorityName: 'Hub authority on bagend', links: ['https://192.168.50.113:4300/', 'https://100.114.88.91:4300/'],
};

/** A browser's install side, as a test sets it up: secure or not, an iPhone or not, installed or not, and its prompt. */
export function fakeInstall(options: { secure?: boolean; ios?: boolean; standalone?: boolean } = {}) {
  const prompts = new Set<(prompt: InstallPrompt) => void>();
  const changes = new Set<() => void>();
  const state: { standalone: boolean; prompted: number; answer: 'accepted' | 'dismissed' } = { standalone: options.standalone ?? false, prompted: 0, answer: 'accepted' };
  const platform = {
    state,
    standalone: () => state.standalone,
    secure: () => options.secure ?? true,
    ios: () => options.ios ?? false,
    onPrompt: (listener: (prompt: InstallPrompt) => void) => { prompts.add(listener); return () => { prompts.delete(listener); }; },
    onChange: (listener: () => void) => { changes.add(listener); return () => { changes.delete(listener); }; },
    /** The browser offers its prompt. */
    offer: () => {
      const prompt: InstallPrompt = { prompt: () => { state.prompted++; return Promise.resolve(); }, get userChoice() { return Promise.resolve({ outcome: state.answer }); } };
      for (const listener of prompts) { listener(prompt); }
    },
    /** The app was installed and now runs standalone. */
    installed: () => { state.standalone = true; for (const listener of changes) { listener(); } },
  } satisfies InstallPlatform & Record<string, unknown>;
  return platform;
}

/**
 * The system pages store on a fake list. Its hub client is a real one that is never called (its socket opens on the first
 * call), for pages that only pass it along.
 */
export function fakePages(list: readonly SystemPageView[] = [], events = fakeUserEvents()) {
  const answer = { list: [...list] };
  const systemPages = fakeCaller<'systemPages'>(() => Promise.resolve(answer.list));
  const pages = new SystemPagesStore({ api: { systemPages }, events: events.subscribe, hub: createHub({ origin: 'http://hub.test', token: () => '' }).hub });
  return { pages, systemPages, events, answer };
}

/** Every store, built on fakes. `signedIn` starts the session signed in. */
export function fakeStores(options: { signedIn?: boolean; api?: ReturnType<typeof fakeApi>; admin?: ReturnType<typeof fakeAdmin>; pages?: readonly SystemPageView[]; install?: InstallPlatform } = {}) {
  const store = memoryStore();
  const api = options.api ?? fakeApi();
  const events = fakeUserEvents();
  const connection = fakeConnection();
  const session = new SessionStore(store);
  if (options.signedIn === true) { session.keep(tokens()); }
  const chat = fakeChat();
  const admin = options.admin ?? fakeAdmin();
  const resources = fakeResources();
  const context = fakeContext();
  const fns = fakeFnsApi();
  const data = fakeDataApi();
  const pages = fakePages(options.pages ?? [], events);
  const stores: Stores = {
    session,
    identity: new IdentityStore(api.identity, events.subscribe, store),
    outsideImages: new OutsideImagesStore(api.outsideImages),
    keeper: new SessionKeeper(api.auth, session),
    theme: new ThemeStore({ store, media: fakeMedia().media, root: document.documentElement }),
    layout: new LayoutStore(store),
    toasts: new Toasts(),
    inbox: new InboxStore(api.notifications, events.subscribe),
    connection: new ConnectionStore(connection),
    chat: chat.chat,
    admin: admin.admin,
    signInForm: () => new SignInForm(api.auth, session),
    account: new AccountStore(api.auth),
    resources: resources.resources,
    context: context.context,
    fns: new FnInfoStore(fns, events.subscribe),
    fnNotices: new FnNotices(fns),
    modelNames: new ModelNamesStore(fns),
    graph: () => new GraphStore(fakeGraphApi()),
    runPage: () => new RunPageStore(chat.api),
    data: new DataStore(data),
    pages: pages.pages,
    itemVersions: (query) => data.itemVersions.call(query),
    logs: new ClientLogs({ send: fakeCaller<'clientLogs'>(() => Promise.resolve({ uri: 'hub://logs/test.jsonl', written: 1 })), signedIn: () => false, page: () => '/' }),
    push: new PushStore(api.notifications, fakePush(), () => 'Test browser'),
    install: new InstallStore(options.install ?? fakeInstall()),
    https: new HttpsStore(api.https),
  };
  return { stores, api, events, connection, store, chat, admin, resources, context, fns, data, pages };
}
