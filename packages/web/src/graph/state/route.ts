/**
 * The graph query held in the page's URL (`GraphUrl` keys), so filters, search, focus and collapsed systems survive a
 * refresh and can be linked to. Other query keys of the page stay as they are. `fixed` parts (a system's own graph
 * always shows that system) are added on read and never written.
 */
import type { GraphQuery } from '@harness/core';
import { computed, type WritableComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { graphQueryOf, graphUrlOf, GRAPH_URL_KEYS, readGraphUrl } from '../logic/graph.ts';

/** The graph query in the URL, read and written. Call in a component's setup. */
export function useGraphQuery(fixed: () => GraphQuery = () => ({})): WritableComputedRef<GraphQuery> {
  const route = useRoute();
  const router = useRouter();
  return computed({
    get: () => {
      return { ...graphQueryOf(readGraphUrl(route.query)), ...fixed() };
    },
    set: (query) => {
      const pinned = fixed();
      const free: GraphQuery = { ...query };
      for (const key of Object.keys(pinned)) { Reflect.deleteProperty(free, key); }
      const kept = Object.fromEntries(Object.entries(route.query).filter(([key]) => !GRAPH_URL_KEYS.some((graphKey) => graphKey === key)));
      void router.replace({ query: { ...kept, ...graphUrlOf(free) }, hash: route.hash });
    },
  });
}
