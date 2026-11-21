/**
 * Markdown images from outside the hub (M4): an image that loads by itself can carry data out in its URL with no
 * click, so by the admin's setting (`OutsideImages`, Settings › Hub) an image from another host waits for a click.
 * Images from the hub itself and from places in the app load at once. Every image loads with no referrer.
 */
import { OUTSIDE_IMAGES_DEFAULT, type OutsideImages } from '@harness/core';
import type { InjectionKey } from 'vue';

/** The admin's outside-images setting, read when markdown draws (the app provides it from the hub). */
export const OUTSIDE_IMAGES: InjectionKey<() => OutsideImages> = Symbol('outsideImages');

/** Without the app (a component mounted alone): the secure default. */
export const DEFAULT_OUTSIDE_IMAGES = (): OutsideImages => OUTSIDE_IMAGES_DEFAULT;

/** The host an image comes from when that isn't the hub (`origin`), else `undefined` (the hub, or a place in the app). */
export function outsideHost(src: string, origin: string): string | undefined {
  // Judge where the browser will really load from: a relative form can still name another host (`/\evil.test`).
  let url: URL;
  try { url = new URL(src, origin); } catch { return 'an unknown host'; }
  return url.origin === new URL(origin).origin ? undefined : url.host || 'an unknown host';
}
