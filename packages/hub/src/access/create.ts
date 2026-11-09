/** Builds the access module: visibility over the store, with the connections module's gate for per-person fns. Serves `shareFn` on the system link. */
import { spec } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { hubLinkSpec, ResourceUri } from '@harness/core';
import type { ModuleFactory } from '../boot/index.ts';
import { StoreAccessService } from './service.ts';

/** The slice of `hubLinkSpec` this module answers. */
export const ACCESS_LINK_SPEC = spec({ endpoints: { shareFn: hubLinkSpec.endpoints.shareFn } });

/** The access module's factory. Other modules are read inside its methods, never while it is built. */
export const accessModule: ModuleFactory<'access'> = ({ hub, hubActor }) => {
  const service = new StoreAccessService({
    store: hub.store, bus: hub.bus, clock: () => hub.clock(), hubActor,
    catalog: { fn: (name) => hub.catalog.fn(name), context: (name) => hub.catalog.context(name) },
    gate: (actor, groups) => hub.connections.gate(actor, groups),
    systemOf: (uri) => {
      const parsed = ResourceUri.safeParse(uri);
      return parsed.success ? hub.link.resources.route(parsed.data)?.system : undefined;
    },
  });
  return {
    services: service,
    linkPlugins: [plugin({ name: 'access', spec: ACCESS_LINK_SPEC }).handlers(() => ({
      shareFn: async ({ data, link }): Promise<void> => { await service.give(link.system, data); },
    }))],
  };
};
