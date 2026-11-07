/** Callers for the notifications inbox and web push, and the user's live events (new notifications among them). */
import type { UserEvent } from '@harness/core';
import type { Hub } from './client.ts';

/** The inbox's cache tag, cleared when notifications are marked read. */
export const INBOX_TAG = 'inbox';

/** Make the inbox callers. */
export function notificationsApi(hub: Hub) {
  return {
    list: hub.caller('notifications', { cache: { ttl: 10_000, tags: [INBOX_TAG] }, dedupe: true }),
    markRead: hub.caller('readNotifications', { invalidates: [INBOX_TAG], retry: { attempts: 3 } }),
    pushKey: hub.caller('pushKey', { cache: { ttl: 3_600_000 }, dedupe: true }),
    subscribePush: hub.caller('subscribePush', { retry: { attempts: 3 } }),
  };
}

/** The inbox callers. */
export type NotificationsApi = ReturnType<typeof notificationsApi>;

/** Listen to what the hub tells this user; returns the function that stops listening. */
export type UserEvents = (listener: (event: UserEvent) => void) => () => void;

/** The user's live events, from the hub's `user` channel. */
export function userEvents(hub: Hub): UserEvents {
  return (listener) => hub.on('user', listener);
}
