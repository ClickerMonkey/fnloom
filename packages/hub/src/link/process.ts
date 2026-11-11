/**
 * How the supervisor gets installed instances (their processes are started by the SDK's shared `ProcessStarter`):
 * `Installer` fetches a system from a folder, an npm package, a git repository or an uploaded package zip, and reads what it is from its `system.json`
 * (`SystemPackageManifest`, the one source of a system's name, version and entries).
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { LINK_PROTOCOL, PACKAGE_MANIFEST_FILE, type InstallSource, type InstalledSystem, type SystemPackageManifest } from '@harness/core';
import { PackageError, checkManifest } from './package/format.ts';
import { readPackage, unzip, writeTree } from './package/index.ts';

/** How to run a system's process. */
export type SystemCommand = InstalledSystem['command'];

/** What an installed folder holds: its manifest, its server entry file (absolute) and the folder. */
export interface SystemPackage {
  readonly manifest: SystemPackageManifest;
  /** The server entry, absolute. */
  readonly entry: string;
  /** The folder the package is in. */
  readonly dir: string;
}

/** Fetches systems and reads what they are. */
export interface Installer {
  /** Put the system a source names into `dir` (for a folder source, nothing is copied) and describe it. */
  fetch(source: InstallSource, dir: string): Promise<SystemPackage>;
  /** Describe the system in a folder (its `system.json`). */
  describe(dir: string): Promise<SystemPackage>;
}

/** Where package zips come from: the hub's content store, by hash. */
export interface ZipSource {
  /** The bytes stored under a hash; refused when there are none. */
  bytes(hash: string): Promise<Uint8Array>;
}

const run = promisify(execFile);

/** Read and check a folder's `system.json`: it parses and speaks this hub's link protocol. */
export async function readManifest(dir: string, protocol: number = LINK_PROTOCOL): Promise<SystemPackageManifest> {
  const { manifest, problems } = checkManifest(new Uint8Array(await readFile(join(dir, PACKAGE_MANIFEST_FILE))), protocol);
  if (manifest === undefined || problems.length > 0) { throw new PackageError(problems); }
  return manifest;
}

/** Fetches systems with npm and git, unpacks package zips, and reads their `system.json`. */
export class NodeInstaller implements Installer {
  readonly #npm: string;
  readonly #git: string;
  readonly #zips: ZipSource | undefined;
  readonly #maxBytes: number;

  /** `npm` and `maxBytes` are the packaging settings (`HARNESS_NPM`, `HARNESS_PACKAGE_MAX`). */
  constructor(options: { npm: string; maxBytes: number; git?: string; zips?: ZipSource }) {
    this.#npm = options.npm;
    this.#git = options.git ?? 'git';
    this.#zips = options.zips;
    this.#maxBytes = options.maxBytes;
  }

  async fetch(source: InstallSource, dir: string): Promise<SystemPackage> {
    if ('path' in source) { return this.describe(resolve(source.path)); }
    if ('package' in source) {
      await run(this.#npm, ['install', '--prefix', dir, '--omit=dev', '--no-save', `${source.package}@${source.version}`], { shell: process.platform === 'win32' });
      return this.describe(join(dir, 'node_modules', ...source.package.split('/')));
    }
    if ('zip' in source) { return this.#unpack(source.zip, dir); }
    await run(this.#git, ['clone', '--depth', '1', '--branch', source.ref, source.git, dir]);
    await run(this.#npm, ['install', '--omit=dev'], { cwd: dir, shell: process.platform === 'win32' });
    return this.describe(dir);
  }

  async describe(dir: string): Promise<SystemPackage> {
    const manifest = await readManifest(dir);
    return { manifest, entry: resolve(dir, manifest.server.entry), dir };
  }

  /** Unpack a checked package zip into `dir` and install the npm packages its bundle left out. */
  async #unpack(hash: string, dir: string): Promise<SystemPackage> {
    if (this.#zips === undefined) { throw new PackageError(['this hub was not given a place to read package zips from']); }
    const entries = unzip(await this.#zips.bytes(hash), this.#maxBytes);
    const checked = readPackage(entries);
    await writeTree(entries, dir);
    const externals = Object.entries(checked.manifest.server.external).map(([name, range]) => `${name}@${range}`);
    if (externals.length > 0) {
      await run(this.#npm, ['install', '--prefix', dir, '--omit=dev', '--no-save', '--no-package-lock', ...externals], { shell: process.platform === 'win32' });
    }
    return this.describe(dir);
  }
}
