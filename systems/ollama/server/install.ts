/**
 * Installing Ollama into an instance's data folder, never system-wide and never as admin: the official release for
 * this machine's OS and architecture is found on GitHub (`ReleaseSource`), downloaded with progress (`Downloader`),
 * checked against the sha-256 the release publishes (the asset's own digest, else its `sha256sum.txt`), unpacked into a
 * new, empty staging folder (`Extractor`, the OS's own `tar`, which reads zip, tgz and tar.zst) and moved to
 * `<data>/ollama/<version>/`; `<data>/ollama/install.json` records it. Each outside part is an interface, so tests use a
 * fake release, download and unpack; the real ones are at the bottom.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { InstalledOllama } from '../shared/index.ts';

/** One file of a release. `sha256` when the release says it. */
export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size?: number | undefined;
  readonly sha256?: string | undefined;
}

/** A release: its version and files. */
export interface Release {
  readonly version: string;
  readonly assets: readonly ReleaseAsset[];
}

/** Where releases come from. */
export interface ReleaseSource {
  /** A release by version (`0.12.3`), or the newest (`latest`). */
  release(version: string, signal?: AbortSignal): Promise<Release>;
}

/** Downloads files. */
export interface Downloader {
  /** Save `url` at `to`, calling `progress` as bytes arrive; gives the bytes' sha-256 (hex) and count. */
  download(url: string, to: string, progress: (received: number, total: number | undefined) => void, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }>;
  /** A small text file (a checksum list). */
  text(url: string, signal?: AbortSignal): Promise<string>;
}

/** Unpacks an archive into an empty folder. */
export interface Extractor {
  extract(archive: string, into: string, signal?: AbortSignal): Promise<void>;
}

/** The machine to install for. */
export interface Machine {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

/** The release files that run on a machine, in the order they are preferred. Throws for one Ollama doesn't ship for. */
export function assetCandidates(machine: Machine): string[] {
  const arch = machine.arch === 'x64' ? 'amd64' : machine.arch === 'arm64' ? 'arm64' : undefined;
  if (machine.platform === 'darwin') { return ['ollama-darwin.tgz', 'ollama-darwin.zip']; }
  if (arch !== undefined && machine.platform === 'win32') { return [`ollama-windows-${arch}.zip`]; }
  if (arch !== undefined && machine.platform === 'linux') { return [`ollama-linux-${arch}.tar.zst`, `ollama-linux-${arch}.tgz`]; }
  throw new Error(`Ollama publishes no release for ${machine.platform} on ${machine.arch}.`);
}

/** The program's name on a machine. */
export function binaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'ollama.exe' : 'ollama';
}

/** The sha-256 a checksum list (`sha256sum` output: `<hex>  ./<name>`) gives a file, if it lists it. */
export function checksumOf(list: string, file: string): string | undefined {
  for (const line of list.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(?:\.\/)?(.+)$/i.exec(line.trim());
    if (match?.[2]?.trim() === file && match[1] !== undefined) { return match[1].toLowerCase(); }
  }
  return undefined;
}

/** Where the program is in an unpacked release: `bin/ollama` (Linux), `ollama` (macOS) or `ollama.exe` (Windows). */
export async function findBinary(dir: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const name = binaryName(platform);
  for (const candidate of [join(dir, 'bin', name), join(dir, name), join(dir, 'Ollama.app', 'Contents', 'Resources', name)]) {
    if (await isFile(candidate)) { return candidate; }
  }
  return undefined;
}

/** Whether a path is a file. */
export async function isFile(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isFile(), () => false);
}

/** The folder installs live in, inside an instance's data folder. */
export function installRoot(dataDir: string): string {
  return join(dataDir, 'ollama');
}

/** The install an instance has, read from `install.json`, if its program is still there. */
export async function readInstall(dataDir: string): Promise<InstalledOllama | undefined> {
  const text = await readFile(join(installRoot(dataDir), 'install.json'), 'utf8').catch(() => undefined);
  if (text === undefined) { return undefined; }
  const parsed = InstalledOllama.safeParse(JSON.parse(text));
  return parsed.success && await isFile(parsed.data.binary) ? parsed.data : undefined;
}

/** What one install is asked to do. */
export interface InstallRequest {
  readonly version: string;
  readonly force: boolean;
  readonly dataDir: string;
  readonly cacheDir: string;
  /** 0 to 1, and what it is doing. */
  readonly progress: (fraction: number, message: string) => void;
  /** Whether an older version's folder may be removed now (the server isn't running it). */
  readonly prune: boolean;
  readonly signal?: AbortSignal;
}

/** What an install did. */
export interface InstallOutcome {
  readonly install: InstalledOllama;
  readonly checked: 'sha256' | 'none';
  readonly already: boolean;
}

