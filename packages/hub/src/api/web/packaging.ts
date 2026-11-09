/**
 * The packaging slice (packaging lane, admins): one pairing request for the `/pair/:pairing` page, a system's
 * instances, and the admin writes (installing an uploaded package zip, removing an instance, exporting an instance's
 * data), which run the same admin operations as the hub fns `hub/install_package`, `hub/remove_instance` and
 * `hub/export_system_data`.
 */
import { plugin } from '@ayepi/plugin';
import { InstanceView, packagingSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { allRows } from '../../catalog/rows.ts';
import { knownSystem, type AdminOperations } from '../admin-ops.ts';
import { type FullHandlers } from './access.ts';
import { maskedInstance, type systemsPlugin } from './systems.ts';

/** The packaging plugin. Requires the systems plugin, which binds `adminOnly`. */
export function packagingPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>, ops: AdminOperations) {
  const { link, store } = hub;
  return plugin({ name: 'web.packaging', spec: packagingSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof packagingSlice> => ({
      pairing: ({ data }) => link.pairing.get(data.pairing),
      instances: async ({ data }) => {
        await knownSystem(hub, data.system);
        const rows = await allRows(store.table('instances'), { system: data.system });
        return rows.sort((a, b) => a.instance.localeCompare(b.instance)).map((row) => InstanceView.parse(maskedInstance(row)));
      },
      installPackage: ({ data, user }) => ops.install_package(data, user.id),
      removeInstance: ({ data, user }) => ops.remove_instance(data, user.id),
      exportSystemData: ({ data, user }) => ops.export_system_data(data, user.id),
    }));
}
