/**
 * The files the hub serves itself, outside the API: the built web app (with the single-page fallback, so a refresh
 * on any page loads the app) and systems' client builds at `/clients/<system>/<build hash>/<path>`. Client files are
 * content refs named by their hash, so they are cached for good; the web app's hashed `assets/` are too, and
 * `index.html` is always checked again.
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { SystemName } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import type { ContentStore } from './index.ts';
import { mimeOf } from './mime.ts';
import { clientItemName, type SystemLifecycle } from '../link/lifecycle.ts';
import type { HubIdentityService } from '../boot/identity.ts';

/** Serves one kind of file; resolves true when it answered the request. */
export interface FileRoute {
  serve(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
}

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
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${safe}</title>`)
    .replace(/(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/, `$1${safe}$2`);
}

/** The install manifest for a hub with this display name. */
export function webManifest(name: string): string {
  return JSON.stringify({
    name, short_name: name, start_url: '/', scope: '/', display: 'standalone',
    icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  });
}

/**
 * The built web app, from a folder. Paths that aren't files get `index.html`, so client routes survive a refresh; the
 * page and the install manifest carry the hub's display name, read on every request so a rename shows at once.
 */
export class WebAppRoute implements FileRoute {
  readonly #root: string;
  readonly #identity: Pick<HubIdentityService, 'identity'>;

  constructor(root: string, identity: Pick<HubIdentityService, 'identity'>) {
    this.#root = resolve(root);
    this.#identity = identity;
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
      send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': ALWAYS_CHECK }, headOnly(req) ? '' : body);
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

/** Systems' client builds, from their content refs; none while switched off or changed and waiting for review. */
export class ClientBuildRoute implements FileRoute {
  readonly #catalog: Pick<Catalog, 'manifest'>;
  readonly #content: Pick<ContentStore, 'open'>;
  readonly #lifecycle: () => Pick<SystemLifecycle, 'off'>;

  constructor(options: { catalog: Pick<Catalog, 'manifest'>; content: Pick<ContentStore, 'open'>; lifecycle: () => Pick<SystemLifecycle, 'off'> }) {
    this.#catalog = options.catalog;
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
    const off = await this.#lifecycle().off('components', { system: name.data });
    const client = off.has(clientItemName(name.data)) ? undefined : (await this.#catalog.manifest(name.data))?.client;
    const file = client?.hash === build ? client.files.find((f) => f.path === rest.join('/')) : undefined;
    const bytes = file === undefined ? undefined : await this.#content.open(file.hash);
    if (file === undefined || bytes === undefined) { return notFound(res); }
    const headers = { 'content-type': mimeOf(file.path), 'content-length': bytes.size, 'cache-control': FOREVER, etag: `"${file.hash}"` };
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
