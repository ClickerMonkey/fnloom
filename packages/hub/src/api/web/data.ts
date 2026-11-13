/**
 * Build 8, the data slice: stored types and their records, as the signed-in person (`data/`). The same operations are
 * the hub fns `hub/data_sets` and `hub/records_*` and the hub link's data endpoints.
 */
import { plugin } from '@ayepi/plugin';
import { dataSlice, type ActorId } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { DataAsker } from '../../data/index.ts';
import type { FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';

/** The person as the data service asks. */
async function personAsker(hub: HubServices, actor: ActorId): Promise<DataAsker> {
  return { actor, access: await hub.access.scope(actor) };
}

/** The data plugin. */
export function dataPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>) {
  return plugin({ name: 'web.data', spec: dataSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof dataSlice> => ({
      dataSets: async ({ data, user }) => hub.data.sets(data, await personAsker(hub, user.id)),
      records: async ({ data, user }) => hub.data.find(data, await personAsker(hub, user.id)),
      record: async ({ data, user }) => {
        const record = await hub.data.get(data, await personAsker(hub, user.id));
        return record === undefined ? {} : { record };
      },
      recordTable: async ({ data, user }) => hub.data.table(data, await personAsker(hub, user.id)),
      saveRecord: async ({ data, user }) => hub.data.save(data, await personAsker(hub, user.id)),
      removeRecord: async ({ data, user }) => ({ removed: await hub.data.remove(data, await personAsker(hub, user.id)) }),
      recordVersions: async ({ data, user }) => hub.data.versions(data, await personAsker(hub, user.id)),
    }));
}
