/**
 * A system's built client renderers, as the hub serves them to the chat. The folder `buildClient` writes holds an
 * entry module and its chunks; each file is uploaded to the hub as content, and the manifest lists them by path and
 * hash (`ClientAssets`), so the hub serves exactly the version the system runs.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { ClientAssets } from '@harness/core';
import { contentHash, type ContentTransfer } from './content.ts';

/** The entry module a client build writes. */
export const CLIENT_ENTRY = 'index.js';

const MIME: Readonly<Record<string, string>> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json', '.svg': 'image/svg+xml' };

function mimeOfAsset(path: string): string {
  const dot = path.lastIndexOf('.');
  return MIME[dot < 0 ? '' : path.slice(dot)] ?? 'application/octet-stream';
}

async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
}

/** A built client folder's files, with their bytes. */
export interface ClientBundle {
  readonly assets: ClientAssets;
  readonly files: ReadonlyArray<{ path: string; mime: string; bytes: Uint8Array }>;
}

/** Read a built client folder: every file, hashed, and the bundle's hash over all of them. */
export async function readClientBundle(folder: string): Promise<ClientBundle> {
  const files = await Promise.all((await filesUnder(folder)).map(async (file) => {
    const path = relative(folder, file).split(sep).join('/');
    return { path, mime: mimeOfAsset(path), bytes: new Uint8Array(await readFile(file)) };
  }));
  if (!files.some((file) => file.path === CLIENT_ENTRY)) { throw new Error(`The client build in ${folder} has no ${CLIENT_ENTRY}.`); }
  const listed = files.map((file) => ({ path: file.path, size: file.bytes.length, hash: contentHash(file.bytes) }));
  const hash = contentHash(new TextEncoder().encode(listed.map((file) => `${file.path}:${file.hash}`).join('\n')));
  return { assets: ClientAssets.parse({ entry: CLIENT_ENTRY, hash, files: listed }), files };
}

/** Upload every file of a bundle to the hub. */
export async function uploadClientBundle(bundle: ClientBundle, content: ContentTransfer, signal?: AbortSignal): Promise<void> {
  for (const file of bundle.files) { await content.upload(file.bytes, file.mime, signal); }
}
