/**
 * The packaging slice (packaging lane, admins): one pairing request for the `/pair/:pairing` page, a fleet's
 * instances, installing an uploaded package, removing an instance and exporting an instance's data, through
 * `hub.link` (`link/index.ts`).
 */
import { plugin } from '@ayepi/plugin';
import { packagingSlice } from '@harness/core';
import { notBuilt, type FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The packaging plugin. Requires the systems plugin, which binds `adminOnly`. */
export function packagingPlugin(systems: ReturnType<typeof systemsPlugin>) {
  return plugin({ name: 'web.packaging', spec: packagingSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof packagingSlice> => ({
      pairing: notBuilt('Pairing pages'),
      instances: notBuilt('Instances'),
      installPackage: notBuilt('Installing packages'),
      removeInstance: notBuilt('Removing instances'),
      exportSystemData: notBuilt('Data exports'),
    }));
}
