/**
 * The context slice (resources lane): every context item and its links both ways, memory written and forgotten, and
 * links drawn and removed by people, through `hub.resources.context` (`ContextLibrary`, over the contextor's
 * `ContextGraph`), as the signed-in person. A memory written here has no session, so it is for the person or everyone.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { contextSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';
import type { HubReads } from '../reads.ts';
import { personOperations } from '../person-ops.ts';

/** The context plugin. */
export function contextPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>, reads: HubReads) {
  const person = personOperations(hub);
  return plugin({ name: 'web.context', spec: contextSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof contextSlice> => {
      const { context } = hub.resources;
      return {
        contexts: async ({ data, user }) => {
          if (data.query !== undefined) { return reads.lists.page('contexts', data.query, user); }
          const [access, page] = await Promise.all([hub.access.scope(user.id), context.list(data, { actor: user.id })]);
          return { ...page, items: page.items.filter((item) => access.seesContext(item)) };
        },
        contextItem: async ({ data, user }) => {
          const record = await hub.catalog.context(data.name);
          // an item shared with other people reads as if it weren't there
          if (record !== undefined && !(await hub.access.scope(user.id)).seesContext(record)) { throw reject(404, 'NO_CONTEXT', `there is no context ${data.name}`); }
          return context.item(data.name, { actor: user.id });
        },
        // the browser has no chat session, so a session memory (the schema's default) is the person's own
        remember: ({ data, user }) => context.remember({ ...data, scope: data.scope === 'session' ? 'user' : data.scope }, { actor: user.id, admin: user.role === 'admin' }),
        updateMemory: ({ data, user }) => person.memory_update(data, user),
        forget: async ({ data, user }) => ({ ok: await context.forget(data.name, { actor: user.id }) }),
        linkContext: ({ data, user }) => person.context_link(data, user),
        unlinkContext: ({ data, user }) => person.context_unlink(data, user),
      };
    });
}
