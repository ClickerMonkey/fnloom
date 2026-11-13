/**
 * Build 8, the versions slice: any item's version history, as the signed-in person may see it. The same read is the
 * hub fn `hub/item_versions` (`api/reads.ts`).
 */
import { plugin } from '@ayepi/plugin';
import { versionsSlice } from '@harness/core';
import type { HubReads } from '../reads.ts';
import type { FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';

/** The versions plugin. */
export function versionsPlugin(auth: ReturnType<typeof authPlugin>, reads: HubReads) {
  return plugin({ name: 'web.versions', spec: versionsSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof versionsSlice> => ({
      itemVersions: ({ data, user }) => reads.item_versions(data, user),
    }));
}
