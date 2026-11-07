/**
 * The systems slice (admins only): the systems the hub knows, pairing, config, turning a system's functions and
 * renderers on and off, removing, installing, starting, stopping and upgrading systems, and importing a manifest
 * again. This plugin binds `adminOnly`.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { systemsSlice, adminOnly, SystemView, type SystemRecord } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { knownSystem, type AdminOperations } from '../admin-ops.ts';
import { collect, PAGE } from '../paging.ts';
import { type FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';

/** How many systems the admin list shows at most. */
const MAX_SYSTEMS = 500;

/** A system as the admin pages show it: without its key, with its fn count and config type. */
export async function systemView(hub: Pick<HubServices, 'catalog'>, record: SystemRecord): Promise<SystemView> {
  const [fns, manifest] = await Promise.all([hub.catalog.fns({ system: record.name }), hub.catalog.manifest(record.name)]);
  return SystemView.parse({ ...record, fns: fns.length, needsConfig: record.status === 'needs-config', configType: manifest?.config });
}

/** The systems plugin. */
export function systemsPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>, ops: AdminOperations) {
  const { link, store } = hub;
  return plugin({ name: 'web.systems', spec: systemsSlice, requires: [auth] })
    .middleware(adminOnly, () => async (io) => {
      if (io.ctx.user.role !== 'admin') { throw reject(403, 'ADMIN_ONLY', 'only an admin can do this'); }
      return io.next();
    })
    .handlers((): FullHandlers<typeof systemsSlice> => ({
      systems: async () => {
        const records = await collect((cursor) => store.table('systems').find({ order: [['name', 'asc']], limit: PAGE, cursor }), MAX_SYSTEMS);
        return Promise.all(records.filter((r) => r.status !== 'removed').map((r) => systemView(hub, r)));
      },
      system: async ({ data }) => systemView(hub, await knownSystem(hub, data.system)),
      pairings: async (io) => {
        const { status } = io.data;
        return (await store.table('pairings').find({ ...(status === undefined ? {} : { where: { status } }), order: [['createdAt', 'desc']], limit: MAX_SYSTEMS })).items;
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
