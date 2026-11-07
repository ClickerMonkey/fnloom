/**
 * The finding slice: suggestions for the message being written (by meaning, from the index), hybrid search, `@`
 * mentions and their hover cards, and reading a resource from the system that serves it.
 */
import { plugin } from '@ayepi/plugin';
import { findSlice, INDEXED_KINDS } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { visibleSession, type FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';

/** How many search hits when the browser doesn't say. */
const SEARCH_LIMIT = 20;

/** The finding plugin. */
export function findPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>) {
  const { chat, index, link } = hub;
  return plugin({ name: 'web.find', spec: findSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof findSlice> => ({
      suggest: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        if (data.text.trim() === '') { return []; }
        return index.suggest.suggest({ session: data.session, text: data.text, limit: data.limit ?? hub.settings.modelEnv.HARNESS_SUGGESTIONS });
      },
      search: ({ data }) => index.search.search({ text: data.query, kinds: data.kinds ?? INDEXED_KINDS, limit: data.limit ?? SEARCH_LIMIT }),
      mentions: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        return chat.mentions.search({ session: data.session, actor: user.id, provider: data.provider }, data.query);
      },
      mentionHover: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        const hover = await chat.mentions.hover({ session: data.session, actor: user.id, provider: data.provider }, data.target);
        return hover === undefined ? {} : { hover };
      },
      resource: ({ data, signal }) => link.resources.read(data.uri, data.want, signal),
    }));
}
