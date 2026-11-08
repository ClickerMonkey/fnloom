/**
 * A stand-in hub for building and checking the web app before the real hub runs. Sign-in is real: the single admin
 * account, passwords checked, signed access tokens through `@ayepi/auth`'s bearer middleware, refresh and the
 * WebSocket all work. The inbox is real too: a list in memory, marked read for real, and (with
 * `HARNESS_MOCK_NOTIFY_EVERY`) a new notification pushed on the `user` channel every so often. The chat is a scripted
 * stand-in (`mockChat.ts`): sessions, history, streamed answers with live runs, approvals and the inspectors. The admin
 * pages are backed by `mockAdmin.ts` (systems, pairing, output, models, limits, policies, settings and the browsers,
 * with `HARNESS_MOCK_LOG_EVERY` writing an output line every so often). Every other endpoint answers with
 * `@ayepi/mock`'s generated, schema-valid data.
 *
 * Run: npm run mock-hub -w @harness/web   (then `npm run dev -w @harness/web` with HARNESS_PORT set to its port)
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { implement, server } from '@ayepi/core';
import { bearerAuth, signJwt } from '@ayepi/auth/server';
import { env } from '@ayepi/env';
import { mockHandlers } from '@ayepi/mock';
import { createRequestListener, handleUpgrade } from '@ayepi/node';
import { telemetry } from '@ayepi/otel/server';
import {
  AccessClaims, DEFAULT_PORTS, IDS, Port, Notification, UserView, adminOnly, hubAuth, mintId, tel, type ActorId, type NotificationReason, type Tokens,
} from '@harness/core';
import { z } from 'zod';
import { hubWebSpec } from '@harness/core';
import { MockAdmin } from './mockAdmin.ts';
import { MockChat } from './mockChat.ts';

/** The mock hub's settings. */
export const mockHubEnv = env({
  HARNESS_MOCK_PORT: Port.default(DEFAULT_PORTS.mockHub),
  /** Start as a new hub that still needs its admin account. */
  HARNESS_MOCK_NEEDS_ADMIN: z.boolean().default(false),
  /** Push a new notification this often (ms); 0 never does. */
  HARNESS_MOCK_NOTIFY_EVERY: z.number().int().min(0).default(0),
  /** The installed system writes an output line this often (ms); 0 never does. */
  HARNESS_MOCK_LOG_EVERY: z.number().int().min(0).default(2_000),
});

/** The admin account the mock hub starts with (unless it starts needing one). */
export const MOCK_ADMIN = { email: 'admin@harness.test', password: 'harness-admin-1', name: 'Ada Admin' } as const;

const SECRET = 'mock-hub-secret-not-for-real-use';
const ACCESS_FOR = 15 * 60_000;
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

interface Account { readonly user: UserView; password: string }

/** What the mock hub keeps. */
class MockState {
  account: Account | undefined;
  readonly refreshTokens = new Map<string, ActorId>();
  notifications: Notification[];

