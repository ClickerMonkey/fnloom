/** Builds the access module: visibility over the store, with the connections module's gate for per-person fns. */
import { ResourceUri } from '@harness/core';
import type { ModuleFactory } from '../boot/index.ts';
import { StoreAccessService } from './service.ts';

/** The access module's factory. Other modules are read inside its methods, never while it is built. */
export const accessModule: ModuleFactory<'access'> = ({ hub, hubActor }) => ({
  services: new StoreAccessService({
    store: hub.store, bus: hub.bus, clock: () => hub.clock(), hubActor,
    catalog: { fn: (name) => hub.catalog.fn(name), context: (name) => hub.catalog.context(name) },
    gate: (actor, groups) => hub.connections.gate(actor, groups),
    systemOf: (uri) => {
      const parsed = ResourceUri.safeParse(uri);
      return parsed.success ? hub.link.resources.route(parsed.data)?.system : undefined;
    },
  }),
});
