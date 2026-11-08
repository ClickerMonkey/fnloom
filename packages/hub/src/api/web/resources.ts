/**
 * The resources slice (resources lane): browsing with groups and facets, reading any form, making forms, importing
 * URLs and uploads, renaming and deleting hub resources, and making context from a resource. Each handler runs the
 * same operation as the hub fn of the same purpose, through `hub.resources` (`resources/index.ts`), as the signed-in
 * person.
 */
import { plugin } from '@ayepi/plugin';
import { resourcesSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';
import type { HubReads } from '../reads.ts';

/** The resources plugin. */
export function resourcesPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>, reads: HubReads) {
  return plugin({ name: 'web.resources', spec: resourcesSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof resourcesSlice> => {
      const { library, forms, reader, context } = hub.resources;
      return {
        // a query is the query standard's (no facets: the list's filters are its own); without one, the grouped browser
        browseResources: async ({ data, user }) => (data.query === undefined ? library.browse(data, { actor: user.id }) : { ...(await reads.lists.page('resources', data.query, user)), facets: [] }),
        resourceForms: ({ data, user }) => forms.forms(data.uri, { actor: user.id }),
        readResource: ({ data, user }) => reader.read(data, { actor: user.id }),
        convertResource: ({ data, user }) => forms.ensure(data.uri, data.kind, { actor: user.id }),
        downloadResource: ({ data, user }) => reader.download(data.uri, data.form, { actor: user.id }),
        importResource: ({ data, user }) => library.import(data, { actor: user.id }),
        renameResource: ({ data, user }) => library.rename(data.uri, data.name, { actor: user.id }),
        deleteResource: ({ data, user }) => library.remove(data.uri, { actor: user.id }),
        contextFromResource: ({ data, user }) => context.fromResource(data, { actor: user.id }),
      };
    });
}
