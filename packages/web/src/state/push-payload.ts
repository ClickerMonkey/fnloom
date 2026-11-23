/**
 * What a web push carries and where its click leads, shared by the app and its service worker (`sw/sw.ts`), so both
 * read the one shape: the notification's own fields, as the hub sends them. A push with a second link (`also`) offers
 * it as an action; one with a `key` is tagged by it, so a later one of the same key replaces it on the phone.
 */
import { Notification } from '@harness/core';
import { z } from 'zod';

/** What a push carries. */
export const PushPayload = Notification.pick({ id: true, title: true, body: true, link: true, reason: true, also: true, key: true, tone: true });
export type PushPayload = z.infer<typeof PushPayload>;

/** The query key the inbox opens a notification by (a push's click lands there). */
export const OPEN_KEY = 'open';
/** The query key saying which of a notification's links to follow when the inbox opens it (`also`: its second). */
export const VIA_KEY = 'via';

/** Which of a notification's links opening it follows: its main link, or its second (`also`). */
export const NoticeVia = z.enum(['link', 'also']);
export type NoticeVia = z.infer<typeof NoticeVia>;

/** The push action that opens a notification's second link. */
export const ALSO_ACTION = 'also';

/** Where clicking a push leads: the inbox, which opens the notification as a click there would (its second link for the action). */
export function pushOpenPath(payload: Pick<PushPayload, 'id'>, via: NoticeVia = 'link'): string {
  return `/inbox?${OPEN_KEY}=${encodeURIComponent(payload.id)}${via === 'also' ? `&${VIA_KEY}=also` : ''}`;
}

/** The tag a push is shown under: its key when it has one (a later one replaces it), else its own id. */
export function pushTag(payload: Pick<PushPayload, 'id' | 'key'>): string {
  return payload.key ?? payload.id;
}

/** Where a push leads when clicked (`link`) and when its action is (`also`), kept on the shown notification. */
export interface PushTargets {
  readonly link: string;
  readonly also?: string;
}

/** The paths a push's click and action open. */
export function pushTargets(payload: Pick<PushPayload, 'id' | 'also'>): PushTargets {
  return payload.also === undefined ? { link: pushOpenPath(payload) } : { link: pushOpenPath(payload), also: pushOpenPath(payload, 'also') };
}

/** The path a click opens: the action's when it was the action, else the push's own (an older push kept a bare path). */
export function clickedPath(data: unknown, action: string): string {
  const inApp = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
  if (inApp(data)) { return data; }
  if (typeof data === 'object' && data !== null) {
    const also: unknown = Reflect.get(data, 'also');
    const link: unknown = Reflect.get(data, 'link');
    if (action === ALSO_ACTION && inApp(also)) { return also; }
    if (inApp(link)) { return link; }
  }
  return '/inbox';
}
