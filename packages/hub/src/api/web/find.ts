/**
 * The finding slice: suggestions for the message being written (by meaning, from the index), hybrid search, `@`
 * mentions and their hover cards, and reading a resource from the system that serves it. Each answers only with what
 * the signed-in person may see (their `AccessScope`); a resource they may not see reads as if it weren't there.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { findSlice, INDEXED_KINDS, type Suggestion } from '@harness/core';

/** What a search without kinds looks through: everything but fn examples, which are read through their fn (`fnExamples`). */
const SEARCHED_KINDS = INDEXED_KINDS.filter((kind) => kind !== 'example');
import type { HubServices } from '../../boot/index.ts';
import { keepSeen, mayOffer } from '../../access/hits.ts';
import { visibleSession, type FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';

/** How many search hits when the browser doesn't say. */
const SEARCH_LIMIT = 20;

/** The finding plugin. */
export function findPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>) {
  const { chat, index, link, catalog } = hub;
  const lookup = (name: Parameters<typeof catalog.context>[0]) => catalog.context(name);
  return plugin({ name: 'web.find', spec: findSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof findSlice> => ({
      suggest: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        const limit = data.limit ?? hub.settings.modelEnv.HARNESS_SUGGESTIONS;
        if (data.text.trim() === '' || limit < 1) { return []; }
        // the session's candidates, then only those the person may be offered (as a sent message's are)
        const [access, found] = await Promise.all([
          hub.access.scope(user.id),
          index.suggest.consider({ session: data.session, text: data.text, pool: limit * 2 }),
        ]);
        const offered: Suggestion[] = [];
        for (const item of found.offered) {
          if (await mayOffer(access, lookup, item, data.session)) { offered.push(item); }
          if (offered.length >= limit) { break; }
        }
        return offered;
      },
      search: async ({ data, user }) => index.search.search({
        text: data.query, kinds: data.kinds ?? SEARCHED_KINDS, limit: data.limit ?? SEARCH_LIMIT, keep: keepSeen(await hub.access.scope(user.id), { context: lookup, type: (name) => catalog.type(name) }),
      }),
      mentions: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        return chat.mentions.search({ session: data.session, actor: user.id, provider: data.provider }, data.query);
      },
      mentionHover: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        const hover = await chat.mentions.hover({ session: data.session, actor: user.id, provider: data.provider }, data.target);
        return hover === undefined ? {} : { hover };
      },
      resource: async ({ data, user, signal }) => {
        if (!(await hub.access.scope(user.id)).seesUri(data.uri)) { throw reject(404, 'NO_RESOURCE', `there is no resource ${data.uri}`); }
        return link.resources.read(data.uri, data.want, signal);
      },
    }));
}
