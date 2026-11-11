/**
 * A system folder as a build reads it: `system.json` at its root (`SystemPackageManifest`), `shared/`, `server/`,
 * `client/`, and `dist/`, what `harness system build` makes and `pack` zips. In `dist/` the entries point at the
 * built files (`server/main.js`, `client/index.js`) and `system.json` has no file list until `pack` adds one.
 */
import { join } from 'node:path';
import { PACKAGE_MANIFEST_FILE, SystemPackageManifest } from '@harness/core';
import type { BuildFiles } from './files.ts';

/** The build output folder of a system folder. */
export const DIST = 'dist';
/** The built entries inside `dist/`. */
export const BUILT = { server: 'server/main.js', client: 'client/index.js' } as const;
/** Folders a build never reads from, and `new` never copies. */
export const NOT_SOURCE = ['node_modules', DIST, '.types', '.harness', 'coverage'] as const;

/** Why a system folder can't be used. */
export class FolderError extends Error {
  override readonly name = 'FolderError';
}

/** Read and check a folder's `system.json`. */
export async function readSystemJson(files: BuildFiles, dir: string): Promise<SystemPackageManifest> {
  const path = join(dir, PACKAGE_MANIFEST_FILE);
  if (await files.stat(path) === undefined) { throw new FolderError(`${dir} has no ${PACKAGE_MANIFEST_FILE}: is it a system folder?`); }
  let json: unknown;
  try {
    json = JSON.parse(await files.readText(path));
  } catch {
    throw new FolderError(`${path} is not JSON`);
  }
  const parsed = SystemPackageManifest.safeParse(json);
  if (!parsed.success) { throw new FolderError(`${path}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`); }
  return parsed.data;
}

/** The manifest `build` writes into `dist/`: entries pointing at the built files, no file list. */
export function builtManifest(manifest: SystemPackageManifest): SystemPackageManifest {
  const { files: _files, client, ...rest } = manifest;
  return { ...rest, server: { ...manifest.server, entry: BUILT.server }, ...(client === undefined ? {} : { client: { entry: BUILT.client } }) };
}

/** Whether `dist/` is missing or older than anything in the source folder. */
export async function isStale(files: BuildFiles, dir: string): Promise<boolean> {
  const built = await files.stat(join(dir, DIST, PACKAGE_MANIFEST_FILE));
  if (built === undefined) { return true; }
  for (const file of await files.walk(dir, NOT_SOURCE)) {
    const seen = await files.stat(file);
    if (seen !== undefined && seen.modified > built.modified) { return true; }
  }
  return false;
}
