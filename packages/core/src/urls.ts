/**
 * Web addresses that the app opens or links to, and the admin's setting for images from outside the hub.
 *
 * `z.url()` takes any scheme, `javascript:` and `data:` included, so a URL a system or a model sends that the app later
 * opens (`location.assign`, an `href`, `window.open`) is an `HttpUrl`: `http:` or `https:` only, with no whitespace
 * or control characters (browsers drop some of them, which can hide a scheme). The web app's links go through the
 * SDK's `safeHref`, which allows the same web addresses plus mail and places inside the app.
 */
import { z } from 'zod';
import { ActorId, Timestamp } from './primitives.ts';

/** `http://` or `https://` (any case), then no whitespace or control characters. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
const HTTP_URL_PATTERN = /^https?:\/\/[^\s\u0000-\u001f\u007f]+$/i;

/** Whether `text` parses as a URL whose scheme is http or https. */
function parsesAsHttp(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** An http or https URL, safe to open or link to: never `javascript:`, `data:`, `vbscript:` or a URL with hidden characters. */
export const HttpUrl = z.string().regex(HTTP_URL_PATTERN, 'expected an http or https URL').refine(parsesAsHttp, 'expected an http or https URL');
export type HttpUrl = z.infer<typeof HttpUrl>;

/** Whether `text` is an `HttpUrl`. */
export function isHttpUrl(text: string): boolean {
  return HttpUrl.safeParse(text).success;
}

/** The hub option key of the outside-images setting. */
export const OUTSIDE_IMAGES_OPTION = 'outsideImages';

/**
 * Markdown images from hosts other than the hub: `ask` shows a placeholder that loads the image when clicked (an image
 * that loads by itself can carry data out in its URL with no click); `always` loads them at once.
 */
export const OutsideImages = z.enum(['ask', 'always']);
export type OutsideImages = z.infer<typeof OutsideImages>;

/** The secure default: ask before loading. */
export const OUTSIDE_IMAGES_DEFAULT: OutsideImages = 'ask';

/** The setting in use, who set it and when (nothing stored: the default). */
export const OutsideImagesView = z.object({ value: OutsideImages, setBy: ActorId.optional(), updatedAt: Timestamp.optional() });
export type OutsideImagesView = z.infer<typeof OutsideImagesView>;
