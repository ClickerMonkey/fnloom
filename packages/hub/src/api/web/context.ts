/**
 * The context slice (resources lane): every context item and its links both ways, memory written and forgotten, and
 * links drawn and removed by people, through `hub.resources.context` (`ContextLibrary`, over the contextor's
 * `ContextGraph`), as the signed-in person. A memory written here has no session, so it is for the person or everyone.
 */
import { plugin } from '@ayepi/plugin';
import { contextSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';
import type { HubReads } from '../reads.ts';

/** The context plugin. */
export function contextPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>, reads: HubReads) {
  return plugin({ name: 'web.context', spec: contextSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof contextSlice> => {
      const { context } = hub.resources;
      return {
        contexts: ({ data, user }) => (data.query === undefined ? context.list(data, { actor: user.id }) : reads.lists.page('contexts', data.query, user)),
        contextItem: ({ data, user }) => context.item(data.name, { actor: user.id }),
        // the browser has no chat session, so a session memory (the schema's default) is the person's own
        remember: ({ data, user }) => context.remember({ ...data, scope: data.scope === 'session' ? 'user' : data.scope }, { actor: user.id }),
        updateMemory: ({ data, user }) => context.update(data, { actor: user.id }),
        forget: async ({ data, user }) => ({ ok: await context.forget(data.name, { actor: user.id }) }),
        linkContext: ({ data, user }) => context.link(data, { actor: user.id }),
        unlinkContext: async ({ data, user }) => ({ ok: await context.unlink(data, { actor: user.id }) }),
      };
    });
}
