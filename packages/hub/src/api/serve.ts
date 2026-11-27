/**
 * The files the hub serves itself, outside the API: the built web app (with the single-page fallback, so a refresh
 * on any page loads the app) and systems' client builds at `/clients/<system>/<build hash>/<path>`. Client files are
 * content refs named by their hash, so they are cached for good; the web app's hashed `assets/` are too, and
 * `index.html` is always checked again.
 *
 * Every hub response carries `SECURITY_HEADERS` (`secureResponse`, set by the HTTP front before any route answers):
 * no MIME sniffing, never framed by another page, and the origin only as a referrer. The app page adds its content
 * security policy (`appCsp`). A client build's files other than what a page loads into itself (scripts, styles,
 * fonts, pictures) are sent as downloads, so a build's `.html` or `.svg` never runs as a page on the hub's origin.
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { AUTHORITY_PATHS, SystemName } from '@harness/core';
import type { ContentStore } from './index.ts';
import { mimeOf } from './mime.ts';
import type { SystemLifecycle } from '../link/lifecycle.ts';
import type { HubIdentityService } from '../boot/identity.ts';
import type { Authority } from './tls.ts';

/** Serves one kind of file; resolves true when it answered the request. */
export interface FileRoute {
  serve(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
}

/** The headers every hub response carries (the app page's CSP replaces the bare `frame-ancestors` one). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
};

/** Put `SECURITY_HEADERS` on a response before anything answers it (a route's own headers add to them or replace them). */
export function secureResponse(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) { res.setHeader(name, value); }
}

/**
 * The policy on the presigned file transfers (`/_files`): what people upload is shown as it is (a picture, a video, a
 * PDF, text) but never runs, so an uploaded `.html` or `.svg` opened from its link can't act as the hub's page. The app
 * may frame one (the PDF viewer's fallback), nothing else may.
 */
export const FILES_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; object-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
  'x-frame-options': 'SAMEORIGIN',
};

/** Put `FILES_HEADERS` on a presigned file transfer's response (after `secureResponse`). */
export function secureFileResponse(res: ServerResponse): void {
  for (const [name, value] of Object.entries(FILES_HEADERS)) { res.setHeader(name, value); }
}

/** A `Host` header that is only a host and port (so it can go in a policy as it is). */
const PLAIN_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

/**
 * The web app page's content security policy. Scripts only from the hub (the app's modules, system client builds
 * under `/clients`, pdf.js's worker, the service worker), never inline or `eval`; no plugins, no `<base>`, never
 * framed. Styles allow inline ones: Vue writes static parts of templates as HTML with `style` attributes, and
 * mermaid measures its diagrams with a `<style>` in the page. Images may be anywhere on https (the UI asks before
 * loading outside ones), `data:` and `blob:` (mermaid diagrams, pasted pictures). Requests and sockets go to the
 * hub only: the page's own origin, the host it was reached at over ws/wss, and `HARNESS_URL` (the hub MCPs' URLs).
 */
export function appCsp(hubUrl: string, host: string | undefined): string {
  const hub = new URL(hubUrl);
  const sockets = [hub.host, ...(host !== undefined && PLAIN_HOST.test(host) ? [host] : [])];
  const connect = ["'self'", hub.origin, ...[...new Set(sockets)].flatMap((h) => [`ws://${h}`, `wss://${h}`])];
  return [
    "default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
    "img-src 'self' data: blob: https:", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:", "worker-src 'self' blob:",
    "media-src 'self' blob: data:", `connect-src ${connect.join(' ')}`,
  ].join('; ');
}

/** The file types a client build serves as they are: what a page loads into itself, never a page of its own. */
const CLIENT_INLINE = /\.(?:m?js|css|map|woff2?|ttf|otf|json|wasm|png|jpe?g|gif|webp|avif|ico)$/i;

const FOREVER = 'public, max-age=31536000, immutable';
const ALWAYS_CHECK = 'no-cache';

function send(res: ServerResponse, status: number, headers: Record<string, string | number>, body: Readable | string): void {
  res.writeHead(status, headers);
  if (typeof body === 'string') { res.end(body); } else { body.pipe(res); }
}

