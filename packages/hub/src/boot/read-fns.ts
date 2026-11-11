/**
 * The hub's read fns: each web read the hub also offers as a fn (`HUB_READ_ENDPOINTS`, tagged `read`) runs the same
 * read the web handler runs (`api/reads.ts`), with the endpoint's body as its args, for the run's person, so the chat
 * LLM sees what that person could see in the browser. The reads of other modules (resources, context, model limits)
 * are registered by those modules.
 */
import type { QualifiedName } from '@harness/core';
import { HUB_READ_ENDPOINTS, hub, toolArgsOf, type FnRef } from '@harness/sdk';
import type { z } from 'zod';
import type { HubReadName, HubReads, ReadOp } from '../api/reads.ts';
import type { Viewer } from '../api/web/access.ts';
import type { HubFnCtx, HubFns } from '../execution/executors.ts';

/** Every read fn answered here, in declaration order (the compiler checks the list is whole and each has an implementation below). */
export const HUB_READ_NAMES = [
  'types_get', 'runs_list', 'run_get', 'run_tree', 'llm_call', 'model_calls', 'fn_metrics', 'sessions_list', 'session_messages',
  'systems_list', 'system_get', 'system_fns', 'system_logs', 'model_roles', 'query', 'graph',
] as const satisfies readonly HubReadName[];

/** The read fns missing from `HUB_READ_NAMES`: none, or this fails to compile. */
type Unlisted = Exclude<HubReadName, (typeof HUB_READ_NAMES)[number]>;
export const READ_NAMES_WHOLE: [Unlisted] extends [never] ? true : never = true;

/** Who a read fn reads for: the person whose turn it is. */
export function viewerOf(ctx: HubFnCtx): Viewer {
  return { id: ctx.request.run.user.id, role: ctx.request.run.user.role };
}

/** What a hub fn ref declares it returns. */
type FnResult<F> = F extends FnRef<QualifiedName, infer _A, infer R> ? R : never;
/** What the read behind a read fn answers. */
type ReadResult<N extends HubReadName> = Awaited<ReturnType<HubReads[N]>>;

/**
 * Each read answers what its hub fn declares it returns (both come from the same endpoint's response), or this fails
 * to compile naming the reads that don't; `HubFns.register` then takes each read as it is, its result checked here.
 */
type ResultsMatch = { readonly [N in HubReadName]: ReadResult<N> extends FnResult<(typeof hub.fns)[N]> ? true : N };
export const READ_RESULTS_MATCH: ResultsMatch[HubReadName] extends true ? true : ResultsMatch[HubReadName] = true;

/** A read fn's implementation as `HubFns` registers it; its result is checked against the fn's by `ResultsMatch`. */
type ReadImpl = (args: unknown, ctx: HubFnCtx) => Promise<unknown>;

/** Register the read fns. The reads are looked up when a fn runs, never while registering. */
export function registerReadFns(fns: HubFns, reads: () => HubReads): void {
  /** Run an endpoint's read: the args read back through the endpoint's body schema, for the run's person. */
  const run = <E extends { readonly cfg: { readonly body: z.ZodType } }>(endpoint: E, read: (all: HubReads) => ReadOp<E>): ReadImpl => {
    const args = toolArgsOf<E['cfg']['body']>(endpoint.cfg.body);
    return async (raw, ctx) => read(reads())(args.read(raw), viewerOf(ctx));
  };
  // TypeScript can't carry one name through both `HUB_READ_ENDPOINTS` and `HubReads` in a loop, so each read names
  // its endpoint here; the mapped type makes the table whole, and `ResultsMatch` checks what each answers
  const impls: { readonly [N in HubReadName]: ReadImpl } = {
    types_get: run(HUB_READ_ENDPOINTS.types_get, (r) => r.types_get),
    runs_list: run(HUB_READ_ENDPOINTS.runs_list, (r) => r.runs_list),
    run_get: run(HUB_READ_ENDPOINTS.run_get, (r) => r.run_get),
    run_tree: run(HUB_READ_ENDPOINTS.run_tree, (r) => r.run_tree),
    llm_call: run(HUB_READ_ENDPOINTS.llm_call, (r) => r.llm_call),
    model_calls: run(HUB_READ_ENDPOINTS.model_calls, (r) => r.model_calls),
    fn_metrics: run(HUB_READ_ENDPOINTS.fn_metrics, (r) => r.fn_metrics),
    sessions_list: run(HUB_READ_ENDPOINTS.sessions_list, (r) => r.sessions_list),
    session_messages: run(HUB_READ_ENDPOINTS.session_messages, (r) => r.session_messages),
    systems_list: run(HUB_READ_ENDPOINTS.systems_list, (r) => r.systems_list),
    system_get: run(HUB_READ_ENDPOINTS.system_get, (r) => r.system_get),
    system_fns: run(HUB_READ_ENDPOINTS.system_fns, (r) => r.system_fns),
    system_logs: run(HUB_READ_ENDPOINTS.system_logs, (r) => r.system_logs),
    model_roles: run(HUB_READ_ENDPOINTS.model_roles, (r) => r.model_roles),
    query: run(HUB_READ_ENDPOINTS.query, (r) => (data, who) => r.query(data, who)),
    graph: run(HUB_READ_ENDPOINTS.graph, (r) => r.graph),
  };
  for (const name of HUB_READ_NAMES) fns.register(hub.fns[name], impls[name]);
}
