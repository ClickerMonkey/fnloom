/** Callers for the notifications inbox and web push, and the user's live events (new notifications among them). */
import { watch } from 'vue';
import type { ActorId, UserEvent } from '@harness/core';
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

/**
 * The signed-in person's live events, from the hub's `user` channel, which hears only the person it names. Follows who
 * is signed in (`me`, reactive): subscribes as them once someone signs in, and again as whoever signs in next.
 */
export function userEvents(hub: Hub, me: () => ActorId | undefined): UserEvents {
  return (listener) => {
    let stop: (() => void) | undefined;
    const unwatch = watch(me, (user) => {
      stop?.();
      stop = user === undefined ? undefined : hub.on('user', { user }, listener);
    }, { immediate: true });
    return () => { unwatch(); stop?.(); };
  };
}
