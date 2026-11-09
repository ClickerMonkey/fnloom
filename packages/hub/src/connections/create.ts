/** Builds the connections module, and serves `connectionUpdate` on the system link. */
import { spec } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { hubLinkSpec } from '@harness/core';
import type { ModuleFactory } from '../boot/index.ts';
import { StoreConnectionService } from './service.ts';

/** The slice of `hubLinkSpec` this module answers. */
export const CONNECTIONS_LINK_SPEC = spec({ endpoints: { connectionUpdate: hubLinkSpec.endpoints.connectionUpdate } });

/** The connections module's factory. */
export const connectionsModule: ModuleFactory<'connections'> = ({ hub }) => {
  const service = new StoreConnectionService({
    store: hub.store, bus: hub.bus, log: hub.log, clock: () => hub.clock(), settings: hub.settings.connectionsEnv, hubUrl: hub.settings.hubEnv.HARNESS_URL,
    catalog: { manifest: (system) => hub.catalog.manifest(system), check: (system, type, value) => hub.catalog.check(system, type, value) },
    link: { connection: (system, instance) => hub.link.connections.connection(system, instance) },
    secrets: hub.api.secrets,
  });
  return {
    services: service,
    linkPlugins: [plugin({ name: 'connections', spec: CONNECTIONS_LINK_SPEC }).handlers(() => ({
      connectionUpdate: async ({ data, link }): Promise<void> => { await service.refreshed(link.system, data); },
    }))],
  };
};
