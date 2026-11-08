/** The admin nav: one entry per section, in the order `AdminSection` lists them, and which one is current. */
import type { RouteLocationRaw } from 'vue-router';
import { links, ROUTES, type RouteName } from '../../app/routes.ts';
import type { IconName } from '../../ui/index.ts';
import { AdminSection } from '../sections.ts';

/** One entry of the admin nav. */
export interface AdminNavEntry {
  readonly id: AdminSection;
  readonly label: string;
  readonly icon: IconName;
  readonly to: RouteLocationRaw;
  readonly active: boolean;
  /** A count on the entry; hidden when 0. */
  readonly count: number;
}

const SECTIONS = {
  systems: { label: 'Systems', icon: 'server', to: links.systems(), routes: [ROUTES.systems, ROUTES.system, ROUTES.instance, ROUTES.fn] },
  models: { label: 'Models', icon: 'sparkles', to: links.models(), routes: [ROUTES.models] },
  limits: { label: 'Limits', icon: 'coins', to: links.limits(), routes: [ROUTES.limits] },
  policies: { label: 'Policies', icon: 'shield', to: links.policies(), routes: [ROUTES.policies] },
  'actor-settings': { label: 'Actor settings', icon: 'users', to: links.actorSettings(), routes: [ROUTES.actorSettings] },
  runs: { label: 'Runs', icon: 'fn', to: links.runs(), routes: [ROUTES.runs] },
  'model-calls': { label: 'Model calls', icon: 'cpu', to: links.modelCalls(), routes: [ROUTES.modelCalls, ROUTES.llmCalls] },
  mcps: { label: 'MCPs', icon: 'link', to: links.mcps(), routes: [ROUTES.mcps, ROUTES.mcp] },
  resources: { label: 'Resources', icon: 'file', to: links.resources(), routes: [ROUTES.resources] },
} as const satisfies Record<AdminSection, { label: string; icon: IconName; to: RouteLocationRaw; routes: readonly RouteName[] }>;

const isRouteName = (name: unknown): name is RouteName => typeof name === 'string' && Object.values<string>(ROUTES).includes(name);

/** The entries on this route. `counts` puts a number on a section (pairing requests on Systems). */
export function adminNav(route: { readonly name?: unknown }, counts: Partial<Record<AdminSection, number>> = {}): AdminNavEntry[] {
  const current = isRouteName(route.name) ? route.name : undefined;
  return AdminSection.options.map((id) => {
    const section = SECTIONS[id];
    const routes: readonly RouteName[] = section.routes;
    return { id, label: section.label, icon: section.icon, to: section.to, active: current !== undefined && routes.includes(current), count: counts[id] ?? 0 };
  });
}
