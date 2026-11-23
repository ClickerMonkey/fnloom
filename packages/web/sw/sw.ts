/**
 * The web app's service worker. It shows each web push the hub sends (a notification's title and body, tagged by its
 * key, else its id, so a repeat replaces it; its second link, when it has one, as an action), and a click focuses an
 * open window of the app at that inbox item (following the second link for the action), or opens one. It caches
 * nothing: the app always loads fresh from the hub.
 */
import { ALSO_ACTION, clickedPath, pushTag, pushTargets, PushPayload } from '../src/state/push-payload.ts';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  const parsed = PushPayload.safeParse(event.data?.json());
  if (!parsed.success) { return; }
  const payload = parsed.data;
  // `actions` and `renotify` are not in every DOM typing yet; browsers without them ignore them
  const options: NotificationOptions & { actions?: { action: string; title: string }[]; renotify?: boolean } = {
    body: payload.body, tag: pushTag(payload), icon: '/favicon.svg', data: pushTargets(payload),
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
