/**
 * Every page is a URL, so a refresh returns to the same place: the chat and its session, the inbox and its filter,
 * each settings section, the admin pages and the system being looked at. Route names and the values a URL part may
 * take are defined here once; links are made with `links` so they can't point at a page that doesn't exist. Each
 * page's query is declared once too (`QUERIES`): links take its input, and pages read its keys (`useRouteQuery`), so a
 * renamed or misspelled key breaks both at compile time.
 */
import {
  LlmInteractionId, LlmStatus, NotificationId, PairingId, ResourceUri, RunId, RunStatus, SessionId, TurnId, type MessageId, type NotificationLink, type SystemName,
} from '@harness/core';
import type { RouteLocationRaw, RouteRecordRaw } from 'vue-router';
import { z } from 'zod';
import { LimitsTab, ModelsTab, SystemTab } from '../admin/sections.ts';
import { LlmCallTab, RunTab, TAB_KEYS } from '../chat/logic/inspect.ts';
import { InboxFilter } from '../state/inbox.ts';
import { OPEN_KEY } from '../state/push-payload.ts';

declare module 'vue-router' {
  interface RouteMeta {
    /** Reachable signed out. */
    public?: boolean;
    /** Drawn without the shell's navigation. */
    bare?: boolean;
    /** The page's name in the tab title. */
    title?: string;
    /** Only admins may open it (set on the admin area's parent route). */
    admin?: boolean;
    /** Routes of one group share their page: moving between them keeps it mounted (the chat's list, session and tree). */
    group?: string;
    /** The page draws its own header with the navigation button, so a compact shell shows no top bar over it (an open chat). */
    ownHeader?: boolean;
  }
}

/** The route names. */
export const ROUTES = {
  signIn: 'sign-in',
  chat: 'chat',
  session: 'session',
  turnTree: 'turn-tree',
  inbox: 'inbox',
  admin: 'admin',
  systems: 'systems',
  system: 'system',
  models: 'models',
  limits: 'limits',
  policies: 'policies',
  actorSettings: 'actor-settings',
  runs: 'runs',
  llmCalls: 'llm-calls',
  resources: 'resources',
  settings: 'settings',
  design: 'design',
  notFound: 'not-found',
} as const;
export type RouteName = (typeof ROUTES)[keyof typeof ROUTES];

/** The settings sections, each its own URL. */
export const SettingsSection = z.enum(['appearance', 'notifications', 'account']);
export type SettingsSection = z.infer<typeof SettingsSection>;

/** The panels a chat can have open besides inspectors. */
export const ChatPanel = z.enum(['settings', 'people', 'model']);
export type ChatPanel = z.infer<typeof ChatPanel>;

/** Which chats the list shows. */
export const ChatsView = z.enum(['active', 'archived']);
export type ChatsView = z.infer<typeof ChatsView>;

/**
 * The chat's query, shared by the list, a session and a turn's tree: the list's search (`q`) and view (`chats`), the
 * panels open over a session (a run, an LLM call, an answer's turn details, a resource, settings), and their tabs.
 */
const CHAT_QUERY = z.object({
  q: z.string(), chats: ChatsView,
  run: RunId, llm: LlmInteractionId, details: TurnId, resource: ResourceUri, panel: ChatPanel,
  [TAB_KEYS.run]: RunTab, [TAB_KEYS.llm]: LlmCallTab,
}).partial();

/** Each page's query keys and the values they take; a page without an entry takes no query. */
export const QUERIES = {
  [ROUTES.signIn]: z.object({ next: z.string() }).partial(),
  [ROUTES.chat]: CHAT_QUERY,
  [ROUTES.session]: CHAT_QUERY,
  [ROUTES.turnTree]: CHAT_QUERY,
  [ROUTES.inbox]: z.object({ filter: InboxFilter, [OPEN_KEY]: NotificationId }).partial(),
  [ROUTES.systems]: z.object({ pairing: PairingId }).partial(),
  [ROUTES.models]: z.object({ q: z.string() }).partial(),
  [ROUTES.limits]: z.object({ user: z.string(), session: SessionId }).partial(),
  [ROUTES.runs]: z.object({ status: RunStatus, fn: z.string(), system: z.string(), session: SessionId, run: RunId, [TAB_KEYS.run]: RunTab }).partial(),
  [ROUTES.llmCalls]: z.object({ status: LlmStatus, model: z.string(), system: z.string(), session: SessionId, call: LlmInteractionId, [TAB_KEYS.llm]: LlmCallTab }).partial(),
  [ROUTES.resources]: z.object({ q: z.string(), system: z.string(), uri: ResourceUri }).partial(),
} as const satisfies Partial<Record<RouteName, z.ZodObject>>;

