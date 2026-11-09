/**
 * The systems slice (admins only): the systems the hub knows, pairing, config, turning a system's functions and
 * renderers on and off, removing, installing, starting, stopping and upgrading systems, and importing a manifest
 * again. This plugin binds `adminOnly`.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { systemsSlice, adminOnly, SystemView, type InstanceRecord, type SystemRecord } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { knownSystem, type AdminOperations } from '../admin-ops.ts';
import { type FullHandlers } from './access.ts';
import { allRows } from '../../catalog/rows.ts';
import { defaultInstanceOf } from '../../link/status.ts';
import { maskSecrets } from '../../link/config-secrets.ts';

/** An instance as the admin pages see it: its config's secret fields as `SECRET_KEPT`. */
export function maskedInstance(record: InstanceRecord): InstanceRecord {
  return record.config === undefined ? record : { ...record, config: { ...record.config, value: maskSecrets(record.config.value) } };
}

/** How many pairing requests the admin list shows at most. */
const MAX_PAIRINGS = 500;
import type { authPlugin } from './auth.ts';
import type { HubReads } from '../reads.ts';

/**
 * A system as the admin pages show it: without keys, with its fn count, config type and instances, and its default
 * instance's key, config, process and last sighting for the pages that show one copy.
 */
export async function systemView(hub: Pick<HubServices, 'catalog' | 'store'>, record: SystemRecord): Promise<SystemView> {
  const [fns, manifest, rows] = await Promise.all([
    hub.catalog.fns({ system: record.name }), hub.catalog.manifest(record.name), allRows(hub.store.table('instances'), { system: record.name }),
  ]);
  // a sealed secret field reads as SECRET_KEPT; sending that back keeps it
  const instances = rows.sort((a, b) => a.instance.localeCompare(b.instance)).map(maskedInstance);
  const main = instances.find((i) => i.instance === defaultInstanceOf(record, instances));
  return SystemView.parse({
    ...record, keyFingerprint: main?.keyFingerprint ?? '', config: main?.config, installed: main?.installed, pairedAt: main?.pairedAt, pairedBy: main?.pairedBy,
    lastSeenAt: main?.lastSeenAt, address: main?.address,
    fns: fns.length, needsConfig: record.status === 'needs-config', configType: manifest?.config, instances,
  });
}

/** The systems plugin. */
export function systemsPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>, ops: AdminOperations, reads: HubReads) {
  const { link, store } = hub;
  return plugin({ name: 'web.systems', spec: systemsSlice, requires: [auth] })
    .middleware(adminOnly, () => async (io) => {
      if (io.ctx.user.role !== 'admin') { throw reject(403, 'ADMIN_ONLY', 'only an admin can do this'); }
      return io.next();
    })
    .handlers((): FullHandlers<typeof systemsSlice> => ({
      systems: ({ data, user }) => reads.systems_list(data, user),
      system: ({ data, user }) => reads.system_get(data, user),
      pairings: async (io) => {
        const { status } = io.data;
        return (await store.table('pairings').find({ ...(status === undefined ? {} : { where: { status } }), order: [['createdAt', 'desc']], limit: MAX_PAIRINGS })).items;
      },
      approvePairing: ({ data, user }) => ops.approve_pairing(data, user.id),
      createPairingToken: ({ data, user }) => ops.create_pairing_token(data, user.id),
      configureSystem: ({ data, user }) => ops.configure_system(data, user.id),
      enableSystem: ({ data, user }) => ops.enable_system(data, user.id),
      removeSystem: ({ data, user }) => ops.remove_system(data, user.id),
      installSystem: ({ data, user }) => ops.install_system(data, user.id),
      startSystem: ({ data, user }) => ops.start_system(data, user.id),
      stopSystem: ({ data, user }) => ops.stop_system(data, user.id),
      upgradeSystem: ({ data, user }) => ops.upgrade_system(data, user.id),
      reimport: async ({ data }) => {
        await knownSystem(hub, data.system);
        return link.admin.reimport(data.system);
      },
    }));
}
