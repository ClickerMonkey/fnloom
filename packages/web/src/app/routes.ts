/**
 * Every page is a URL, so a refresh returns to the same place: the chat and its session, the inbox and its filter,
 * each settings section, the admin pages and the system being looked at. Route names and the values a URL part may
 * take are defined here once; links are made with `links` so they can't point at a page that doesn't exist. Each
 * page's query is declared once too (`QUERIES`): links take its input, and pages read its keys (`useRouteQuery`), so a
 * renamed or misspelled key breaks both at compile time.
 */
import {
  type HubMcpId, type InstanceName, LlmInteractionId, ModelCallId, ModelRole, NotificationId, PairingId, splitName, ResourceUri, RunId, SessionId, TurnId, type MessageId, type NotificationLink, type QualifiedName, type SystemName,
} from '@harness/core';
import type { RouteLocationRaw, RouteRecordRaw } from 'vue-router';
import { z } from 'zod';
import { InstanceTab, LimitsTab, McpTab, ModelsTab, SystemTab } from '../admin/sections.ts';
import { LlmCallTab, RunTab, TAB_KEYS } from '../chat/logic/inspect.ts';
import { BrowserQuery } from '../resources/logic/browse.ts';
import { ContextBrowseQuery, ContextItemQuery } from '../context/logic/context.ts';
import { InboxFilter } from '../state/inbox.ts';
import { OPEN_KEY } from '../state/push-payload.ts';
import { queryParam } from '../state/query.ts';

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
  instance: 'instance',
  fn: 'fn',
  fns: 'fns',
  models: 'models',
  limits: 'limits',
  policies: 'policies',
  actorSettings: 'actor-settings',
  runs: 'runs',
  llmCalls: 'llm-calls',
  modelCalls: 'model-calls',
  mcps: 'mcps',
  mcp: 'mcp',
  pair: 'pair',
  resources: 'resources',
  context: 'context',
  contextItem: 'context-item',
  connect: 'connect',
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
  /** Debug mode: the thread shows the messages and parts it hides. */
  debug: z.literal('1'),
  run: RunId, llm: LlmInteractionId, details: TurnId, resource: ResourceUri, panel: ChatPanel,
  [TAB_KEYS.run]: RunTab, [TAB_KEYS.llm]: LlmCallTab,
}).partial();