  constructor(needsAdmin: boolean) {
    this.account = needsAdmin ? undefined : { user: this.#user(MOCK_ADMIN.name, MOCK_ADMIN.email), password: MOCK_ADMIN.password };
    const owner = this.account?.user.id ?? IDS.actor.parse('act_admin');
    this.notifications = SAMPLE.map((sample, i) => Notification.parse({
      id: `ntf_sample_${i}`, user: owner, read: i >= 3, pushed: false, createdAt: NOW - (i * 47 + 3) * 60_000, ...sample,
    }));
  }

  makeAdmin(name: string, email: string, password: string): Account {
    this.account = { user: this.#user(name, email), password };
    return this.account;
  }

  tokensFor(user: UserView): Tokens {
    const refresh = mintId('authSession');
    this.refreshTokens.set(refresh, user.id);
    const claims = AccessClaims.parse({ actor: user.id, session: refresh, version: 1 });
    const { token } = signJwt(claims, { secret: SECRET, expiresIn: ACCESS_FOR / 1_000 });
    return { access: token, refresh, expiresIn: ACCESS_FOR, user };
  }

  #user(name: string, email: string): UserView {
    return UserView.parse({ id: 'act_admin', kind: 'user', name, email, role: 'admin' });
  }
}

const SAMPLE: readonly { reason: NotificationReason; title: string; body: string; link: Record<string, string> }[] = [
  { reason: 'approval-needed', title: 'Approve writing 3 files', body: 'fs/write wants to change src/app.ts, src/main.ts and README.md.', link: { approval: 'apr_1' } },
  { reason: 'turn-finished', title: 'Your refactor is done', body: 'Renamed 14 symbols across 6 files. All tests pass.', link: { session: 'ses_refactor' } },
  { reason: 'pairing-requested', title: 'A system wants to pair', body: 'notes (v0.3.1) on ws://192.168.50.20 asked to connect.', link: { pairing: 'par_notes' } },
  { reason: 'replied', title: 'Chat agent replied', body: 'Here is the summary of the meeting notes you asked for.', link: { session: 'ses_meeting' } },
  { reason: 'system-disconnected', title: 'embedder went offline', body: 'Search falls back to words until it reconnects.', link: { system: 'embedder' } },
  { reason: 'spend-limit', title: 'Daily budget reached', body: 'This session used $2.00 of its $2.00 daily budget.', link: { session: 'ses_budget' } },
];

const SYSTEM_NAMES = ['fs', 'embedder', 'notes', 'calendar'] as const;

const LIVE: readonly { reason: NotificationReason; title: string; body: string }[] = [
  { reason: 'turn-finished', title: 'Build finished', body: 'vite build completed in 4.2s.' },
  { reason: 'input-needed', title: 'A run needs your answer', body: 'fs/move asks which folder to move the files to.' },
  { reason: 'replied', title: 'New reply', body: 'The agent answered your question about the router.' },
];

/** Build the mock hub app. */
export function mockHub(options: { needsAdmin: boolean }) {
  const state = new MockState(options.needsAdmin);
  const owner = (): ActorId => state.account?.user.id ?? IDS.actor.parse('act_admin');
  const chat = new MockChat(owner);
  const admin = new MockAdmin(chat, Date.now);

  const real = implement(hubWebSpec)
    .middleware(telemetry.server(tel, { level: 'debug' }))
    .middleware(bearerAuth.server(hubAuth, {
      secret: SECRET, claims: AccessClaims,
      toUser: (claims) => (state.account !== undefined && claims.actor === state.account.user.id ? state.account.user : null),
    }))
    .middleware(adminOnly, async (io) => io.next())
    .handlers({
      setup: () => ({ needsAdmin: state.account === undefined, name: 'Mock hub', version: '0.0.0-mock' }),
      createAdmin: ({ data }) => state.tokensFor(state.makeAdmin(data.name, data.email, data.password).user),
      signIn: ({ data, fail }) => {
        const account = state.account;
        if (account?.user.email !== data.email || account.password !== data.password) { return fail(401, { reason: 'Wrong email or password.' }); }
        return state.tokensFor(account.user);
      },
      refresh: ({ data }) => {
        const actor = state.refreshTokens.get(data.refresh);
        if (actor === undefined || state.account === undefined) { throw new Error('unknown refresh token'); }
        state.refreshTokens.delete(data.refresh);
        return state.tokensFor(state.account.user);
      },
      signOut: () => undefined,
      me: ({ user }) => user,
      notifications: ({ data }) => {
        const all = state.notifications.filter((n) => data.unread !== true || !n.read);
        const start = data.cursor === undefined ? 0 : Number(data.cursor);
        const end = start + (data.limit ?? 30);
        return { items: all.slice(start, end), ...(end < all.length ? { cursor: String(end) } : {}) };
      },
      readNotifications: ({ data }) => {
        const ids = new Set(data.ids);
        state.notifications = state.notifications.map((n) => (ids.has(n.id) ? { ...n, read: true } : n));
      },
      capabilities: () => chat.capabilities(),
      sessions: ({ data }) => ({ items: chat.list(data.search, data.archived ?? false) }),
      session: ({ data }) => chat.session(data.session),
      createSession: ({ data }) => chat.create(data.title),
      updateSession: ({ data }) => {
        const { session, title, archived, notify, systems } = data;
        return chat.update(session, { ...(title === undefined ? {} : { title }), ...(archived === undefined ? {} : { archived }), ...(notify === undefined ? {} : { notify }), ...(systems === undefined ? {} : { systems }) });
      },
      limits: ({ data }) => chat.limits(data.session),
      messages: ({ data }) => chat.page(data.session, data.cursor, data.limit ?? 50),
      send: ({ data }) => chat.send(data.session, data.parts, data.replyTo),
      invoke: ({ data }) => chat.invoke(data.session, data.fn, data.args),
      control: () => ({ pause: false, cancel: false, uncancellable: [], undoLastTurn: true }),
      background: () => ({ accepted: true }),
      undoTurn: ({ data }) => chat.undo(data.turn),
      tree: ({ data }) => chat.tree(data.turn),
      run: ({ data }) => chat.run(data.run),
      llmCall: ({ data }) => chat.llmCall(data.id),
      suggest: ({ data }) => (data.text.length < 12 ? [] : [
        { kind: 'fn' as const, name: 'fs/read_file' as const, description: 'Read a file', score: 0.82 },
        { kind: 'context' as const, name: 'fs/docs' as const, description: 'The design docs', score: 0.74 },
      ]),
      mentions: ({ data }) => chat.mentions(data.query),
      mentionHover: ({ data }) => chat.hover(data.target),
      waiting: ({ data }) => chat.waiting(data.session),
      approve: ({ data }) => chat.approve(data.approval, data.approve),
      presence: () => undefined,
      systems: () => admin.list(),
      system: ({ data }) => admin.system(data.system),
      pairings: () => admin.pairings,
      approvePairing: ({ data }) => admin.answerPairing(data.pairing, data.approve),
      createPairingToken: ({ data }) => ({ token: mintId('pairingToken'), expiresAt: Date.now() + data.expiresIn }),
      configureSystem: ({ data }) => admin.configure(data.system, data.config),
      enableSystem: ({ data }) => admin.enable(data.system, data),
      removeSystem: ({ data }) => admin.remove(data.system),
      installSystem: ({ data }) => admin.install(data.source, data.autoStart ?? true),
      startSystem: ({ data }) => admin.process(data.system, 'running'),
      stopSystem: ({ data }) => admin.process(data.system, 'stopped'),
      upgradeSystem: ({ data }) => admin.upgrade(data.system, data.version),
      reimport: () => admin.reimport(),
      systemFns: ({ data }) => admin.fns(data.system),
      systemLogs: ({ data }) => admin.output(data.system, data.limit),
      providers: () => admin.providers,
      configureProvider: ({ data }) => admin.saveProvider(data.provider),
      models: () => admin.models,
      modelCategories: () => admin.categories,
      setModelCategory: ({ data }) => admin.saveCategory(data),
      budgets: () => admin.budgets,
      setBudget: ({ data }) => admin.saveBudget(data, owner()),
      priorityRules: () => admin.priorities,
      setPriority: ({ data }) => admin.savePriority(data, owner()),
      resolveLimits: () => admin.resolve(),
      policies: () => admin.policies,
      setPolicy: ({ data }) => admin.savePolicy(data, owner()),
      removeRule: ({ data }) => admin.removeRule(data),
      actors: ({ data }) => admin.actorsOf(data),
      actorSettings: () => admin.settings,
      setActorSetting: ({ data }) => admin.setSetting(data.setting, data.actor, data.value, owner()),
      runs: ({ data }) => { const { cursor, limit, ...filter } = data; return admin.runs(filter, cursor, limit); },
      llmCalls: ({ data }) => { const { cursor, limit, ...filter } = data; return admin.llmCalls(filter, cursor, limit); },
      resources: ({ data }) => { const { cursor, limit, ...filter } = data; return admin.resourceList(filter, cursor, limit); },
      resource: ({ data }) => admin.read(data.uri),
    });

  // the endpoints `real` answers; server() fails to compile unless these and the generated rest cover every endpoint once
  const realNames = [
    'setup', 'createAdmin', 'signIn', 'refresh', 'signOut', 'me', 'notifications', 'readNotifications',
    'capabilities', 'sessions', 'session', 'createSession', 'updateSession', 'limits', 'messages', 'send', 'invoke', 'control', 'background', 'undoTurn',
    'tree', 'run', 'llmCall', 'suggest', 'mentions', 'mentionHover', 'waiting', 'approve', 'presence',
    'systems', 'system', 'pairings', 'approvePairing', 'createPairingToken', 'configureSystem', 'enableSystem', 'removeSystem', 'installSystem', 'startSystem',
    'stopSystem', 'upgradeSystem', 'reimport', 'systemFns', 'systemLogs', 'providers', 'configureProvider', 'models', 'modelCategories', 'setModelCategory',
    'budgets', 'setBudget', 'priorityRules', 'setPriority', 'resolveLimits', 'policies', 'setPolicy', 'removeRule', 'actors', 'actorSettings', 'setActorSetting',
    'runs', 'llmCalls', 'resources', 'resource',
  ] as const;
  // system names must match their pattern, which the generator can't read from a regex
  const systemName = (g: { rng: () => number }): string => SYSTEM_NAMES[Math.floor(g.rng() * SYSTEM_NAMES.length)] ?? 'fs';
  const overrides = { fields: { name: systemName, system: systemName } };
  const rest = implement(hubWebSpec).handlers(mockHandlers(hubWebSpec, { seed: 'harness-ui', now: () => NOW, overrides, except: realNames }));
  const app = server(hubWebSpec, [real, rest]);
  chat.attach((session, event) => { app.emit('session', { session }, event); });
  admin.attach({ user: (event) => { app.emit('user', event); }, log: (system, line) => { app.emit('systemLog', { system }, line); } });

  let live = 0;
  /** Push a new notification to every signed-in browser. */
  const notify = (): void => {
    const sample = LIVE[live++ % LIVE.length];
    if (sample === undefined) { return; }
    const notification = Notification.parse({
      id: mintId('notification'), user: owner(), reason: sample.reason, title: sample.title, body: sample.body,
      link: { session: 'ses_live' }, read: false, pushed: false, createdAt: Date.now(),
    });
    state.notifications = [notification, ...state.notifications];
    app.emit('user', { type: 'notification', notification });
  };

  return { app, notify, tick: () => { admin.tick(); } };
}

/** Serve the mock hub on `port`: the API under `/api` (as the real hub serves it) and the socket at `/ws`. */
export function serveMockHub(port: number, options: { needsAdmin: boolean; notifyEvery: number; logEvery?: number }): { stop: () => Promise<void>; notify: () => void } {
  const { app, notify, tick } = mockHub(options);
  const listener = createRequestListener(app);
  const httpServer = http.createServer((req, res) => {
    req.url = (req.url ?? '/').replace(/^\/api(?=\/|$)/, '') || '/';
    listener(req, res);
  });
  const sockets = handleUpgrade(app, httpServer, { path: '/ws' });
  const timer = options.notifyEvery > 0 ? setInterval(notify, options.notifyEvery) : undefined;
  const ticker = (options.logEvery ?? 0) > 0 ? setInterval(tick, options.logEvery) : undefined;
  httpServer.listen(port, '0.0.0.0', () => { console.info('mock.hub.ready', { port, admin: MOCK_ADMIN.email }); });
  return {
    notify,
    stop: () => new Promise<void>((resolve, reject) => {
      clearInterval(timer);
      clearInterval(ticker);
      for (const ws of sockets.clients) { ws.terminate(); }
      sockets.close(() => { httpServer.close((error) => { if (error) { reject(error); } else { resolve(); } }); });
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const settings = mockHubEnv.parse();
  const hub = serveMockHub(settings.HARNESS_MOCK_PORT, { needsAdmin: settings.HARNESS_MOCK_NEEDS_ADMIN, notifyEvery: settings.HARNESS_MOCK_NOTIFY_EVERY, logEvery: settings.HARNESS_MOCK_LOG_EVERY });
  const stop = (): void => { void hub.stop().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
