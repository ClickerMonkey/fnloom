/**
 * The composition root: the one hub client, its callers and every store, built for a browser window. Nothing else
 * makes a client; stores get only the callers they use.
 */
import { HttpMcpProbe } from '../admin/probe.ts';
import { AdminStore } from '../admin/state/admin.ts';
import { createApi } from '../api/index.ts';
import { XhrFileSender } from '../chat/api.ts';
import { browserClient, ChatStore } from '../chat/state/chat.ts';
import { browserSpeech, MediaRecorderSource } from '../chat/state/voice.ts';
import { createHub } from '../api/client.ts';
import { withTraffic } from '../api/traffic.ts';
import { ClientLogs, clientLogsCaller } from '../state/client-logs.ts';
import { BrowserLock, SessionKeeper, SignInForm } from '../state/auth.ts';
import { ConnectionStore } from '../state/connection.ts';
import { InboxStore } from '../state/inbox.ts';
import { LayoutStore } from '../state/layout.ts';
import { BrowserPush, PushStore, SERVICE_WORKERS } from '../state/push.ts';
import { windowStorageChanges } from '../state/persisted.ts';
import { cookieMark, SessionStore } from '../state/session.ts';
import { ResourcesStore } from '../resources/state/resources.ts';
import { ContextStore } from '../context/state/context.ts';
import { FnInfoStore } from '../fns/state/fn-info.ts';
import { GraphStore } from '../graph/state/graph.ts';
import type { Stores } from '../state/stores.ts';

/** The stores that fetch again after a reconnect. */
export type ResyncStores = Pick<Stores, 'session' | 'connection' | 'inbox' | 'chat' | 'admin'>;

/**
 * Fetch again whatever may have changed while the hub was unreachable (events sent meanwhile are lost): the inbox,
 * the chat (its list and the open thread: messages, runs and what waits on the person), and the systems list once
 * an admin page has loaded it. Returns the function that stops.
 */
export function resyncOnReconnect(stores: ResyncStores): () => void {
  return stores.connection.onReconnect(() => {
    if (!stores.session.signedIn.value) { return; }
    void stores.inbox.refresh();
    void stores.chat.refresh();
    if (stores.admin.systems.list.value.value !== undefined) { void stores.admin.systems.load(true); }
  });
}
import { ThemeStore } from '../state/theme.ts';
import { Toasts } from '../state/toasts.ts';

/** Build the app's stores for `win`. */
export function createStores(win: Window): Stores {
  const session = new SessionStore(win.localStorage, Date.now, windowStorageChanges(win), cookieMark(win.document));
  const { hub: plain } = createHub({ origin: win.location.origin, token: () => session.accessToken.value, unauthorized: () => keeper.recover() });
  // the logs go out through the plain client, so sending them is never itself traffic
  const logs = new ClientLogs({ send: clientLogsCaller(plain), signedIn: () => session.signedIn.value, page: () => win.location.pathname });
  logs.watch(win);
  const hub = withTraffic(plain, (call) => { logs.traffic(call); });
  const api = createApi(hub);
  const keeper = new SessionKeeper(api.auth, session, Date.now, new BrowserLock(win.navigator));
  const connection = new ConnectionStore(api.connection);
  const inbox = new InboxStore(api.notifications, api.userEvents);
  const chat = new ChatStore({
    api: api.chat, userEvents: api.userEvents, sessionEvents: api.sessionEvents, store: win.localStorage, sender: new XhrFileSender(),
    clock: Date.now, client: () => browserClient(), me: () => session.user.value?.id,
    recorder: () => (MediaRecorderSource.available() ? new MediaRecorderSource() : undefined),
    speech: () => browserSpeech(win),
    renderers: { share: async () => { (await import('../chat/shared.ts')).shareChatModules(); } },
  });
  const admin = new AdminStore({
    api: api.admin, chat: api.chat, userEvents: api.userEvents, systemLogs: api.systemLogs, sender: new XhrFileSender(),
    probe: new HttpMcpProbe((url, init) => win.fetch(url, init)),
  });
  const runtime = chat.renderers.runtime;
  const resources = new ResourcesStore({
    api: api.resources, events: api.resourceEvents, sender: new XhrFileSender(), fetch: (url, init) => win.fetch(url, init),
    systems: { viewers: (format) => runtime.resourceViewers(format), client: (system) => runtime.systemClient(system), version: chat.renderers.version },
    prepare: () => chat.prepareRenderers(),
  });
  resyncOnReconnect({ session, connection, inbox, chat, admin });
  return {
    session,
    keeper,
    theme: new ThemeStore({ store: win.localStorage, media: (query) => win.matchMedia(query), root: win.document.documentElement }),
    layout: new LayoutStore(win.localStorage),
    toasts: new Toasts(),
    inbox,
    connection,
    chat,
    admin,
    signInForm: () => new SignInForm(api.auth, session, win.localStorage),
    resources,
    context: new ContextStore({ api: api.context, events: api.contextEvents }),
    fns: new FnInfoStore(api.fns, api.userEvents),
    graph: () => new GraphStore(api.graph),
    logs,
    push: new PushStore(api.notifications, new BrowserPush(win, import.meta.env.DEV ? SERVICE_WORKERS.source : SERVICE_WORKERS.built), () => win.navigator.userAgent),
  };
}
