/**
 * Builds the data module (build 8): the data service over the hub store, and the hub link's data endpoints, each
 * answered as the person of the run it names (its turn's user), or as the asking system's own actor without a run.
 */
import { spec } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { hubLinkSpec, type LinkSession, type RunId } from '@harness/core';
import type { HubServices, ModuleFactory } from '../boot/index.ts';
import { askingOf } from '../link/reads.ts';
import type { DataAsker } from './index.ts';
import { StoreDataService } from './service.ts';

const endpoints = hubLinkSpec.endpoints;

/** The slice of `hubLinkSpec` this module answers (capability `data`). */
export const DATA_LINK_SPEC = spec({
  endpoints: { records: endpoints.records, record: endpoints.record, recordTable: endpoints.recordTable, saveRecord: endpoints.saveRecord, removeRecord: endpoints.removeRecord },
});

/** Who a system's data call acts as: the run's person, or the system's own actor; the system writes either way. */
async function systemAsker(hub: HubServices, link: LinkSession, run: RunId | undefined): Promise<DataAsker> {
  const asking = await askingOf(hub.store, link, run);
  return { actor: asking.actor, access: await hub.access.scope(asking.actor), system: link.system, run: asking.run };
}

/** The data module's factory. Other modules are read inside its methods, never while it is built. */
export const dataModule: ModuleFactory<'data'> = ({ hub }) => {
  const service = new StoreDataService({
    store: hub.store, catalog: { type: (name) => hub.catalog.type(name), entries: (section, filter) => hub.catalog.entries(section, filter), check: (system, type, value) => hub.catalog.check(system, type, value) },
    indexer: () => hub.index.indexer, search: () => hub.index.search, settings: hub.settings.dataEnv, clock: () => hub.clock(),
  });
  return {
    services: service,
    linkPlugins: [plugin({ name: 'data', spec: DATA_LINK_SPEC }).handlers(() => ({
      records: async ({ data, link }) => service.find(data, await systemAsker(hub, link, data.run)),
      record: async ({ data, link }) => {
        const record = await service.get(data, await systemAsker(hub, link, data.run));
        return record === undefined ? {} : { record };
      },
      recordTable: async ({ data, link }) => service.table(data, await systemAsker(hub, link, data.run)),
      saveRecord: async ({ data, link }) => service.save(data, await systemAsker(hub, link, data.run)),
      removeRecord: async ({ data, link }) => ({ removed: await service.remove(data, await systemAsker(hub, link, data.run)) }),
    }))],
  };
};
