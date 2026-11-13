/**
 * The admin nav: one entry per section, in the order `AdminSection` lists them, and which one is current; and the
 * sections in groups, so the strip holds a handful of links at any width (the open group shows its sections).
 */
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
  systems: { label: 'Systems', icon: 'server', to: links.systems(), routes: [ROUTES.systems, ROUTES.system, ROUTES.review, ROUTES.instance] },
  fns: { label: 'Fns', icon: 'fn', to: links.fns(), routes: [ROUTES.fns, ROUTES.fn] },
  models: { label: 'Models', icon: 'sparkles', to: links.models(), routes: [ROUTES.models] },
  limits: { label: 'Budgets', icon: 'coins', to: links.limits(), routes: [ROUTES.limits] },
  policies: { label: 'Policies', icon: 'shield', to: links.policies(), routes: [ROUTES.policies] },
  'actor-settings': { label: 'Actor settings', icon: 'users', to: links.actorSettings(), routes: [ROUTES.actorSettings] },
  runs: { label: 'Runs', icon: 'play', to: links.runs(), routes: [ROUTES.runs] },
  'model-calls': { label: 'Model calls', icon: 'cpu', to: links.modelCalls(), routes: [ROUTES.modelCalls, ROUTES.llmCalls] },
  mcps: { label: 'Hub MCP', icon: 'link', to: links.mcps(), routes: [ROUTES.mcps, ROUTES.mcp] },
  'mcp-servers': { label: 'MCP servers', icon: 'layers', to: links.mcpServers(), routes: [ROUTES.mcpServers, ROUTES.mcpServer] },
  'api-services': { label: 'API services', icon: 'globe', to: links.apiServices(), routes: [ROUTES.apiServices, ROUTES.apiService] },
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

/** A group of the admin nav: its sections, the first one where its link goes. */
export interface AdminNavGroup {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly to: RouteLocationRaw;
  /** Whether one of its sections is current. */
  readonly active: boolean;
  /** Its sections' counts together; hidden when 0. */
  readonly count: number;
  readonly entries: readonly AdminNavEntry[];
}

/** The groups, each naming its sections; together they hold every section once, in `AdminSection` order. */
const GROUPS = [
  { id: 'systems', label: 'Systems', icon: 'server', sections: ['systems', 'mcp-servers', 'api-services'] },
  { id: 'fns', label: 'Fns', icon: 'fn', sections: ['fns'] },
  { id: 'models', label: 'Models', icon: 'sparkles', sections: ['models', 'limits'] },
  { id: 'rules', label: 'Rules', icon: 'shield', sections: ['policies', 'actor-settings'] },
  { id: 'activity', label: 'Activity', icon: 'play', sections: ['runs', 'model-calls'] },
  { id: 'mcps', label: 'Hub MCP', icon: 'link', sections: ['mcps'] },
] as const satisfies readonly { id: string; label: string; icon: IconName; sections: readonly [AdminSection, ...AdminSection[]] }[];

/** The entries on this route in their groups. */
export function adminNavGroups(route: { readonly name?: unknown }, counts: Partial<Record<AdminSection, number>> = {}): AdminNavGroup[] {
  const entries = new Map(adminNav(route, counts).map((entry) => [entry.id, entry]));
  return GROUPS.map((group) => {
    const members = group.sections.flatMap((id) => entries.get(id) ?? []);
    return {
      id: group.id, label: group.label, icon: group.icon, to: SECTIONS[group.sections[0]].to,
      active: members.some((entry) => entry.active), count: members.reduce((sum, entry) => sum + entry.count, 0), entries: members,
    };
  });
}