/** A decoded URL path or segment, or undefined when it isn't valid percent-encoding. */
function decodePath(part: string): string | undefined {
  try { return decodeURIComponent(part); } catch { return undefined; }
}

/** Answer 404; true, as the request was answered. */
function notFound(res: ServerResponse): true {
  send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found');
  return true;
}

/** Whether a request only wants the headers. */
const headOnly = (req: IncomingMessage): boolean => req.method === 'HEAD';

/** The web app's install manifest's path, made by the hub so the install name is the hub's display name. */
export const MANIFEST_PATH = '/manifest.webmanifest';

/** Text as HTML text and attribute values. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The web app's `index.html` with the hub's display name in its `<title>` and its `apple-mobile-web-app-title`, so the
 * tab and a phone's home screen show the name before the app has started.
 */
export function namedIndexHtml(html: string, name: string): string {
  const safe = escapeHtml(name);
  // replacer functions, so a `$` in the name is never read as a replacement pattern
  return html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${safe}</title>`)
    .replace(/(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/, (_match: string, before: string, after: string) => `${before}${safe}${after}`);
}

/** The app's colours as the install manifest gives them: the page background (light) and the mark's accent. */
export const APP_COLOURS = { background: '#f9fafb', theme: '#f9fafb', accent: '#5b5bd6' } as const;

/**
 * The install manifest for a hub with this display name: what a browser needs to offer Install (name, start URL,
 * scope, standalone display, PNG icons at 192 and 512 and a maskable one, made from the mark by `npm run app:images`),
 * a stable `id` so a rename is the same app, a title bar the app draws itself on desktop (`window-controls-overlay`),
 * screenshots for the richer install sheet, and shortcuts to a new chat and the inbox.
 */
export function webManifest(name: string): string {
  return JSON.stringify({
    id: '/', name, short_name: name, description: `${name}: chat with your agents and the systems your hub connects, on any device.`,
    start_url: '/', scope: '/', display: 'standalone', display_override: ['window-controls-overlay', 'standalone'],
    theme_color: APP_COLOURS.theme, background_color: APP_COLOURS.background, categories: ['productivity', 'utilities'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    screenshots: [
      { src: '/screenshots/wide.png', sizes: '1280x800', type: 'image/png', form_factor: 'wide', label: 'The chat on a computer' },
      { src: '/screenshots/narrow.png', sizes: '780x1688', type: 'image/png', form_factor: 'narrow', label: 'The chat on a phone' },
    ],
    shortcuts: [
      { name: 'New chat', url: '/chat', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      { name: 'Inbox', url: '/inbox', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
    ],
  });
}

/**
 * The hub's own certificate authority, for a phone or computer to install (`/harness-ca.crt` as DER, which iOS
 * and Android open as a profile or certificate; `/harness-ca.pem` as PEM). Public: it is what a device installs to trust
 * the hub. 404 when the hub has no authority of its own (https off before it was ever made, or certificate files given).
 */
export class AuthorityRoute implements FileRoute {
  readonly #authority: () => Authority | undefined;
  readonly #host: string;

  constructor(authority: () => Authority | undefined, host: string) {
    this.#authority = authority;
    this.#host = host;
  }

  serve(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || (path !== AUTHORITY_PATHS.der && path !== AUTHORITY_PATHS.pem)) { return Promise.resolve(false); }
    const authority = this.#authority();
    if (authority === undefined) { return Promise.resolve(notFound(res)); }
    const der = path === AUTHORITY_PATHS.der;
    const body = der ? authority.der : Buffer.from(authority.pem);
    res.writeHead(200, {
      'content-type': der ? 'application/x-x509-ca-cert' : 'application/x-pem-file', 'content-length': body.length, 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="harness-${this.#host}-ca.${der ? 'crt' : 'pem'}"`,
    });
    res.end(headOnly(req) ? undefined : body);
    return Promise.resolve(true);
  }
}

/**
 * The built web app, from a folder. Paths that aren't files get `index.html`, so client routes survive a refresh; the
 * page and the install manifest carry the hub's display name, read on every request so a rename shows at once.
 */
export class WebAppRoute implements FileRoute {
  readonly #root: string;
  readonly #identity: Pick<HubIdentityService, 'identity'>;
  readonly #hubUrl: string;

