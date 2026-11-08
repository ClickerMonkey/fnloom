/**
 * The resource browser's URL state: the query read through its one schema (`BrowserQuery`), and changes written back
 * in one navigation, so several keys changed together (a new group clears `in`) never race. Filters replace the
 * history entry; opening a resource pushes one, so Back closes it.
 */
import { computed, type ComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { patchQuery, readQuery, type BrowserQuery } from '../logic/browse.ts';

/** A change to the browser's query: a key set, or removed with '' or `undefined`. */
export type QueryPatch = { readonly [K in keyof BrowserQuery]?: BrowserQuery[K] | '' };

/** The browser's query and the way to change it. */
export interface BrowserUrl {
  readonly query: ComputedRef<BrowserQuery>;
  /** Change some keys; `push` makes a history entry (opening a resource), otherwise it is replaced. */
  set(patch: QueryPatch, options?: { readonly push?: boolean }): void;
}

/** Read and write the browser's query. Call in a component's setup. */
export function useBrowserUrl(): BrowserUrl {
  const route = useRoute();
  const router = useRouter();
  const query = computed(() => readQuery(route.query));
  return {
    query,
    set: (patch, options = {}) => {
      const to = { query: patchQuery(query.value, patch), hash: route.hash };
      void (options.push === true ? router.push(to) : router.replace(to));
    },
  };
}