/** What a release would install, worked out without downloading it (an approval's preview). */
export interface InstallPlan {
  readonly version: string;
  readonly asset: ReleaseAsset;
  /** Where the release's sha-256 comes from, or none. */
  readonly checksum: 'asset' | 'list' | 'none';
  readonly into: string;
  /** This version is installed already. */
  readonly installed: boolean;
}

/** What the installer is built from. */
export interface InstallerParts {
  readonly releases: ReleaseSource;
  readonly downloader: Downloader;
  readonly extractor: Extractor;
  readonly machine: Machine;
  readonly clock: () => number;
}

/** Installs Ollama releases into an instance's data folder. */
export class Installer {
  readonly #parts: InstallerParts;

  constructor(parts: InstallerParts) {
    this.#parts = parts;
  }

  /** What installing `version` would do. */
  async plan(version: string, dataDir: string, signal?: AbortSignal): Promise<InstallPlan> {
    const release = await this.#parts.releases.release(version, signal);
    const asset = this.#asset(release);
    const current = await readInstall(dataDir);
    const checksum = asset.sha256 !== undefined ? 'asset' : release.assets.some((a) => a.name === 'sha256sum.txt') ? 'list' : 'none';
    return { version: release.version, asset, checksum, into: join(installRoot(dataDir), release.version), installed: current?.version === release.version };
  }

  /** Install a release: download, check, unpack and record it. */
  async install(request: InstallRequest): Promise<InstallOutcome> {
    const { downloader, extractor, machine, clock } = this.#parts;
    const { dataDir, cacheDir, progress, signal } = request;
    progress(0, 'Finding the release');
    const release = await this.#parts.releases.release(request.version, signal);
    const asset = this.#asset(release);
    const current = await readInstall(dataDir);
    if (!request.force && current?.version === release.version) { return { install: current, checked: current.sha256 === undefined ? 'none' : 'sha256', already: true }; }

    const expected = asset.sha256 ?? await this.#listed(release, asset, signal);
    const downloads = join(cacheDir, 'downloads');
    await mkdir(downloads, { recursive: true });
    const archive = join(downloads, `${randomUUID()}-${asset.name}`);
    const root = installRoot(dataDir);
    const staging = join(root, `.staging-${randomUUID()}`);
    try {
      const got = await downloader.download(asset.url, archive, (received, total) => {
        const size = total ?? asset.size;
        progress(size === undefined || size === 0 ? 0.05 : 0.05 + 0.85 * Math.min(1, received / size), `Downloading ${asset.name}`);
      }, signal);
      if (expected !== undefined && got.sha256.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`The download of ${asset.name} doesn't match the release's sha-256 (expected ${expected}, got ${got.sha256}); nothing was installed.`);
      }
      progress(0.92, `Unpacking ${asset.name}`);
      // a new, empty folder for what the archive holds
      await mkdir(staging, { recursive: true });
      await extractor.extract(archive, staging, signal);
      const found = await findBinary(staging, machine.platform);
      if (found === undefined) { throw new Error(`${asset.name} has no ${binaryName(machine.platform)} where releases keep it; nothing was installed.`); }
      if (machine.platform !== 'win32') { await chmod(found, 0o755); }
      const final = join(root, release.version);
      await rm(final, { recursive: true, force: true });
      await rename(staging, final);
      const install: InstalledOllama = {
        version: release.version, binary: join(final, found.slice(staging.length + 1)), asset: asset.name,
        ...(expected === undefined ? {} : { sha256: expected.toLowerCase() }), installedAt: clock(),
      };
      await writeFile(join(root, 'install.json'), `${JSON.stringify(install, null, 2)}\n`);
      if (request.prune) { await pruneVersions(root, release.version); }
      progress(1, `Installed Ollama ${release.version}`);
      return { install, checked: expected === undefined ? 'none' : 'sha256', already: false };
    } finally {
      await rm(archive, { force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** The release's file for this machine. */
  #asset(release: Release): ReleaseAsset {
    const wanted = assetCandidates(this.#parts.machine);
    const asset = wanted.map((name) => release.assets.find((a) => a.name === name)).find((a) => a !== undefined);
    if (asset === undefined) { throw new Error(`Ollama ${release.version} has no ${wanted.join(' or ')}.`); }
    return asset;
  }

  /** The sha-256 the release's checksum list gives a file, when it has one. */
  async #listed(release: Release, asset: ReleaseAsset, signal: AbortSignal | undefined): Promise<string | undefined> {
    const list = release.assets.find((a) => a.name === 'sha256sum.txt');
    if (list === undefined) { return undefined; }
    const found = checksumOf(await this.#parts.downloader.text(list.url, signal), asset.name);
    if (found === undefined) { throw new Error(`The release's sha256sum.txt doesn't list ${asset.name}; nothing was installed.`); }
    return found;
  }
}

/** Remove every version folder but `keep` (and any staging left behind). */
async function pruneVersions(root: string, keep: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries.filter((e) => e.isDirectory() && e.name !== keep).map((e) => rm(join(root, e.name), { recursive: true, force: true })));
}

// ─── The real parts ───────────────────────────────────────────────────────────────

/** A GitHub release as the releases API gives it (the parts read). */
const GitHubRelease = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string(), size: z.number().optional(), digest: z.string().nullable().optional() })),
});

