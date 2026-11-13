/**
 * `mentionResources` on the hub link (build 8): a system's search of the hub's resources for an `@` search the hub
 * sent it. The request names who is mentioning (`MentionRequests`); the search runs as that person, through the hub's
 * index, keeping only what they may see in the session's systems, inside the roots the system names.
 */
import { spec, type HandlerFor } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { hubLinkSpec, ResourceHit, type ActorId, type MentionResourceHits, type MentionResourceSearch, type SystemName } from '@harness/core';
import type { AccessScope } from '../access/index.ts';
import { keepSeen } from '../access/hits.ts';
import type { Catalog } from '../catalog/index.ts';
import type { Search } from '../index/index.ts';
import { parseSectionIndexKey } from '../index/indexer.ts';
import type { HubStore } from '../store/index.ts';
import type { MentionRequests } from './mention-requests.ts';
import { searchSystems } from './support.ts';

/** The slice of the hub link this answers. */
export const MENTION_SEARCH_LINK_SPEC = spec({ endpoints: { mentionResources: hubLinkSpec.endpoints.mentionResources } });
type Spec = typeof MENTION_SEARCH_LINK_SPEC;

/** How much of a hit's text a preview shows. */
const PREVIEW = 240;

/** What the search uses, each looked up when a call arrives. */
export interface MentionSearchDeps {
  readonly requests: () => Pick<MentionRequests, 'check'>;
  readonly store: () => HubStore;
  readonly search: () => Pick<Search, 'search'>;
  readonly catalog: () => Pick<Catalog, 'context' | 'type'>;
  readonly access: (actor: ActorId) => Promise<AccessScope>;
}

/** The handler. */
export function mentionSearchHandler(deps: MentionSearchDeps): HandlerFor<Spec, Spec['endpoints']['mentionResources']> {
  return ({ data, link }) => searchForMention(deps, data, link.system);
}

/** Search the hub's resources for one of `system`'s mention requests, as the person mentioning. */
export async function searchForMention(deps: MentionSearchDeps, data: MentionResourceSearch, system: SystemName): Promise<MentionResourceHits> {
  const asked = await deps.requests().check(data.request, system);
  const [access, session] = await Promise.all([deps.access(asked.actor), deps.store().table('sessions').get(asked.session)]);
  if (session === undefined) { return { hits: [] }; }
  const seen = keepSeen(access, { context: (name) => deps.catalog().context(name), type: (name) => deps.catalog().type(name) }, session.id);
  const roots = data.roots;
  const found = await deps.search().search({
    // words alone: an `@` search answers as the person types, inside HARNESS_MENTION_SEARCH_TIMEOUT, which waiting on the
    // embedder for the query's vector would use up
    text: data.query, kinds: ['section'], limit: data.limit, systems: searchSystems(session), match: 'text',
    // inside the roots the system asked for, as the person may see them; checked before the limit counts
    keep: async (hit) => (roots === undefined || roots.some((root) => parseSectionIndexKey(hit.key).uri.startsWith(root))) && await seen(hit),
  });
  return {
    hits: found.map((hit) => {
      const at = parseSectionIndexKey(hit.key);
      return ResourceHit.parse({ ...at, title: hit.text.split('\n', 1)[0]?.slice(0, 120) ?? at.uri, preview: hit.text.slice(0, PREVIEW), score: hit.score });
    }),
  };
}

/** The search as an `@ayepi/plugin` on the hub link (the link module binds `linkSession`). */
export function mentionSearchPlugin(deps: MentionSearchDeps) {
  return plugin({ name: 'link.mention-search', spec: MENTION_SEARCH_LINK_SPEC }).handlers(() => ({ mentionResources: mentionSearchHandler(deps) }));
}
