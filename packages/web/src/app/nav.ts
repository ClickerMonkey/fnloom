/** The shell's navigation entries: what the sidebar lists, and which one is the current page. */
import type { UserView } from '@harness/core';
import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from 'vue-router';
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
  {
    id: 'admin', to: links.systems(), label: 'Admin', icon: 'shield', adminOnly: true,
    routes: [ROUTES.admin, ROUTES.systems, ROUTES.system, ROUTES.models, ROUTES.limits, ROUTES.policies, ROUTES.actorSettings, ROUTES.runs, ROUTES.llmCalls, ROUTES.resources],
  },
  { id: 'settings', to: links.settings(), label: 'Settings', icon: 'settings', routes: [ROUTES.settings], adminOnly: false },
];

const isRouteName = (name: unknown): name is RouteName => typeof name === 'string' && Object.values<string>(ROUTES).includes(name);

/** What the entries count: unread notifications, and pairing requests waiting for an admin. */
export interface NavCounts {
  readonly inbox: number;
  readonly admin: number;
}

/** The entries for this user on this route. */
export function navEntries(route: Pick<RouteLocationNormalizedLoaded, 'name'>, user: UserView | undefined, counts: NavCounts): NavEntry[] {
  const current = isRouteName(route.name) ? route.name : undefined;
  return NAV.filter((spec) => !spec.adminOnly || user?.role === 'admin').map((spec) => ({
    id: spec.id, to: spec.to, label: spec.label, icon: spec.icon,
    active: current !== undefined && spec.routes.includes(current),
    count: spec.id === 'inbox' ? counts.inbox : spec.id === 'admin' ? counts.admin : 0,
  }));
}