/** Releases from GitHub's API (`<base>/latest`, `<base>/tags/v<version>`). */
export class GitHubReleases implements ReleaseSource {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(base: string, fetcher: typeof fetch) {
    this.#base = base.replace(/\/+$/, '');
    this.#fetch = fetcher;
  }

  async release(version: string, signal?: AbortSignal): Promise<Release> {
    const url = version === 'latest' ? `${this.#base}/latest` : `${this.#base}/tags/v${version}`;
    const response = await this.#fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'harness-ollama-system' }, ...(signal === undefined ? {} : { signal }) });
    if (response.status === 404) { throw new Error(`Ollama has no release ${version}.`); }
    if (!response.ok) { throw new Error(`GitHub's release list answered ${response.status}.`); }
    const release = GitHubRelease.parse(await response.json());
    return {
      version: release.tag_name.replace(/^v/, ''),
      assets: release.assets.map((asset) => {
        const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '')?.[1];
        return { name: asset.name, url: asset.browser_download_url, ...(asset.size === undefined ? {} : { size: asset.size }), ...(digest === undefined ? {} : { sha256: digest.toLowerCase() }) };
      }),
    };
  }
}

/** Downloads over `fetch`, following redirects, hashing as it writes, and giving up when nothing arrives for `idle` ms. */
export class FetchDownloader implements Downloader {
  readonly #fetch: typeof fetch;
  readonly #idle: number;

  constructor(fetcher: typeof fetch, idle: number) {
    this.#fetch = fetcher;
    this.#idle = idle;
  }

  async download(url: string, to: string, progress: (received: number, total: number | undefined) => void, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
    const quiet = new AbortController();
    let timer = setTimeout(() => { quiet.abort(new Error('the download stalled')); }, this.#idle);
    const both = signal === undefined ? quiet.signal : AbortSignal.any([signal, quiet.signal]);
    try {
      const response = await this.#fetch(url, { redirect: 'follow', signal: both, headers: { 'user-agent': 'harness-ollama-system' } });
      if (!response.ok || response.body === null) { throw new Error(`The download answered ${response.status}.`); }
      const length = Number(response.headers.get('content-length'));
      const total = Number.isFinite(length) && length > 0 ? length : undefined;
      const hash = createHash('sha256');
      let bytes = 0;
      const out = createWriteStream(to);
      const closed = new Promise<void>((done, failed) => { out.on('close', done); out.on('error', failed); });
      try {
        const reader = response.body.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) { break; }
          hash.update(next.value);
          bytes += next.value.length;
          clearTimeout(timer);
          timer = setTimeout(() => { quiet.abort(new Error('the download stalled')); }, this.#idle);
          progress(bytes, total);
          // wait for the file to take it before reading on
          if (!out.write(next.value)) { await once(out, 'drain', { signal: both }); }
        }
      } finally {
        out.end();
        await closed;
      }
      return { sha256: hash.digest('hex'), bytes };
    } finally {
      clearTimeout(timer);
    }
  }

  async text(url: string, signal?: AbortSignal): Promise<string> {
    const response = await this.#fetch(url, { redirect: 'follow', headers: { 'user-agent': 'harness-ollama-system' }, ...(signal === undefined ? {} : { signal }) });
    if (!response.ok) { throw new Error(`${url} answered ${response.status}.`); }
    return response.text();
  }
}

/**
 * Unpacks with the OS's own `tar` (bsdtar on Windows 10+ and macOS reads zip too; GNU tar reads tgz and, with zstd
 * installed, tar.zst), run directly with no shell and a bare environment. On Windows it is always System32's, never
 * another `tar` on the PATH.
 */
export class TarExtractor implements Extractor {
  readonly #platform: NodeJS.Platform;
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>) {
    this.#platform = platform;
    this.#env = env;
  }

  extract(archive: string, into: string, signal?: AbortSignal): Promise<void> {
    const root = this.#env['SystemRoot'] ?? 'C:\\Windows';
    const tar = this.#platform === 'win32' ? join(root, 'System32', 'tar.exe') : 'tar';
    const env = { PATH: this.#env['PATH'] ?? '/usr/bin:/bin', ...(this.#platform === 'win32' ? { SystemRoot: root } : {}) };
    return new Promise((done, failed) => {
      execFile(tar, ['-xf', archive, '-C', into], { env, windowsHide: true, maxBuffer: 1024 * 1024, ...(signal === undefined ? {} : { signal }) }, (error, _out, err) => {
        if (error === null) { done(); return; }
        failed(new Error(`Unpacking ${archive} failed: ${err.trim() || error.message}`));
      });
    });
  }
}
