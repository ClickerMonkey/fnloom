/**
 * Build 5's web slices: the approvals of runs (`approvalsSlice`), with their previews, for the runs the person may see
 * or is asked about; and the entries connected systems contribute to a registry (`registriesSlice`), so the app loads
 * the client bundles that draw them. From the owner's feedback, `fnsSlice`: fns and context search, a fn's examples
 * and facts (each only for fns the person sees), the browser's logs and traffic, and the auto classifier setting.
 */
import { plugin } from '@ayepi/plugin';
import { reject } from '@ayepi/core';
import { approvalsSlice, fnsSlice, registriesSlice, type Approval, type FnFacts, type Json, type ContributionView, type QualifiedName, type RunId, type SystemName } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { mayView, type FullHandlers, type Viewer } from './access.ts';
import type { systemsPlugin } from './systems.ts';
import type { Asker } from '../../fns/index.ts';
import { seesTypeNamed } from '../../access/scope.ts';

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
  // build 7: an installed system offers nothing yet, and a component switched off (or waiting for review) is left out
  const off = await hub.link.lifecycle.off('components');
  for (const system of systems) {
    if (!scope.seesSystem(system) || await hub.link.lifecycle.stage(system) === 'installed') { continue; }
    const manifest = await hub.catalog.manifest(system);
    for (const entry of manifest?.contributes ?? []) {
      if (entry.registry === registry && !off.has(`${entry.registry}: ${entry.label}`)) { out.push({ ...entry, system }); }
    }
  }
  return out.sort((a, b) => a.system.localeCompare(b.system) || a.name.localeCompare(b.name));
}

/** What the fns reads use. */
export type FnsHub = Pick<HubServices, 'fns' | 'access' | 'catalog'>;

/** Who a fns read is for. */
async function askerOf(hub: Pick<HubServices, 'access'>, user: Viewer): Promise<Asker> {
  return { actor: user.id, access: await hub.access.scope(user.id) };
}

/**
 * A fn's facts for a person who may see it (404 otherwise, as for a fn that isn't there), naming only the types they
 * may see among those it reads and writes.
 */
export async function factsFor(hub: FnsHub, fn: QualifiedName, args: Json | undefined, user: Viewer): Promise<FnFacts> {
  const [record, access] = await Promise.all([hub.catalog.fn(fn), hub.access.scope(user.id)]);
  if (record === undefined || !access.seesFn(record)) throw reject(404, 'NO_FN', `there is no fn ${fn}`);
  const facts = await hub.fns.facts.facts(fn, args);
  const seen = async (names: readonly QualifiedName[]): Promise<QualifiedName[]> => {
    const kept = await Promise.all(names.map((name) => seesTypeNamed(access, (n) => hub.catalog.type(n), name)));
    return names.filter((_, at) => kept[at] === true);
  };
  return { ...facts, reads: await seen(facts.reads), writes: await seen(facts.writes) };
}

/** The build 5 plugins. Require the systems plugin, which binds `hubAuth`. */
export function build5Plugins(hub: HubServices, systems: ReturnType<typeof systemsPlugin>) {
  return [
    plugin({ name: 'web.fns', spec: fnsSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof fnsSlice> => ({
        searchFns: async ({ data, user }) => hub.fns.search.search(data, await askerOf(hub, user)),
        fnExamples: async ({ data, user }) => hub.fns.examples.page(data, await askerOf(hub, user)),
        fnFacts: ({ data, user }) => factsFor(hub, data.fn, data.args, user),
        clientLogs: ({ data, user }) => hub.fns.clientLogs.write(user.id, data),
        autoClassifier: () => hub.fns.classifier.setting(),
        setAutoClassifier: ({ data, user }) => hub.fns.classifier.set(data, user.id),
      })),
    plugin({ name: 'web.approvals', spec: approvalsSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof approvalsSlice> => ({ approvals: ({ data, user }) => approvalsOf(hub, data.runs, user) })),
    plugin({ name: 'web.registries', spec: registriesSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof registriesSlice> => ({ contributions: ({ data, user }) => contributionsTo(hub, data.registry, user) })),
  ] as const;
}
