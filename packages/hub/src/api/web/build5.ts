/**
 * Build 5's web slices: the approvals of runs (`approvalsSlice`), with their previews, for the runs the person may see
 * or is asked about; and the entries connected systems contribute to a registry (`registriesSlice`), so the app loads
 * the client bundles that draw them.
 */
import { plugin } from '@ayepi/plugin';
import { approvalsSlice, registriesSlice, type Approval, type ContributionView, type QualifiedName, type RunId, type SystemName } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { mayView, type FullHandlers, type Viewer } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** What the approvals read uses. */
export type ApprovalsHub = Pick<HubServices, 'chat' | 'execution' | 'store'>;

/**
 * The approvals of the named runs, oldest first per run: those of runs the person may see, and those the person is
 * one of the approvers of (an admin asked about a system's own run sees it either way).
 */
export async function approvalsOf(hub: ApprovalsHub, runs: readonly RunId[], user: Viewer): Promise<Approval[]> {
  const out: Approval[] = [];
  for (const id of new Set(runs)) {
    const run = await hub.execution.runs.get(id);
    if (run === undefined) { continue; }
    const page = await hub.store.table('approvals').find({ where: { run: id }, order: [['createdAt', 'asc']], limit: 50 });
    if (page.items.length === 0) { continue; }
    if (await mayView(hub, user, run)) { out.push(...page.items); continue; }
    const turnUser = (await hub.store.table('turns').get(run.turn))?.user.id ?? run.actor;
    for (const approval of page.items) {
      if ((await hub.chat.approvers.approvers(approval.approver, turnUser)).includes(user.id)) { out.push(approval); }
    }
  }
  return out;
}

/** What the contributions read uses. */
export type ContributionsHub = Pick<HubServices, 'catalog' | 'link' | 'access'>;

/** The entries every connected system the person may see adds to a registry, by system then name. */
export async function contributionsTo(hub: ContributionsHub, registry: QualifiedName, user: Viewer): Promise<ContributionView[]> {
  const scope = await hub.access.scope(user.id);
  const systems = [...new Set<SystemName>(hub.link.connections.connected().map((connection) => connection.system))].sort();
  const out: ContributionView[] = [];
  for (const system of systems) {
    if (!scope.seesSystem(system)) { continue; }
    const manifest = await hub.catalog.manifest(system);
    for (const entry of manifest?.contributes ?? []) {
      if (entry.registry === registry) { out.push({ ...entry, system }); }
    }
  }
  return out.sort((a, b) => a.system.localeCompare(b.system) || a.name.localeCompare(b.name));
}

/** The build 5 plugins. Require the systems plugin, which binds `hubAuth`. */
export function build5Plugins(hub: HubServices, systems: ReturnType<typeof systemsPlugin>) {
  return [
    plugin({ name: 'web.approvals', spec: approvalsSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof approvalsSlice> => ({ approvals: ({ data, user }) => approvalsOf(hub, data.runs, user) })),
    plugin({ name: 'web.registries', spec: registriesSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof registriesSlice> => ({ contributions: ({ data, user }) => contributionsTo(hub, data.registry, user) })),
  ] as const;
}
