/**
 * The files the hub serves itself, outside the API: the built web app (with the single-page fallback, so a refresh
 * on any page loads the app) and systems' client builds at `/clients/<system>/<build hash>/<path>`. Client files are
 * content refs named by their hash, so they are cached for good; the web app's hashed `assets/` are too, and
 * `index.html` is always checked again.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { SystemName } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import type { ContentStore } from './index.ts';
import { mimeOf } from './mime.ts';

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

/** The built web app, from a folder. Paths that aren't files get `index.html`, so client routes survive a refresh. */
export class WebAppRoute implements FileRoute {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async serve(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') { return false; }
    const file = await this.#file(path) ?? (this.#looksLikeFile(path) ? undefined : await this.#file('/index.html'));
    if (file === undefined) { return false; }
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

/** Systems' client builds, from their content refs. */
export class ClientBuildRoute implements FileRoute {
  readonly #catalog: Pick<Catalog, 'manifest'>;
  readonly #content: Pick<ContentStore, 'open'>;

  constructor(options: { catalog: Pick<Catalog, 'manifest'>; content: Pick<ContentStore, 'open'> }) {
    this.#catalog = options.catalog;
    this.#content = options.content;
  }

  async serve(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !path.startsWith(CLIENTS_PATH)) { return false; }
    const parts = path.slice(CLIENTS_PATH.length).split('/').map(decodePath);
    if (parts.some((part) => part === undefined)) { return notFound(res); }
    const [system, build, ...rest] = parts;
    const name = SystemName.safeParse(system);
    if (!name.success || build === undefined || rest.length === 0) { return notFound(res); }
    const client = (await this.#catalog.manifest(name.data))?.client;
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
