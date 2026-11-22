/**
 * Injected context as the catalog knows it: every agent (`hub/llm` fn, saved agents included), every context item that
 * declares `inject` with its targets resolved to the agents they hit now and where its review stands, and every hook
 * whose `explains` is injected with its system's items. The planner (the injected section) and the admin pages (an
 * agent's Injected tab, an item's targets, the review card) read these; the matching itself is core's `targetHits`.
 */
import {
  contextOff, InjectTargetView, qualify, QualifiedName, targetAgents, type ContextInjection, type ContextRecord, type HookExplains, type InjectionReview,
  type SystemName, type SystemReviewRecord,
} from '@harness/core';
import type { HubStore } from '../store/index.ts';
import { allRows } from '../store/rows.ts';
import type { Catalog } from './index.ts';

/** The hub's agent kind: its fns are the agents an injection targets. */
export const AGENT_KIND = QualifiedName.parse('hub/llm');

/** Every agent the hub has now (a fn of the `hub/llm` kind, saved ones too), in name order, read through the kind links. */
export async function agentNames(store: HubStore): Promise<QualifiedName[]> {
  const links = await allRows(store.table('fnLinks'), { where: { to: AGENT_KIND, link: 'kind' } });
  return [...new Set(links.map((link) => link.fn))].sort();
}

/** Each target of an injection with the agents it hits, of those given. */
export function targetViews(into: readonly string[], agents: readonly QualifiedName[]): InjectTargetView[] {
  return into.map((target) => InjectTargetView.parse({ target, agents: targetAgents(target, agents) }));
}

/** Where an item's review stands: waiting in its system's Pending review, declined (and so still off), or approved. */
export function reviewOf(section: 'context' | 'hooks', name: string, review: SystemReviewRecord | undefined, off: boolean): InjectionReview {
  if (review?.pending?.changes.some((change) => change.section === section && change.name === name && change.change !== 'removed') === true) { return 'pending'; }
  if (off && review?.declined?.some((declined) => declined.section === section && declined.name === name) === true) { return 'declined'; }
  return 'approved';
}

/** Which injections to list: those reaching one agent, or one item's. */
export interface InjectionFilter {
  readonly agent?: QualifiedName;
  readonly context?: QualifiedName;
}

/** One context record's injection, its targets resolved against the agents. Undefined when it injects nothing. */
export function injectionOf(record: ContextRecord, agents: readonly QualifiedName[], review: SystemReviewRecord | undefined): ContextInjection | undefined {
  const inject = record.decl.inject;
  if (inject === undefined) { return undefined; }
  const targets = targetViews(inject.into, agents);
  const off = contextOff(record);
  return {
    context: record.name, system: record.system, title: record.decl.title ?? record.decl.description, inject, fns: record.decl.fns, targets,
    agents: [...new Set(targets.flatMap((target) => target.agents))].sort(),
    // hub-made context is set by an admin by hand, and the hub's own is never reviewed
    review: record.origin === undefined || record.origin.type === 'system' ? reviewOf('context', record.name, review, off) : 'approved',
    off, dynamic: record.decl.content === undefined,
  };
}

/**
 * Every context item that declares `inject` (systems' and hub-made), with its targets and the agents each hits now and
 * its review state, in order (`inject.order`, then name); kept to one agent's or one item's when the filter says.
 */
export async function listInjections(store: HubStore, filter: InjectionFilter = {}): Promise<ContextInjection[]> {
  const [agents, records] = await Promise.all([
    agentNames(store),
    filter.context === undefined ? allRows(store.table('context')) : store.table('context').get(filter.context).then((record) => (record === undefined ? [] : [record])),
  ]);
  const reviews = new Map<SystemName, SystemReviewRecord | undefined>();
  const out: ContextInjection[] = [];
  for (const record of records) {
    if (record.decl.inject === undefined) { continue; }
    if (!reviews.has(record.system)) { reviews.set(record.system, await store.table('systemReviews').get(record.system)); }
    const injection = injectionOf(record, agents, reviews.get(record.system));
    if (injection === undefined || (filter.agent !== undefined && !injection.agents.includes(filter.agent))) { continue; }
    out.push(injection);
  }
  return out.sort((a, b) => a.inject.order - b.inject.order || a.context.localeCompare(b.context));
}

/** Every hook that says what its block means (`explains`), with its review state. */
export async function listHookExplains(catalog: Pick<Catalog, 'entries'>, store: HubStore): Promise<HookExplains[]> {
  const hooks = await catalog.entries('hooks');
  const reviews = new Map<SystemName, SystemReviewRecord | undefined>();
  const out: HookExplains[] = [];
  for (const hook of hooks) {
    if (hook.decl.explains === undefined) { continue; }
    if (!reviews.has(hook.system)) { reviews.set(hook.system, await store.table('systemReviews').get(hook.system)); }
    const off = (await store.table('itemSwitches').find({ where: { system: hook.system, section: 'hooks', name: hook.name }, limit: 1 })).items.length > 0;
    out.push({ hook: qualify(hook.system, hook.decl.name), system: hook.system, explains: hook.decl.explains, review: reviewOf('hooks', hook.name, reviews.get(hook.system), off) });
  }
  return out;
}
