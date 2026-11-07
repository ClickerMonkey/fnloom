/**
 * The web app's service worker. It shows each web push the hub sends (a notification's title and body, tagged by its
 * id so a repeat replaces it), and a click focuses an open window of the app at that inbox item, or opens one. It
 * caches nothing: the app always loads fresh from the hub.
 */
import { pushOpenPath, PushPayload } from '../src/state/push-payload.ts';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  const parsed = PushPayload.safeParse(event.data?.json());
  if (!parsed.success) { return; }
  const payload = parsed.data;
  event.waitUntil(self.registration.showNotification(payload.title, { body: payload.body, tag: payload.id, icon: '/favicon.svg', data: pushOpenPath(payload) }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data: unknown = event.notification.data;
  const path = typeof data === 'string' && data.startsWith('/') ? data : '/inbox';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows[0];
    if (open === undefined) { await self.clients.openWindow(path); return; }
    await open.navigate(path);
    await open.focus();
  })());
});
