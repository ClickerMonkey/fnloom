/**
 * The graph views' caller, made once from the one hub client: the graph of systems' items and how they connect, as the
 * signed-in person may see it. Stores receive only this (`GraphApi`), so tests hand them a fake.
 */
import type { Hub } from '../../api/client.ts';

/** Make the graph callers. */
export function graphApi(hub: Hub) {
  return {
    /** One page of the graph; a newer query (a filter changed) supersedes one still on its way. */
    graph: hub.caller('graph', { lastOnly: true }),
  };
}

/** The graph callers. */
export type GraphApi = ReturnType<typeof graphApi>;
