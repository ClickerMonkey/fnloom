/**
 * The systems slice (admins only): the systems the hub knows, pairing, config, turning a system's functions and
 * renderers on and off, removing, installing, starting, stopping and upgrading systems, and importing a manifest
 * again. This plugin binds `adminOnly`.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { adminOnly, SystemView, type SystemName, type SystemRecord } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { collect, PAGE } from '../paging.ts';
import { compact, type FullHandlers } from './access.ts';
import { systemsSlice } from './slices.ts';
import type { authPlugin } from './auth.ts';

/** How many systems the admin list shows at most. */
const MAX_SYSTEMS = 500;

/** A system as the admin pages show it: without its key, with its fn count and config type. */
export async function systemView(hub: Pick<HubServices, 'catalog'>, record: SystemRecord): Promise<SystemView> {
  const [fns, manifest] = await Promise.all([hub.catalog.fns({ system: record.name }), hub.catalog.manifest(record.name)]);
  return SystemView.parse({ ...record, fns: fns.length, needsConfig: record.status === 'needs-config', configType: manifest?.config });
}

/** The systems plugin. */
export function systemsPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>) {
  const { link, store, bus } = hub;
  const system = async (name: SystemName): Promise<SystemRecord> => {
    const record = await store.table('systems').get(name);
    if (record === undefined) { throw reject(404, 'SYSTEM_NOT_FOUND', `no system ${name}`); }
    return record;
  };
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
      system: async ({ data }) => systemView(hub, await system(data.system)),
      pairings: async ({ data }) => (await store.table('pairings').find({
        ...(data.status === undefined ? {} : { where: { status: data.status } }), order: [['createdAt', 'desc']], limit: MAX_SYSTEMS,
      })).items,
      approvePairing: async ({ data, user }) => {
        if (!data.approve) {
          await link.pairing.reject(data.pairing, user.id);
          hub.log.info('pairing.rejected', { pairing: data.pairing, user: user.id });
          return {};
        }
        const record = await link.pairing.approve(data.pairing, user.id);
        hub.log.info('pairing.approved', { pairing: data.pairing, system: record.name, user: user.id });
        return { system: record.name };
      },
      createPairingToken: ({ data, user }) => link.pairing.createToken({ ...compact(data), by: user.id }),
      configureSystem: async ({ data, user }) => {
        await system(data.system);
        const result = await link.config.set(data.system, data.config, user.id);
        hub.log.info('system.configured', { system: data.system, user: user.id, ok: 'version' in result });
        return result;
      },
      enableSystem: async ({ data: { system: name, ...change }, user }) => {
        await system(name);
        const enabled = await link.admin.setEnabled(name, compact(change), user.id);
        bus.publish('capabilities.changed', {});
        hub.log.info('system.enabled', { system: name, ...enabled, user: user.id });
        return { enabled };
      },
      removeSystem: async ({ data, user }) => {
        await system(data.system);
        const removed = await link.admin.remove(data.system, user.id);
        hub.log.info('system.removed', { system: data.system, fns: removed.fnsUnavailable, user: user.id });
        return removed;
      },
      installSystem: async ({ data, user }) => {
        const installed = await link.supervisor.install({ ...compact(data), by: user.id });
        hub.log.info('system.installed', { system: installed.name, version: installed.version, user: user.id });
        return { name: installed.name };
      },
      startSystem: async ({ data }) => {
        await link.supervisor.start(data.system);
        return { ok: true };
      },
      stopSystem: async ({ data }) => {
        await link.supervisor.stop(data.system, 'shutdown');
        return { ok: true };
      },
      upgradeSystem: ({ data }) => link.supervisor.upgrade(data.system, data.version),
      reimport: async ({ data }) => {
        await system(data.system);
        return link.admin.reimport(data.system);
      },
    }));
}
