/**
 * Widget pass, the row actions and export slices (`tables/`): the actions rows of some types offer the signed-in
 * person, a quiet read (`readFn`: a read fn run as that person outside any session, giving its output), and a read
 * fn's whole result as a streamed CSV download (`GET /api/export`), run as that person.
 */
import { plugin } from '@ayepi/plugin';
import { exportSlice, rowActionsSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { tableServiceOf } from '../../tables/fns.ts';
import type { FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';

/** The row actions and export plugins. */
export function tablesPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>) {
  const tables = tableServiceOf(hub);
  return [
    plugin({ name: 'web.rowActions', spec: rowActionsSlice, requires: [auth] })
      .handlers((): FullHandlers<typeof rowActionsSlice> => ({
        rowActions: ({ data, user }) => tables.rowActions(data, user.id),
        readFn: ({ data, user, signal }) => tables.readAs(data, user, signal),
      })),
    plugin({ name: 'web.export', spec: exportSlice, requires: [auth] })
      .handlers((): FullHandlers<typeof exportSlice> => ({
        export: async ({ data, user, signal, download }) => {
          const { name, lines } = await tables.export(data, user, signal);
          download(name, 'text/csv; charset=utf-8');
          return lines;
        },
      })),
  ] as const;
}
