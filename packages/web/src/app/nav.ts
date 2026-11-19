/** The shell's navigation entries: what the sidebar lists, and which one is the current page. */
import type { UserView } from '@harness/core';
import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from 'vue-router';
import type { ConnectNav } from '../connect/logic.ts';
import type { PageNav } from '../system-pages/logic.ts';
import type { IconName } from '../ui/index.ts';
import { links, ROUTES, type RouteName } from './routes.ts';

/** One entry in the sidebar. */
export interface NavEntry {
  readonly id: string;
  readonly to: RouteLocationRaw;
  readonly label: string;
  readonly icon: IconName;
  readonly active: boolean;
  /** A count on the entry; hidden when 0. */
  readonly count: number;
}

interface NavSpec {
  readonly id: string;
  readonly to: RouteLocationRaw;
  readonly label: string;
  readonly icon: IconName;
  /** The routes under this entry. */
  readonly routes: readonly RouteName[];
  readonly adminOnly: boolean;
}

const NAV: readonly NavSpec[] = [
  { id: 'chat', to: links.chat(), label: 'Chat', icon: 'chat', routes: [ROUTES.chat, ROUTES.session, ROUTES.turnTree], adminOnly: false },
  { id: 'inbox', to: links.inbox(), label: 'Inbox', icon: 'inbox', routes: [ROUTES.inbox], adminOnly: false },
  { id: 'resources', to: links.resources(), label: 'Resources', icon: 'layers', routes: [ROUTES.resources], adminOnly: false },
  { id: 'context', to: links.context(), label: 'Context', icon: 'book', routes: [ROUTES.context, ROUTES.contextItem], adminOnly: false },
  { id: 'data', to: links.data(), label: 'Data', icon: 'database', routes: [ROUTES.data, ROUTES.dataType], adminOnly: false },
  {
    id: 'admin', to: links.systems(), label: 'Admin', icon: 'shield', adminOnly: true,
    routes: [
      ROUTES.admin, ROUTES.systems, ROUTES.system, ROUTES.review, ROUTES.instance, ROUTES.fn, ROUTES.graph, ROUTES.models, ROUTES.limits, ROUTES.people, ROUTES.policies, ROUTES.actorSettings, ROUTES.runs, ROUTES.llmCalls,
      ROUTES.modelCalls, ROUTES.mcps, ROUTES.mcp, ROUTES.mcpServers, ROUTES.mcpServer, ROUTES.apiServices, ROUTES.apiService,
    ],
  },
  { id: 'settings', to: links.settings(), label: 'Settings', icon: 'settings', routes: [ROUTES.settings], adminOnly: false },
];

const isRouteName = (name: unknown): name is RouteName => typeof name === 'string' && Object.values<string>(ROUTES).includes(name);

/** What the entries count: unread notifications, and pairing requests waiting for an admin. */
export interface NavCounts {
  readonly inbox: number;
  readonly admin: number;
}

/** The route the entries are for: its name, and its params when it has any (a connect page's system). */
export type NavRoute = Pick<RouteLocationNormalizedLoaded, 'name'> & Partial<Pick<RouteLocationNormalizedLoaded, 'params'>>;

/**
 * The nav page a system page belongs under: itself when it is in the nav, else its system's first nav page (a hidden
 * detail page, such as one session, sits under its system's list).
 */
function shownPage(pages: readonly PageNav[], system: unknown, segment: unknown): PageNav | undefined {
  const ofSystem = pages.filter((page) => page.system === system);
  return ofSystem.find((page) => page.segment === segment) ?? ofSystem[0];
}

/**
 * The entries for this user on this route. After Context, `connect` adds the per-person systems' pages and `pages` the
 * pages live systems add (item 9), which come and go with their systems.
 */
export function navEntries(route: NavRoute, user: UserView | undefined, counts: NavCounts, connect: readonly ConnectNav[] = [], pages: readonly PageNav[] = []): NavEntry[] {
  const current = isRouteName(route.name) ? route.name : undefined;
  const fixed = NAV.filter((spec) => !spec.adminOnly || user?.role === 'admin').map((spec): NavEntry => ({
    id: spec.id, to: spec.to, label: spec.label, icon: spec.icon,
    active: current !== undefined && spec.routes.includes(current),
    count: spec.id === 'inbox' ? counts.inbox : spec.id === 'admin' ? counts.admin : 0,
  }));
  const connects = connect.map((page): NavEntry => ({
    id: `connect-${page.system}`, to: links.connect(page.system), label: page.title, icon: page.icon,
    active: current === ROUTES.connect && route.params?.['system'] === page.system, count: 0,
  }));
  const systems = pages.map((page): NavEntry => ({
    id: `page-${page.system}-${page.segment}`, to: links.systemPage(page.system, page.segment), label: page.title, icon: page.icon,
    active: current === ROUTES.systemPage && page === shownPage(pages, route.params?.['system'], route.params?.['page']), count: 0,
  }));
  const at = fixed.findIndex((entry) => entry.id === 'context') + 1;
  return [...fixed.slice(0, at), ...connects, ...systems, ...fixed.slice(at)];
}
