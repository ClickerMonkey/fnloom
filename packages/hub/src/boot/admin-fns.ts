/**
 * The hub's admin fns: whatever an admin configures can also be done by asking in chat. Each fn runs one admin
 * operation (`api/admin-ops.ts`, the same one the web admin endpoint runs), with the endpoint's body as its args. None
 * is tagged `read`, so unless a policy says otherwise each waits for the person's approval, and each runs only for an
 * admin (the person whose turn it is).
 */
import { ADMIN_ENDPOINTS, hub, toolArgsOf, type AdminFnName } from '@harness/sdk';
import type { ActorId } from '@harness/core';
import type { z } from 'zod';
import type { AdminOp, AdminOperations } from '../api/admin-ops.ts';
import type { HubFnCtx, HubFns } from '../execution/executors.ts';

/** Every admin fn, in declaration order. */
export const ADMIN_FN_NAMES: readonly AdminFnName[] = Object.keys(ADMIN_ENDPOINTS).filter((name): name is AdminFnName => Object.hasOwn(ADMIN_ENDPOINTS, name));

/** The admin a run is for: the person whose turn it is, refused unless they are an admin. */
function adminOf(ctx: HubFnCtx): ActorId {
  const { user } = ctx.request.run;
  if (user.role !== 'admin') { throw new Error('only an admin can change this'); }
  return user.id;
}

/** An admin fn's implementation, erased to what `HubFns` registers. */
type AdminImpl = (args: unknown, ctx: HubFnCtx) => Promise<unknown>;

/** Register every admin fn. The operations are looked up when a fn runs, never while registering. */
export function registerAdminFns(fns: HubFns, ops: () => AdminOperations): void {
  /** Run an endpoint's operation: the args read back through the endpoint's body schema, for the admin asking. */
  const run = <E extends { readonly cfg: { readonly body: z.ZodType } }>(endpoint: E, operation: (all: AdminOperations) => AdminOp<E>): AdminImpl => {
    const { read } = toolArgsOf<E['cfg']['body']>(endpoint.cfg.body);
    return async (args, ctx) => operation(ops())(read(args), adminOf(ctx));
  };
  const impls: { readonly [N in AdminFnName]: AdminImpl } = {
    configure_provider: run(ADMIN_ENDPOINTS.configure_provider, (o) => o.configure_provider),
    set_model_category: run(ADMIN_ENDPOINTS.set_model_category, (o) => o.set_model_category),
    set_budget: run(ADMIN_ENDPOINTS.set_budget, (o) => o.set_budget),
    set_priority: run(ADMIN_ENDPOINTS.set_priority, (o) => o.set_priority),
    set_policy: run(ADMIN_ENDPOINTS.set_policy, (o) => o.set_policy),
    set_actor_setting: run(ADMIN_ENDPOINTS.set_actor_setting, (o) => o.set_actor_setting),
    add_user: run(ADMIN_ENDPOINTS.add_user, (o) => o.add_user),
    add_group: run(ADMIN_ENDPOINTS.add_group, (o) => o.add_group),
    remove_rule: run(ADMIN_ENDPOINTS.remove_rule, (o) => o.remove_rule),
    approve_pairing: run(ADMIN_ENDPOINTS.approve_pairing, (o) => o.approve_pairing),
    create_pairing_token: run(ADMIN_ENDPOINTS.create_pairing_token, (o) => o.create_pairing_token),
    configure_system: run(ADMIN_ENDPOINTS.configure_system, (o) => o.configure_system),
    enable_system: run(ADMIN_ENDPOINTS.enable_system, (o) => o.enable_system),
    remove_system: run(ADMIN_ENDPOINTS.remove_system, (o) => o.remove_system),
    install_system: run(ADMIN_ENDPOINTS.install_system, (o) => o.install_system),
    start_system: run(ADMIN_ENDPOINTS.start_system, (o) => o.start_system),
    stop_system: run(ADMIN_ENDPOINTS.stop_system, (o) => o.stop_system),
    upgrade_system: run(ADMIN_ENDPOINTS.upgrade_system, (o) => o.upgrade_system),
  };
  for (const name of ADMIN_FN_NAMES) { fns.register(hub.fns[name], impls[name]); }
}