/** The pages that take a query. */
export type QueryRoute = keyof typeof QUERIES;
/** A page's query, as a link writes it. */
export type RouteQuery<R extends QueryRoute> = z.input<(typeof QUERIES)[R]>;
/** One of a page's query keys. */
export type QueryKey<R extends QueryRoute> = keyof RouteQuery<R> & string;

/** A page's query for a link: checked with its schema, keys with no value left out, and no query at all when empty. */
function queryOf<R extends QueryRoute>(route: R, query: RouteQuery<R>): { readonly query?: Readonly<Record<string, string>> } {
  const entries = Object.entries(QUERIES[route].parse(query)).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value] as const] : []));
  return entries.length === 0 ? {} : { query: Object.fromEntries(entries) };
}

/** The design gallery's sections. */
export const DesignSection = z.enum(['actions', 'inputs', 'overlays', 'feedback', 'content']);
export type DesignSection = z.infer<typeof DesignSection>;

/** Links to every page. */
export const links = {
  signIn: (next?: string): RouteLocationRaw => ({ name: ROUTES.signIn, ...queryOf(ROUTES.signIn, { next }) }),
  chat: (): RouteLocationRaw => ({ name: ROUTES.chat }),
  session: (session: SessionId): RouteLocationRaw => ({ name: ROUTES.session, params: { session } }),
  /** A message in a session: the thread scrolls to it and lights it briefly. */
  message: (session: SessionId, message: MessageId): RouteLocationRaw => ({ name: ROUTES.session, params: { session }, hash: `#m-${message}` }),
  /** A turn's fn tree, over its session. */
  turnTree: (session: SessionId, turn: TurnId): RouteLocationRaw => ({ name: ROUTES.turnTree, params: { session, turn } }),
  inbox: (filter: InboxFilter = 'all'): RouteLocationRaw => ({ name: ROUTES.inbox, ...queryOf(ROUTES.inbox, filter === 'all' ? {} : { filter }) }),
  /** The systems page; `pairing` picks out a pairing request. */
  systems: (query: RouteQuery<typeof ROUTES.systems> = {}): RouteLocationRaw => ({ name: ROUTES.systems, ...queryOf(ROUTES.systems, query) }),
  /** A system's page, on one of its tabs (the overview's URL has no tab). */
  system: (name: SystemName, tab: SystemTab = 'overview'): RouteLocationRaw => ({ name: ROUTES.system, params: tab === 'overview' ? { name } : { name, tab } }),
  models: (tab: ModelsTab = 'providers'): RouteLocationRaw => ({ name: ROUTES.models, params: tab === 'providers' ? {} : { tab } }),
  limits: (tab: LimitsTab = 'budgets'): RouteLocationRaw => ({ name: ROUTES.limits, params: tab === 'budgets' ? {} : { tab } }),
  policies: (): RouteLocationRaw => ({ name: ROUTES.policies }),
  actorSettings: (): RouteLocationRaw => ({ name: ROUTES.actorSettings }),
  /** The runs browser; `query` narrows it (`status`, `fn`, `system`, `session`) or opens one (`run`). */
  runs: (query: RouteQuery<typeof ROUTES.runs> = {}): RouteLocationRaw => ({ name: ROUTES.runs, ...queryOf(ROUTES.runs, query) }),
  /** The LLM calls browser; `query` narrows it (`status`, `model`, `system`, `session`) or opens one (`call`). */
  llmCalls: (query: RouteQuery<typeof ROUTES.llmCalls> = {}): RouteLocationRaw => ({ name: ROUTES.llmCalls, ...queryOf(ROUTES.llmCalls, query) }),
  /** The resources browser; `query` narrows it (`q`, `system`) or opens one (`uri`). */
  resources: (query: RouteQuery<typeof ROUTES.resources> = {}): RouteLocationRaw => ({ name: ROUTES.resources, ...queryOf(ROUTES.resources, query) }),
  settings: (section: SettingsSection = 'appearance'): RouteLocationRaw => ({ name: ROUTES.settings, params: { section } }),
  design: (section: DesignSection = 'actions'): RouteLocationRaw => ({ name: ROUTES.design, params: { section } }),
} as const;

