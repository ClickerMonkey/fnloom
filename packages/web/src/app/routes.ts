/**
 * Every page is a URL, so a refresh returns to the same place: the chat and its session, the inbox and its filter,
 * each settings section, the admin pages and the system being looked at. Route names and the values a URL part may
 * take are defined here once; links are made with `links` so they can't point at a page that doesn't exist.
 */
import type { MessageId, NotificationLink, RunId, SessionId, SystemName, TurnId } from '@harness/core';
import type { RouteLocationRaw, RouteRecordRaw } from 'vue-router';
import { z } from 'zod';
import { LimitsTab, ModelsTab, SystemTab } from '../admin/sections.ts';
import type { InboxFilter } from '../state/inbox.ts';

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

/** The design gallery's sections. */
export const DesignSection = z.enum(['actions', 'inputs', 'overlays', 'feedback', 'content']);
export type DesignSection = z.infer<typeof DesignSection>;

/** Links to every page. */
export const links = {
  signIn: (next?: string): RouteLocationRaw => ({ name: ROUTES.signIn, ...(next === undefined ? {} : { query: { next } }) }),
  chat: (): RouteLocationRaw => ({ name: ROUTES.chat }),
  session: (session: SessionId): RouteLocationRaw => ({ name: ROUTES.session, params: { session } }),
  /** A message in a session: the thread scrolls to it and lights it briefly. */
  message: (session: SessionId, message: MessageId): RouteLocationRaw => ({ name: ROUTES.session, params: { session }, hash: `#m-${message}` }),
  /** A turn's fn tree, over its session. */
  turnTree: (session: SessionId, turn: TurnId): RouteLocationRaw => ({ name: ROUTES.turnTree, params: { session, turn } }),
  inbox: (filter: InboxFilter = 'all'): RouteLocationRaw => ({ name: ROUTES.inbox, ...(filter === 'all' ? {} : { query: { filter } }) }),
  systems: (): RouteLocationRaw => ({ name: ROUTES.systems }),
  /** A system's page, on one of its tabs (the overview's URL has no tab). */
  system: (name: SystemName, tab: SystemTab = 'overview'): RouteLocationRaw => ({ name: ROUTES.system, params: tab === 'overview' ? { name } : { name, tab } }),
  models: (tab: ModelsTab = 'providers'): RouteLocationRaw => ({ name: ROUTES.models, params: tab === 'providers' ? {} : { tab } }),
  limits: (tab: LimitsTab = 'budgets'): RouteLocationRaw => ({ name: ROUTES.limits, params: tab === 'budgets' ? {} : { tab } }),
  policies: (): RouteLocationRaw => ({ name: ROUTES.policies }),
  actorSettings: (): RouteLocationRaw => ({ name: ROUTES.actorSettings }),
  /** The runs browser; `query` narrows it (`status`, `fn`, `system`, `session`) or opens one (`run`). */
  runs: (query: Readonly<Record<string, string>> = {}): RouteLocationRaw => ({ name: ROUTES.runs, query }),
  /** The LLM calls browser; `query` narrows it (`status`, `model`, `system`, `session`) or opens one (`call`). */
  llmCalls: (query: Readonly<Record<string, string>> = {}): RouteLocationRaw => ({ name: ROUTES.llmCalls, query }),
  /** The resources browser; `query` narrows it (`q`, `system`) or opens one (`uri`). */
  resources: (query: Readonly<Record<string, string>> = {}): RouteLocationRaw => ({ name: ROUTES.resources, query }),
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
 * and is answered; a run outside any chat opens in the runs browser.
 */
export async function notificationTarget(link: NotificationLink, sessionOf: SessionOfRun): Promise<RouteLocationRaw> {
  if ('session' in link) { return links.session(link.session); }
  if ('system' in link) { return links.system(link.system); }
  if ('pairing' in link) { return { name: ROUTES.systems, query: { pairing: link.pairing } }; }
  if ('approval' in link) { return { name: ROUTES.inbox, query: { approval: link.approval } }; }
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
