/**
 * What a web push carries and where its click leads, shared by the app and its service worker (`sw/sw.ts`), so both
 * read the one shape: the notification's own fields, as the hub sends them.
 */
import { Notification } from '@harness/core';
import type { z } from 'zod';

/** What a push carries. */
export const PushPayload = Notification.pick({ id: true, title: true, body: true, link: true, reason: true });
export type PushPayload = z.infer<typeof PushPayload>;

/** The query key the inbox opens a notification by (a push's click lands there). */
export const OPEN_KEY = 'open';

/** Where clicking a push leads: the inbox, which opens the notification as a click there would. */
export function pushOpenPath(payload: Pick<PushPayload, 'id'>): string {
  return `/inbox?${OPEN_KEY}=${encodeURIComponent(payload.id)}`;
}
