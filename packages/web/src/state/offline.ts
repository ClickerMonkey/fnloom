/**
 * The installed app's offline page: the service worker (`sw/sw.ts`) keeps it, and only it, in `OFFLINE_CACHE`, and
 * answers a page load with it when the network fails. The app and its data always come from the hub.
 */

/** The one cache the service worker keeps; a new name drops the old one when the worker activates. */
export const OFFLINE_CACHE = 'harness-offline-v1';
/** The offline page (`public/offline.html`, self-contained). */
export const OFFLINE_PAGE = '/offline.html';
/** Everything the cache holds. */
export const OFFLINE_FILES = [OFFLINE_PAGE] as const;

/** A page load: the network's answer whatever it is (an error page from the hub too); the offline page only when the network fails. */
export async function offlineFallback(network: () => Promise<Response>, offline: () => Promise<Response>): Promise<Response> {
  try {
    return await network();
  } catch {
    return offline();
  }
}
