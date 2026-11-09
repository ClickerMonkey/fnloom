/**
 * The pickers' and visibility controls' callers, made once from the one hub client: `pick` (options for a picker, or
 * the labels of values already picked), whether the hub has more than one person, a thing's visibility, and changing
 * it. They join the chat's callers (`chatApi`), as every page reaches them through the chat store.
 */
import type { Hub } from './client.ts';

/** The cache tag of visibilities, cleared when one is changed. */
export const ACCESS_TAG = 'access';

/** Make the picker and visibility callers. */
export function pickerApi(hub: Hub) {
  return {
    pick: hub.caller('pick', { cache: { ttl: 15_000 }, dedupe: true }),
    accessInfo: hub.caller('accessInfo', { cache: { ttl: 60_000 }, dedupe: true }),
    access: hub.caller('access', { cache: { ttl: 30_000, tags: [ACCESS_TAG] }, dedupe: true }),
    setAccess: hub.caller('setAccess', { invalidates: [ACCESS_TAG] }),
  };
}

/** The picker and visibility callers. */
export type PickerApi = ReturnType<typeof pickerApi>;