/** Each page's query keys and the values they take; a page without an entry takes no query. */
export const QUERIES = {
  [ROUTES.signIn]: z.object({ next: z.string() }).partial(),
  [ROUTES.chat]: CHAT_QUERY,
  [ROUTES.session]: CHAT_QUERY,
  [ROUTES.turnTree]: CHAT_QUERY,
  [ROUTES.inbox]: z.object({ q: z.string(), filter: InboxFilter, [OPEN_KEY]: NotificationId }).partial(),
  [ROUTES.systems]: z.object({ pairing: PairingId, q: z.string() }).partial(),
  [ROUTES.models]: z.object({ q: z.string(), role: ModelRole, model: z.string(), decision: z.literal('1') }).partial(),
  [ROUTES.limits]: z.object({ user: z.string(), session: SessionId }).partial(),
  [ROUTES.runs]: z.object({ q: z.string(), run: RunId, [TAB_KEYS.run]: RunTab }).partial(),
  [ROUTES.llmCalls]: z.object({ q: z.string(), call: LlmInteractionId, [TAB_KEYS.llm]: LlmCallTab }).partial(),
  [ROUTES.resources]: BrowserQuery,
  [ROUTES.context]: ContextBrowseQuery,
  [ROUTES.contextItem]: ContextItemQuery,
  [ROUTES.modelCalls]: z.object({ q: z.string(), run: RunId, call: ModelCallId, [TAB_KEYS.llm]: LlmCallTab }).partial(),
  [ROUTES.fns]: z.object({ q: z.string() }).partial(),
  [ROUTES.mcps]: z.object({ create: z.literal('1') }).partial(),
  [ROUTES.fn]: z.object({ days: z.enum(['7', '30', '90']) }).partial(),
  [ROUTES.pair]: z.object({ code: z.string() }).partial(),
  /** Why connecting failed, as the hub's redirect back from the provider says. */
  [ROUTES.connect]: z.object({ problem: z.string() }).partial(),
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
export const DesignSection = z.enum(['actions', 'inputs', 'overlays', 'feedback', 'content', 'gin', 'viewers']);
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
  /** One instance of a system (a fleet's copy), on one of its tabs. */
  instance: (name: SystemName, instance: InstanceName, tab: InstanceTab = 'overview'): RouteLocationRaw => ({
    name: ROUTES.instance, params: tab === 'overview' ? { name, instance } : { name, instance, tab },
  }),
  /** One fn of a system with its metrics (`fs/read` is `/admin/systems/fs/fns/read`). */
  fn: (fn: QualifiedName, query: RouteQuery<typeof ROUTES.fn> = {}): RouteLocationRaw => {
    const { system, local } = splitName(fn);
    return { name: ROUTES.fn, params: { name: system, fn: local }, ...queryOf(ROUTES.fn, query) };
  },
  /** Every fn of every system with its stats; `q` narrows and sorts it. */
  fns: (query: RouteQuery<typeof ROUTES.fns> = {}): RouteLocationRaw => ({ name: ROUTES.fns, ...queryOf(ROUTES.fns, query) }),
  /** The providers and models page, on a tab; `query` opens a role (`role`), a model's limits (`model`) or the decision model (`decision`). */
  models: (tab: ModelsTab = 'providers', query: RouteQuery<typeof ROUTES.models> = {}): RouteLocationRaw => ({
    name: ROUTES.models, params: tab === 'providers' ? {} : { tab }, ...queryOf(ROUTES.models, query),
  }),
  limits: (tab: LimitsTab = 'budgets'): RouteLocationRaw => ({ name: ROUTES.limits, params: tab === 'budgets' ? {} : { tab } }),
  policies: (): RouteLocationRaw => ({ name: ROUTES.policies }),
  actorSettings: (): RouteLocationRaw => ({ name: ROUTES.actorSettings }),
  /** The runs browser; `query` narrows it (`q`, a written query: `queryParam('runs', ...)`) or opens one (`run`). */
  runs: (query: RouteQuery<typeof ROUTES.runs> = {}): RouteLocationRaw => ({ name: ROUTES.runs, ...queryOf(ROUTES.runs, query) }),
  /** The runs of one fn. */
  fnRuns: (fn: QualifiedName): RouteLocationRaw => links.runs({ q: queryParam('runs', { filters: [{ field: 'fn', op: 'is', value: fn }] }) }),
  /** The fns catalogue narrowed to one system's fns. */
  systemFns: (system: SystemName): RouteLocationRaw => links.fns({ q: queryParam('fns', { filters: [{ field: 'system', op: 'is', value: system }] }) }),
  /** The LLM calls browser; `query` narrows it (`q`) or opens one (`call`). */
  llmCalls: (query: RouteQuery<typeof ROUTES.llmCalls> = {}): RouteLocationRaw => ({ name: ROUTES.llmCalls, ...queryOf(ROUTES.llmCalls, query) }),
  /** The resource browser; `query` lays it out (`view`, `group`), narrows it (`q`, `system`, `family`, `under`, `in`) or opens one (`uri`, `mode`). */
  resources: (query: RouteQuery<typeof ROUTES.resources> = {}): RouteLocationRaw => ({ name: ROUTES.resources, ...queryOf(ROUTES.resources, query) }),
  /** Every context item, filtered; `query` may open the remember or make-from-a-resource dialog. */
  context: (query: RouteQuery<typeof ROUTES.context> = {}): RouteLocationRaw => ({ name: ROUTES.context, ...queryOf(ROUTES.context, query) }),
  /** One context item with its links both ways (`fs/guide` is `/context/fs/guide`). */
  contextItem: (item: QualifiedName, query: RouteQuery<typeof ROUTES.contextItem> = {}): RouteLocationRaw => {
    const { system, local } = splitName(item);
    return { name: ROUTES.contextItem, params: { system, local }, ...queryOf(ROUTES.contextItem, query) };
  },
  /** Every model call of every modality; `query` narrows it (`q`, `run`) or opens one (`call`). */
  modelCalls: (query: RouteQuery<typeof ROUTES.modelCalls> = {}): RouteLocationRaw => ({ name: ROUTES.modelCalls, ...queryOf(ROUTES.modelCalls, query) }),
  /** The hub MCPs; `create: '1'` opens the new MCP dialog. */
  mcps: (query: RouteQuery<typeof ROUTES.mcps> = {}): RouteLocationRaw => ({ name: ROUTES.mcps, ...queryOf(ROUTES.mcps, query) }),
  /** One hub MCP, on one of its tabs. */
  mcp: (id: HubMcpId, tab: McpTab = 'rules'): RouteLocationRaw => ({ name: ROUTES.mcp, params: tab === 'rules' ? { id } : { id, tab } }),
  /** The page a system's pairing QR code opens: approve it with its instance and config. */
  pair: (pairing: PairingId, code?: string): RouteLocationRaw => ({ name: ROUTES.pair, params: { pairing }, ...queryOf(ROUTES.pair, { code }) }),
  /** A per-person system's page (`/connect/google-calendar`): connect your own account and choose what it may do. */
  connect: (system: SystemName): RouteLocationRaw => ({ name: ROUTES.connect, params: { system } }),
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
  if ('approval' in link) { return links.runs({ q: queryParam('runs', { filters: [{ field: 'status', op: 'is', value: 'awaiting-approval' }] }) }); }
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
  { path: '/resources', name: ROUTES.resources, component: () => import('../pages/ResourcesPage.vue'), meta: { title: 'Resources' } },
  // a system's pairing QR code opens this (admins; a signed-out visitor signs in first and comes back)
  { path: '/context', name: ROUTES.context, component: () => import('../pages/ContextPage.vue'), meta: { title: 'Context' } },
  { path: '/context/:system/:local(.+)', name: ROUTES.contextItem, component: () => import('../pages/ContextItemPage.vue'), meta: { title: 'Context' } },
  { path: '/pair/:pairing', name: ROUTES.pair, component: () => import('../pages/PairPage.vue'), meta: { title: 'Pair a system', admin: true } },
  { path: '/connect/:system', name: ROUTES.connect, component: () => import('../pages/ConnectPage.vue'), meta: { title: 'Connect' } },
  { path: '/inbox', name: ROUTES.inbox, component: () => import('../pages/InboxPage.vue'), meta: { title: 'Inbox' } },
  {
    path: '/admin', component: () => import('../admin/views/AdminLayout.vue'), meta: { admin: true },
    children: [
      { path: '', name: ROUTES.admin, redirect: { name: ROUTES.systems } },
      { path: 'systems', name: ROUTES.systems, component: () => import('../admin/views/SystemsView.vue'), meta: { title: 'Systems' } },
      { path: `systems/:name/:tab(${tabs(SystemTab)})?`, name: ROUTES.system, component: () => import('../admin/views/SystemView.vue'), meta: { title: 'System' } },
      { path: `systems/:name/instances/:instance/:tab(${tabs(InstanceTab)})?`, name: ROUTES.instance, component: () => import('../admin/views/InstanceView.vue'), meta: { title: 'Instance' } },
      { path: 'fns', name: ROUTES.fns, component: () => import('../admin/views/FnsView.vue'), meta: { title: 'Fns' } },
      { path: 'systems/:name/fns/:fn', name: ROUTES.fn, component: () => import('../admin/views/FnView.vue'), meta: { title: 'Fn' } },
      { path: `models/:tab(${tabs(ModelsTab)})?`, name: ROUTES.models, component: () => import('../admin/views/ModelsView.vue'), meta: { title: 'Models' } },
      { path: `limits/:tab(${tabs(LimitsTab)})?`, name: ROUTES.limits, component: () => import('../admin/views/LimitsView.vue'), meta: { title: 'Budgets' } },
      { path: 'policies', name: ROUTES.policies, component: () => import('../admin/views/PoliciesView.vue'), meta: { title: 'Policies' } },
      { path: 'actor-settings', name: ROUTES.actorSettings, component: () => import('../admin/views/ActorSettingsView.vue'), meta: { title: 'Actor settings' } },
      { path: 'runs', name: ROUTES.runs, component: () => import('../admin/views/RunsView.vue'), meta: { title: 'Runs' } },
      { path: 'llm', name: ROUTES.llmCalls, component: () => import('../admin/views/LlmCallsView.vue'), meta: { title: 'LLM calls' } },
      { path: 'model-calls', name: ROUTES.modelCalls, component: () => import('../admin/views/ModelCallsView.vue'), meta: { title: 'Model calls' } },
      // one call by its address: the list with that call open
      { path: 'model-calls/:id', redirect: (to) => ({ name: ROUTES.modelCalls, query: { ...to.query, call: to.params['id'] } }) },
      { path: 'mcps', name: ROUTES.mcps, component: () => import('../admin/views/McpsView.vue'), meta: { title: 'MCPs' } },
      { path: `mcps/:id/:tab(${tabs(McpTab)})?`, name: ROUTES.mcp, component: () => import('../admin/views/McpView.vue'), meta: { title: 'MCP' } },
      // the resource browser moved to the top level
      { path: 'resources', redirect: (to) => ({ name: ROUTES.resources, query: to.query }) },
    ],
  },
  { path: '/settings', redirect: links.settings() },
  { path: `/settings/:section(${tabs(SettingsSection)})`, name: ROUTES.settings, component: () => import('../pages/SettingsPage.vue'), meta: { title: 'Settings' } },
  { path: '/design', redirect: links.design() },
  { path: `/design/:section(${tabs(DesignSection)})`, name: ROUTES.design, component: () => import('../pages/DesignPage.vue'), meta: { public: true, title: 'Design' } },
  { path: '/:rest(.*)*', name: ROUTES.notFound, component: () => import('../pages/NotFoundPage.vue'), meta: { public: true, title: 'Not found' } },
];
