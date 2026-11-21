/**
 * Where a link built from data may go: the one check for every `href`, `window.open` and `location.assign` the chat and
 * system renderers make from a URL a system, a model or a page sent. Browser-safe (no Node).
 */
import { isHttpUrl } from '@harness/core';

/**
 * A resource URI a system serves (`fs://docs/a.md`, and `file:///C:/…`, which the fs system's resources are): a
 * scheme, then `://`; never one a browser would run or load as a page. The chat opens these in its resource viewer.
 */
export const RESOURCE_LINK = /^(?!(?:javascript|data|vbscript|https?|blob):)[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/**
 * A place inside the app: a path or a relative path. Never `//host`, nor `/\host`, which browsers read as `//host`
 * (another site).
 */
export const APP_PATH = /^(\/(?![/\\])|\.{1,2}\/)/;

/** Mail, a fragment, or a place inside the app. */
const APP_OR_MAIL = new RegExp(`^mailto:|^#|${APP_PATH.source}`, 'i');

/** Whitespace or control characters, which browsers drop from URLs and so can hide a scheme or a `//`. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
const HIDDEN = /[\s\u0000-\u001f\u007f]/;

/**
 * The URL if a link may go there, else `undefined`: http and https (`HttpUrl`), mail, places in the app, and resource
 * URIs (the resource viewer opens them). Refuses `javascript:`, `data:`, `vbscript:`, protocol-relative URLs and any
 * URL with whitespace or control characters inside. Show a refused URL as plain text, never as a link.
 */
export function safeHref(url: string | undefined | null): string | undefined {
  const trimmed = url?.trim() ?? '';
  if (trimmed === '' || HIDDEN.test(trimmed)) { return undefined; }
  return isHttpUrl(trimmed) || APP_OR_MAIL.test(trimmed) || RESOURCE_LINK.test(trimmed) ? trimmed : undefined;
}
