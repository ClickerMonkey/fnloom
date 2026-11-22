/**
 * Build 6: the hub fns for the rest of what a person does in the browser (`HUB_PERSON_ENDPOINTS`), the explorer's reads
 * (`HUB_EXPLORE_ENDPOINTS`) and the admin pages' reads (`ADMIN_READ_ENDPOINTS`). Each runs the one operation its web
 * endpoint runs (`api/person-ops.ts`), with the endpoint's body as its args, as the person whose turn it is.
 */
import { ADMIN_READ_ENDPOINTS, HUB_EXPLORE_ENDPOINTS, HUB_PERSON_ENDPOINTS, hub, toolArgsOf, type AdminReadFnName, type HubExploreFnName, type HubPersonFnName } from '@harness/sdk';
import type { UserView } from '@harness/core';
import type { z } from 'zod';
import type { AdminReadOperations, ExploreOperations, PersonOp, PersonOperations } from '../api/person-ops.ts';
import type { HubFnCtx, HubFns } from '../execution/executors.ts';

/** The person a run is for, as the web handlers see a signed-in person. */
export function personOf(ctx: HubFnCtx): UserView {
  const { user } = ctx.request.run;
  return { id: user.id, kind: 'user', name: user.name, email: user.email, role: user.role, timeZone: user.timeZone };
}

/** A fn's implementation, erased to what `HubFns` registers. */
type Impl = (args: unknown, ctx: HubFnCtx) => Promise<unknown>;

/** What the fns run, each looked up when a fn runs. */
export interface PersonFnOps {
  readonly person: () => PersonOperations;
  readonly explore: () => ExploreOperations;
  readonly adminReads: () => AdminReadOperations;
}

/** Register the fns. */
export function registerPersonFns(fns: HubFns, ops: PersonFnOps): void {
  const run = <E extends { readonly cfg: { readonly body: z.ZodType } }>(endpoint: E, operation: () => PersonOp<E>): Impl => {
    const { read } = toolArgsOf<E['cfg']['body']>(endpoint.cfg.body);
    return async (args, ctx) => operation()(read(args), personOf(ctx));
  };
  // each names its endpoint, since TypeScript can't carry one name through both maps in a loop; the mapped types make
  // every table whole
  const person: { readonly [N in HubPersonFnName]: Impl } = {
    session_create: run(HUB_PERSON_ENDPOINTS.session_create, () => ops.person().session_create),
    session_update: run(HUB_PERSON_ENDPOINTS.session_update, () => ops.person().session_update),
    session_delete: run(HUB_PERSON_ENDPOINTS.session_delete, () => ops.person().session_delete),
    run_background: run(HUB_PERSON_ENDPOINTS.run_background, () => ops.person().run_background),
    turn_undo: run(HUB_PERSON_ENDPOINTS.turn_undo, () => ops.person().turn_undo),
    memory_update: run(HUB_PERSON_ENDPOINTS.memory_update, () => ops.person().memory_update),
    ctx_link: run(HUB_PERSON_ENDPOINTS.ctx_link, () => ops.person().ctx_link),
    ctx_unlink: run(HUB_PERSON_ENDPOINTS.ctx_unlink, () => ops.person().ctx_unlink),
    access_set: run(HUB_PERSON_ENDPOINTS.access_set, () => ops.person().access_set),
    connection_update: run(HUB_PERSON_ENDPOINTS.connection_update, () => ops.person().connection_update),
    connection_disconnect: run(HUB_PERSON_ENDPOINTS.connection_disconnect, () => ops.person().connection_disconnect),
  };
  const explore: { readonly [N in HubExploreFnName]: Impl } = {
    explore_roots: run(HUB_EXPLORE_ENDPOINTS.explore_roots, () => ops.explore().explore_roots),
    explore_list: run(HUB_EXPLORE_ENDPOINTS.explore_list, () => ops.explore().explore_list),
    explore_read: run(HUB_EXPLORE_ENDPOINTS.explore_read, () => ops.explore().explore_read),
  };
  const adminReads: { readonly [N in AdminReadFnName]: Impl } = {
    budgets_list: run(ADMIN_READ_ENDPOINTS.budgets_list, () => ops.adminReads().budgets_list),
    policies_list: run(ADMIN_READ_ENDPOINTS.policies_list, () => ops.adminReads().policies_list),
    priority_rules_list: run(ADMIN_READ_ENDPOINTS.priority_rules_list, () => ops.adminReads().priority_rules_list),
    providers_list: run(ADMIN_READ_ENDPOINTS.providers_list, () => ops.adminReads().providers_list),
    actors_list: run(ADMIN_READ_ENDPOINTS.actors_list, () => ops.adminReads().actors_list),
    actor_settings_list: run(ADMIN_READ_ENDPOINTS.actor_settings_list, () => ops.adminReads().actor_settings_list),
    mcps_list: run(ADMIN_READ_ENDPOINTS.mcps_list, () => ops.adminReads().mcps_list),
    mcp_sessions_list: run(ADMIN_READ_ENDPOINTS.mcp_sessions_list, () => ops.adminReads().mcp_sessions_list),
    pairings_list: run(ADMIN_READ_ENDPOINTS.pairings_list, () => ops.adminReads().pairings_list),
    auto_pairs_list: run(ADMIN_READ_ENDPOINTS.auto_pairs_list, () => ops.adminReads().auto_pairs_list),
    instances_list: run(ADMIN_READ_ENDPOINTS.instances_list, () => ops.adminReads().instances_list),
    suggest_decision_get: run(ADMIN_READ_ENDPOINTS.suggest_decision_get, () => ops.adminReads().suggest_decision_get),
    search_decision_get: run(ADMIN_READ_ENDPOINTS.search_decision_get, () => ops.adminReads().search_decision_get),
  };
  for (const [name, impl] of Object.entries(person)) if (isName(name, HUB_PERSON_ENDPOINTS)) fns.register(hub.fns[name], impl);
  for (const [name, impl] of Object.entries(explore)) if (isName(name, HUB_EXPLORE_ENDPOINTS)) fns.register(hub.fns[name], impl);
  for (const [name, impl] of Object.entries(adminReads)) if (isName(name, ADMIN_READ_ENDPOINTS)) fns.register(hub.fns[name], impl);
}

/** Whether a key is one of a map's own names. */
function isName<M extends object>(name: string, map: M): name is Extract<keyof M, string> {
  return Object.hasOwn(map, name);
}
