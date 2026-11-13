/**
 * The table fns on the hub (widget pass): `hub/read_table`, `hub/visuals` and `hub/row_actions`, which the widgets
 * system calls. Args arrive checked against the contract's gin types; parsing them adds the brands.
 */
import { ReadTableArgs, RowActionsQuery } from '@harness/core';
import { hub } from '@harness/sdk';
import type { HubServices } from '../boot/index.ts';
import type { HubFns } from '../execution/executors.ts';
import { contributionsTo } from '../api/web/build5.ts';
import { openPersonTurn } from '../api/web/access.ts';
import type { TableService } from './index.ts';
import { HubTables } from './service.ts';

/** The table service over the hub's services, each looked up when it is needed. */
export function tableServiceOf(services: HubServices): TableService {
  return new HubTables({
    catalog: () => services.catalog, runs: () => services.execution.runs, facts: () => services.fns.facts,
    access: (actor) => services.access.scope(actor), contributions: (registry, actor) => contributionsTo(services, registry, actor),
    turn: (user) => openPersonTurn(services, user), settings: services.settings.tablesEnv,
  });
}

/** Register the table fns. */
export function registerTableFns(fns: HubFns, tables: () => TableService): void {
  const { fns: refs } = hub;
  fns.register(refs.read_table, (args, ctx) => tables().read(ReadTableArgs.parse(args), ctx.request.run));
  fns.register(refs.visuals, (_args, ctx) => tables().visuals(ctx.request.run.user.id));
  fns.register(refs.row_actions, (args, ctx) => tables().rowActions(RowActionsQuery.parse(args), ctx.request.run.user.id));
}
