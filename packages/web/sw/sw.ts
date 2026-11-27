/**
 * The web app's service worker. It shows each web push the hub sends (a notification's title and body, tagged by its
 * key, else its id, so a repeat replaces it; its second link, when it has one, as an action), and a click focuses an
 * open window of the app at that inbox item (following the second link for the action), or opens one.
 *
 * Page loads go to the network first, always: the app and its data are never served from a cache, so nothing is ever
 * stale. Only when the network fails does a page load get the offline page ("Can't reach your hub"), kept with the
 * mark at install (`OFFLINE_CACHE`), instead of the browser's error. Everything else (the API, sockets, files,
 * scripts) passes straight through.
 */
import { ALSO_ACTION, clickedPath, pushTag, pushTargets, PushPayload } from '../src/state/push-payload.ts';
import { OFFLINE_CACHE, OFFLINE_FILES, OFFLINE_PAGE, offlineFallback } from '../src/state/offline.ts';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.addAll([...OFFLINE_FILES]);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // an older offline cache goes; nothing else is ever cached
    for (const name of await caches.keys()) { if (name !== OFFLINE_CACHE) { await caches.delete(name); } }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET') { return; }
  event.respondWith(offlineFallback(() => fetch(event.request), async () => (await caches.match(OFFLINE_PAGE, { cacheName: OFFLINE_CACHE })) ?? Response.error()));
});

self.addEventListener('push', (event) => {
  const parsed = PushPayload.safeParse(event.data?.json());
  if (!parsed.success) { return; }
  const payload = parsed.data;
  // `actions` and `renotify` are not in every DOM typing yet; browsers without them ignore them
  const options: NotificationOptions & { actions?: { action: string; title: string }[]; renotify?: boolean } = {
    body: payload.body, tag: pushTag(payload), icon: '/icons/icon-192.png', data: pushTargets(payload),
    ...(payload.key === undefined ? {} : { renotify: true }),
    ...(payload.also === undefined ? {} : { actions: [{ action: ALSO_ACTION, title: payload.also.label }] }),
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = clickedPath(event.notification.data, event.action);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows[0];
    if (open === undefined) { await self.clients.openWindow(path); return; }
    await open.navigate(path);
    await open.focus();
  })());
});
