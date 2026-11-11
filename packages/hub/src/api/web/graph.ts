/**
 * Build 7, the graph slice: the graph of systems' items and how they connect, as the signed-in person may see it.
 * The same read is the hub fn `hub/graph` (`api/reads.ts`).
 */
import { plugin } from '@ayepi/plugin';
import { graphSlice } from '@harness/core';
import type { HubReads } from '../reads.ts';
import type { FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';

/** The graph plugin. */
export function graphPlugin(auth: ReturnType<typeof authPlugin>, reads: HubReads) {
  return plugin({ name: 'web.graph', spec: graphSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof graphSlice> => ({
      graph: ({ data, user }) => reads.graph(data, user),
    }));
}
