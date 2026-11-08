/**
 * `system.json`: a system package's manifest (core's `SystemPackageManifest`), the one source of its name, version and
 * entries. These helpers are what `serve()` and the `harness` CLI share: read it from a folder, check it against the
 * contract it ships, write the built copy (`dist/system.json`), record the packed files' hashes, and check them again
 * when a package is installed.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LINK_PROTOCOL, MAIN_INSTANCE, PACKAGE_MANIFEST_FILE, PackagePath, SystemPackageManifest, messageOf, type InstanceName } from '@harness/core';
import type { AnyContract } from '../system.ts';
import { contentHash } from './content.ts';

/** A `system.json` that could not be read or does not fit `SystemPackageManifest`. */
export class PackageManifestError extends Error {
  override readonly name = 'PackageManifestError';
  /** The file it is about. */
  readonly file: string;
  constructor(file: string, message: string, options?: { cause: unknown }) {
    super(`${file}: ${message}`, options);
    this.file = file;
  }
}

/** Parse a `system.json`'s text. `file` names it in the error. */
export function parsePackageManifest(text: string, file: string = PACKAGE_MANIFEST_FILE): SystemPackageManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new PackageManifestError(file, `not JSON: ${messageOf(error)}`, { cause: error });
  }
  const parsed = SystemPackageManifest.safeParse(json);
  if (!parsed.success) {
    throw new PackageManifestError(file, parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
  }
  return parsed.data;
}

/** The `system.json` in a folder. Throws `PackageManifestError` when it is missing or wrong. */
export async function readPackageManifest(dir: string): Promise<SystemPackageManifest> {
  const file = join(dir, PACKAGE_MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new PackageManifestError(file, `cannot be read: ${messageOf(error)}`, { cause: error });
  }
  return parsePackageManifest(text, file);
}

/** The `system.json` in a folder, or `undefined` when the folder has none (one that can't be read or is wrong throws). */
export async function findPackageManifest(dir: string): Promise<SystemPackageManifest | undefined> {
  const file = join(dir, PACKAGE_MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) { return undefined; }
    throw new PackageManifestError(file, `cannot be read: ${messageOf(error)}`, { cause: error });
  }
  return parsePackageManifest(text, file);
}

/** Whether a file system error says the file isn't there. */
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * What is wrong with a package for the contract it ships: the contract's name must be the manifest's, the manifest
 * must speak this SDK's link protocol (its format is checked by the schema), and a system that runs one instance
 * (`instances: 'one'`) runs only as `main`. Empty when they agree.
 */
export function packageProblems(contract: AnyContract, manifest: SystemPackageManifest, instance: InstanceName = MAIN_INSTANCE): string[] {
  const problems: string[] = [];
  if (manifest.instances === 'one' && instance !== MAIN_INSTANCE) {
    problems.push(`${PACKAGE_MANIFEST_FILE} says ${manifest.name} runs one instance (${MAIN_INSTANCE}), but this one is ${instance}`);
  }
  if (contract.name !== manifest.name) {
    problems.push(`the contract is named ${contract.name} but ${PACKAGE_MANIFEST_FILE} names ${manifest.name}`);
  }
  if (manifest.protocol !== LINK_PROTOCOL) {
    problems.push(`${PACKAGE_MANIFEST_FILE} speaks link protocol ${manifest.protocol}; this SDK speaks ${LINK_PROTOCOL}`);
  }
  return problems;
}

/** `packageProblems`, thrown as one error. */
export function checkPackage(contract: AnyContract, manifest: SystemPackageManifest, instance?: InstanceName): void {
  const problems = packageProblems(contract, manifest, instance);
  if (problems.length > 0) { throw new PackageManifestError(PACKAGE_MANIFEST_FILE, problems.join('; ')); }
}

/** The entries a build wrote, relative to the built folder: `server/main.js` and, with renderers, `client/index.js`. */
export interface BuiltEntries {
  readonly server: string;
  readonly client?: string;
}

/**
 * The built copy of a manifest (`dist/system.json`): the source's facts with the built entries. Any file hashes are
 * dropped; `pack` writes them for the files it packs.
 */
export function builtPackageManifest(manifest: SystemPackageManifest, entries: BuiltEntries): SystemPackageManifest {
  const { files: _files, client: _client, ...rest } = manifest;
  return SystemPackageManifest.parse({
    ...rest,
    server: { ...manifest.server, entry: PackagePath.parse(entries.server) },
    ...(entries.client === undefined ? {} : { client: { entry: PackagePath.parse(entries.client) } }),
  });
}

/** A manifest that lists the sha-256 of every file packed beside it (paths relative to the package, forward slashes). */
export function packedPackageManifest(manifest: SystemPackageManifest, files: ReadonlyMap<string, Uint8Array>): SystemPackageManifest {
  const hashes = Object.fromEntries([...files].filter(([path]) => path !== PACKAGE_MANIFEST_FILE).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [PackagePath.parse(path), contentHash(bytes)]));
  return SystemPackageManifest.parse({ ...manifest, files: hashes });
}

/**
 * What is wrong with a package's files against its manifest's hashes: a listed file missing or changed, or a file
 * the manifest doesn't list (`system.json` itself aside). Empty when they match; a manifest without hashes matches
 * nothing (it was never packed).
 */
export function packageFileProblems(manifest: SystemPackageManifest, files: ReadonlyMap<string, Uint8Array>): string[] {
  const listed = manifest.files;
  if (listed === undefined) { return [`${PACKAGE_MANIFEST_FILE} lists no file hashes: the package was not made by pack`]; }
  const problems: string[] = [];
  for (const [path, hash] of Object.entries(listed)) {
    const bytes = files.get(path);
    if (bytes === undefined) { problems.push(`${path} is missing`); } else if (contentHash(bytes) !== hash) { problems.push(`${path} has changed`); }
  }
  for (const path of files.keys()) {
    if (path !== PACKAGE_MANIFEST_FILE && !Object.hasOwn(listed, path)) { problems.push(`${path} is not listed in ${PACKAGE_MANIFEST_FILE}`); }
  }
  return problems;
}

/** The manifest as `system.json` text: two-space JSON with a final newline, so a written file diffs cleanly. */
export function packageManifestText(manifest: SystemPackageManifest): string {
  return `${JSON.stringify(SystemPackageManifest.parse(manifest), null, 2)}\n`;
}
