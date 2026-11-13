/**
 * The data system's hub fns (`HUB_DATA_ENDPOINTS`): each runs the data service as the run's person, the same
 * operation the web's Data page and the hub link's data endpoints run. Args arrive checked against the contract's gin
 * types (made from the endpoints' bodies); parsing them adds the brands.
 */
import { hub, HUB_DATA_ENDPOINTS, toolArgsOf } from '@harness/sdk';
import type { ActorId } from '@harness/core';
import type { AccessScope } from '../access/index.ts';
import type { HubFnCtx, HubFns } from '../execution/executors.ts';
import type { DataAsker, DataService } from './index.ts';

/** What the data fns use, each looked up when a run arrives. */
export interface DataFnDeps {
  readonly data: () => DataService;
  readonly access: (actor: ActorId) => Promise<AccessScope>;
}

/** The run's person, as the data service asks. */
async function askerOf(deps: DataFnDeps, ctx: HubFnCtx): Promise<DataAsker> {
  const run = ctx.request.run;
  return { actor: run.user.id, access: await deps.access(run.user.id), run: run.id };
}

/** Register the data fns. */
export function registerDataFns(fns: HubFns, deps: DataFnDeps): void {
  const { fns: refs } = hub;
  const args = {
    sets: toolArgsOf(HUB_DATA_ENDPOINTS.data_sets.cfg.body).read,
    find: toolArgsOf(HUB_DATA_ENDPOINTS.records_find.cfg.body).read,
    get: toolArgsOf(HUB_DATA_ENDPOINTS.record_get.cfg.body).read,
    table: toolArgsOf(HUB_DATA_ENDPOINTS.records_table.cfg.body).read,
    versions: toolArgsOf(HUB_DATA_ENDPOINTS.record_versions.cfg.body).read,
    save: toolArgsOf(HUB_DATA_ENDPOINTS.record_save.cfg.body).read,
    remove: toolArgsOf(HUB_DATA_ENDPOINTS.record_remove.cfg.body).read,
  };
  fns.register(refs.data_sets, async (given, ctx) => deps.data().sets(args.sets(given), await askerOf(deps, ctx)));
  fns.register(refs.records_find, async (given, ctx) => deps.data().find(args.find(given), await askerOf(deps, ctx)));
  fns.register(refs.record_get, async (given, ctx) => {
    const record = await deps.data().get(args.get(given), await askerOf(deps, ctx));
    return record === undefined ? {} : { record };
  });
  fns.register(refs.records_table, async (given, ctx) => deps.data().table(args.table(given), await askerOf(deps, ctx)));
  fns.register(refs.record_versions, async (given, ctx) => deps.data().versions(args.versions(given), await askerOf(deps, ctx)));
  fns.register(refs.record_save, async (given, ctx) => deps.data().save(args.save(given), await askerOf(deps, ctx)));
  fns.register(refs.record_remove, async (given, ctx) => ({ removed: await deps.data().remove(args.remove(given), await askerOf(deps, ctx)) }));
}
