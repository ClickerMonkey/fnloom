/**
 * The file explorer's endpoints (build 6, `explorerSlice`): browse and read a system's resources live, as the
 * signed-in person may see them. Each runs the same operation as its hub fn (`exploreOperations`); nothing is imported
 * or stored in the hub.
 */
import { plugin } from '@ayepi/plugin';
import { explorerSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { exploreOperations } from '../person-ops.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The explorer plugin. Requires the systems plugin, which binds `hubAuth`. */
export function explorerPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>) {
  const ops = exploreOperations(hub);
  return plugin({ name: 'web.explorer', spec: explorerSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof explorerSlice> => ({
      exploreRoots: ({ data, user }) => ops.explore_roots(data, user),
      exploreList: ({ data, user }) => ops.explore_list(data, user),
      exploreRead: ({ data, user }) => ops.explore_read(data, user),
    }));
}
