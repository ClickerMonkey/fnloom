/**
 * The resources slice (resources lane): browsing with groups and facets, reading any form, making forms, importing
 * URLs and uploads, renaming and deleting hub resources, and making context from a resource. Each handler runs the
 * same operation as the hub fn of the same purpose, through `hub.resources` (`resources/index.ts`), as the signed-in
 * person.
 */
import { plugin } from '@ayepi/plugin';
import { reject } from '@ayepi/core';
import { resourcesSlice, type UserView } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';
import type { HubReads } from '../reads.ts';

/** The resources plugin. */
export function resourcesPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>, reads: HubReads) {
  return plugin({ name: 'web.resources', spec: resourcesSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof resourcesSlice> => {
      const { library, forms, reader, context } = hub.resources;
      /** The URI, or a 404 when the person may not see it (it reads as if it weren't there). */
      const seen = async <U extends string>(user: UserView, uri: U): Promise<U> => {
        if (!(await hub.access.scope(user.id)).seesUri(uri)) { throw reject(404, 'NO_RESOURCE', `there is no resource ${uri}`); }
        return uri;
      };
      return {
        // a query is the query standard's (no facets: the list's filters are its own); without one, the grouped browser
        browseResources: async ({ data, user }) => {
          if (data.query !== undefined) { return { ...(await reads.lists.page('resources', data.query, user)), facets: [] }; }
          const access = await hub.access.scope(user.id);
          return library.browse(data, { actor: user.id }, (uri) => access.seesUri(uri));
        },
        resourceForms: async ({ data, user }) => forms.forms(await seen(user, data.uri), { actor: user.id }),
        readResource: async ({ data, user }) => reader.read({ ...data, uri: await seen(user, data.uri) }, { actor: user.id }),
        convertResource: async ({ data, user }) => forms.ensure(await seen(user, data.uri), data.kind, { actor: user.id }),
        downloadResource: async ({ data, user }) => reader.download(await seen(user, data.uri), data.form, { actor: user.id }),
        importResource: ({ data, user }) => library.import(data, { actor: user.id }),
        renameResource: async ({ data, user }) => library.rename(await seen(user, data.uri), data.name, { actor: user.id }),
        deleteResource: async ({ data, user }) => library.remove(await seen(user, data.uri), { actor: user.id }),
        contextFromResource: async ({ data, user }) => context.fromResource({ ...data, uri: await seen(user, data.uri) }, { actor: user.id, admin: user.role === 'admin' }),
      };
    });
}
