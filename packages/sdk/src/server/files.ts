/**
 * `ctx.files`: file operations for a run. The default `NodeFiles` works on the local disk relative to a base folder;
 * a system that limits paths (the fs system's roots) passes its own `FilesFactory` to `serve`. `share` uploads a file
 * to the hub so it can be attached or passed by ref.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ResourceStat, ResourceUri, type ContentRef } from '@harness/core';
import type { Files } from '../ctx.ts';
import type { ContentTransfer } from './content.ts';

/** What a `FilesFactory` gets for each run. */
export interface FilesScope {
  readonly content: ContentTransfer;
  readonly signal: AbortSignal;
}

/** Makes the `Files` a run gets. */
export type FilesFactory = (scope: FilesScope) => Files;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.ts': 'text/typescript', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.vue': 'text/plain', '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv', '.yaml': 'text/yaml',
  '.yml': 'text/yaml', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip',
};

/** A file's MIME type from its extension; `application/octet-stream` when unknown. */
export function mimeOf(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** A file's `file://` URI. */
export function fileUri(path: string): ResourceUri {
  return ResourceUri.parse(pathToFileURL(path).href);
}

/** `Files` on the local disk. Relative paths resolve against `base`. */
export class NodeFiles implements Files {
  readonly #base: string;
  readonly #content: ContentTransfer;
  readonly #signal: AbortSignal;

  constructor(base: string, scope: FilesScope) {
    this.#base = base;
    this.#content = scope.content;
    this.#signal = scope.signal;
  }

  /** A factory for `serve`'s `files` option, rooted at `base`. */
  static at(base: string): FilesFactory {
    return (scope) => new NodeFiles(base, scope);
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.#path(path), { signal: this.#signal }));
  }

  async readText(path: string): Promise<string> {
    return readFile(this.#path(path), { encoding: 'utf8', signal: this.#signal });
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const full = this.#path(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data, { signal: this.#signal });
  }

  async list(path: string): Promise<ResourceStat[]> {
    const folder = this.#path(path);
    const names = await readdir(folder);
    return Promise.all(names.sort().map(async (name) => statOf(resolve(folder, name), name)));
  }

  async remove(path: string): Promise<void> {
    await rm(this.#path(path), { recursive: true, force: true });
  }

  async share(path: string): Promise<ContentRef> {
    return this.#content.upload(await this.read(path), mimeOf(path), this.#signal);
  }

  #path(path: string): string {
    return resolve(this.#base, path);
  }
}

async function statOf(path: string, name: string): Promise<ResourceStat> {
  const info = await stat(path);
  const folder = info.isDirectory();
  return ResourceStat.parse({
    uri: fileUri(path),
    name,
    type: folder ? 'folder' : 'file',
    ...(folder ? {} : { mime: mimeOf(path), size: info.size }),
    modifiedAt: Math.trunc(info.mtimeMs),
    version: `${Math.trunc(info.mtimeMs)}-${info.size}`,
  });
}