  /** `hubUrl` is `HARNESS_URL`, which the page's policy lets it reach. */
  constructor(root: string, identity: Pick<HubIdentityService, 'identity'>, hubUrl: string) {
    this.#root = resolve(root);
    this.#identity = identity;
    this.#hubUrl = hubUrl;
  }

  async serve(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') { return false; }
    if (path === MANIFEST_PATH) {
      const body = webManifest((await this.#identity.identity()).name);
      send(res, 200, { 'content-type': 'application/manifest+json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': ALWAYS_CHECK }, headOnly(req) ? '' : body);
      return true;
    }
    const file = await this.#file(path) ?? (this.#looksLikeFile(path) ? undefined : await this.#file('/index.html'));
    if (file === undefined) { return false; }
    if (file.path === join(this.#root, 'index.html')) {
      const body = namedIndexHtml(await readFile(file.path, 'utf8'), (await this.#identity.identity()).name);
      send(res, 200, {
        'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': ALWAYS_CHECK,
        'content-security-policy': appCsp(this.#hubUrl, req.headers.host),
      }, headOnly(req) ? '' : body);
      return true;
    }
    const headers = { 'content-type': mimeOf(file.path), 'content-length': file.size, 'cache-control': path.startsWith('/assets/') ? FOREVER : ALWAYS_CHECK };
    send(res, 200, headers, headOnly(req) ? '' : createReadStream(file.path));
    return true;
  }

  /** A file under the root (never outside it), or undefined. */
  async #file(path: string): Promise<{ path: string; size: number } | undefined> {
    const decoded = decodePath(path);
    if (decoded === undefined) { return undefined; }
    const full = resolve(this.#root, `.${decoded}`);
    if (full !== this.#root && !full.startsWith(this.#root + sep)) { return undefined; }
    const info = await stat(full).catch(() => undefined);
    return info?.isFile() === true ? { path: full, size: info.size } : undefined;
  }

  /** A path with an extension in its last segment names a file; a missing one is a 404, not the app. */
  #looksLikeFile(path: string): boolean {
    return /\.[A-Za-z0-9]+$/.test(path.slice(path.lastIndexOf('/') + 1));
  }
}

/** The prefix client builds are served under. */
export const CLIENTS_PATH = '/clients/';

/** Systems' client builds, from their content refs: only the build an admin approved (`SystemLifecycle.approvedClient`). */
export class ClientBuildRoute implements FileRoute {
  readonly #content: Pick<ContentStore, 'open'>;
  readonly #lifecycle: () => Pick<SystemLifecycle, 'approvedClient'>;

  constructor(options: { content: Pick<ContentStore, 'open'>; lifecycle: () => Pick<SystemLifecycle, 'approvedClient'> }) {
    this.#content = options.content;
    this.#lifecycle = options.lifecycle;
  }

  async serve(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !path.startsWith(CLIENTS_PATH)) { return false; }
    const parts = path.slice(CLIENTS_PATH.length).split('/').map(decodePath);
    if (parts.some((part) => part === undefined)) { return notFound(res); }
    const [system, build, ...rest] = parts;
    const name = SystemName.safeParse(system);
    if (!name.success || build === undefined || rest.length === 0) { return notFound(res); }
    // only a build an admin approved: never one of a system still installed, waiting for review, or switched off
    const client = await this.#lifecycle().approvedClient(name.data);
    const file = client?.hash === build ? client.files.find((f) => f.path === rest.join('/')) : undefined;
    const bytes = file === undefined ? undefined : await this.#content.open(file.hash);
    if (file === undefined || bytes === undefined) { return notFound(res); }
    const headers = {
      'content-type': mimeOf(file.path), 'content-length': bytes.size, 'cache-control': FOREVER, etag: `"${file.hash}"`,
      ...(CLIENT_INLINE.test(file.path) ? {} : { 'content-disposition': 'attachment' }),
    };
    if (req.headers['if-none-match'] === headers.etag) {
      await bytes.stream.cancel();
      send(res, 304, { etag: headers.etag, 'cache-control': FOREVER }, '');
      return true;
    }
    if (headOnly(req)) {
      await bytes.stream.cancel();
      send(res, 200, headers, '');
    } else {
      send(res, 200, headers, Readable.from(bytes.stream));
    }
    return true;
  }
}