/** Where to go after sign-in: only a path in this app, never another site. */
export function safeNext(next: unknown): string | undefined {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : undefined;
}

/** Finds the chat a run belongs to, if any. */
export type SessionOfRun = (run: RunId) => Promise<SessionId | undefined>;

/**
 * Where a notification leads. A run in a chat leads to that chat, where its question or approval waits in the dock
 * and is answered; a run outside any chat opens in the runs browser. An approval leads to the runs waiting on one.
 */
export async function notificationTarget(link: NotificationLink, sessionOf: SessionOfRun): Promise<RouteLocationRaw> {
  if ('session' in link) { return links.session(link.session); }
  if ('system' in link) { return links.system(link.system); }
  if ('pairing' in link) { return links.systems({ pairing: link.pairing }); }
  if ('approval' in link) { return links.runs({ status: 'awaiting-approval' }); }
  const session = await sessionOf(link.run).catch(() => undefined);
  return session === undefined ? links.runs({ run: link.run }) : links.session(session);
}

/** A path pattern matching one of an enum's values. */
const tabs = (schema: { readonly options: readonly string[] }): string => schema.options.join('|');

/** The route table. Pages load on first visit. */
export const routes: RouteRecordRaw[] = [
  { path: '/sign-in', name: ROUTES.signIn, component: () => import('../pages/SignInPage.vue'), meta: { public: true, bare: true, title: 'Sign in' } },
  { path: '/', redirect: { name: ROUTES.chat } },
  { path: '/chat', name: ROUTES.chat, component: () => import('../pages/ChatPage.vue'), meta: { title: 'Chat', group: 'chat' } },
  { path: '/chat/:session', name: ROUTES.session, component: () => import('../pages/ChatPage.vue'), meta: { title: 'Chat', group: 'chat', ownHeader: true } },
  { path: '/chat/:session/turn/:turn/tree', name: ROUTES.turnTree, component: () => import('../pages/ChatPage.vue'), meta: { title: 'Run tree', group: 'chat', ownHeader: true } },
  { path: '/inbox', name: ROUTES.inbox, component: () => import('../pages/InboxPage.vue'), meta: { title: 'Inbox' } },
  {
    path: '/admin', component: () => import('../admin/views/AdminLayout.vue'), meta: { admin: true },
    children: [
      { path: '', name: ROUTES.admin, redirect: { name: ROUTES.systems } },
      { path: 'systems', name: ROUTES.systems, component: () => import('../admin/views/SystemsView.vue'), meta: { title: 'Systems' } },
      { path: `systems/:name/:tab(${tabs(SystemTab)})?`, name: ROUTES.system, component: () => import('../admin/views/SystemView.vue'), meta: { title: 'System' } },
      { path: `models/:tab(${tabs(ModelsTab)})?`, name: ROUTES.models, component: () => import('../admin/views/ModelsView.vue'), meta: { title: 'Models' } },
      { path: `limits/:tab(${tabs(LimitsTab)})?`, name: ROUTES.limits, component: () => import('../admin/views/LimitsView.vue'), meta: { title: 'Limits' } },
      { path: 'policies', name: ROUTES.policies, component: () => import('../admin/views/PoliciesView.vue'), meta: { title: 'Policies' } },
      { path: 'actor-settings', name: ROUTES.actorSettings, component: () => import('../admin/views/ActorSettingsView.vue'), meta: { title: 'Actor settings' } },
      { path: 'runs', name: ROUTES.runs, component: () => import('../admin/views/RunsView.vue'), meta: { title: 'Runs' } },
      { path: 'llm', name: ROUTES.llmCalls, component: () => import('../admin/views/LlmCallsView.vue'), meta: { title: 'LLM calls' } },
      { path: 'resources', name: ROUTES.resources, component: () => import('../admin/views/ResourcesView.vue'), meta: { title: 'Resources' } },
    ],
  },
  { path: '/settings', redirect: links.settings() },
  { path: `/settings/:section(${tabs(SettingsSection)})`, name: ROUTES.settings, component: () => import('../pages/SettingsPage.vue'), meta: { title: 'Settings' } },
  { path: '/design', redirect: links.design() },
  { path: `/design/:section(${tabs(DesignSection)})`, name: ROUTES.design, component: () => import('../pages/DesignPage.vue'), meta: { public: true, title: 'Design' } },
  { path: '/:rest(.*)*', name: ROUTES.notFound, component: () => import('../pages/NotFoundPage.vue'), meta: { public: true, title: 'Not found' } },
];
