/**
 * Installing Ollama into an instance's data folder with a fake release, download and unpack (nothing touches the
 * network or runs): the right file for each OS and architecture, the sha-256 from the asset or the release's checksum
 * list, a mismatch refused with nothing left behind, where the program lands and what `install.json` records.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDownloader, FakeExtractor, FakeReleases, sha256 } from './fakes.ts';
import { assetCandidates, checksumOf, Installer, readInstall, type Machine } from './install.ts';

const LINUX: Machine = { platform: 'linux', arch: 'x64' };
const ARCHIVE = 'release bytes';

describe('installing Ollama', () => {
  let root: string;
  let dataDir: string;
  let cacheDir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ollama-install-'));
    dataDir = join(root, 'data');
    cacheDir = join(root, 'cache');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  /** An installer over fakes, with one release whose asset carries its digest (or not, `digest: false`). */
  function installer(machine: Machine = LINUX, options: { digest?: boolean; list?: string; version?: string } = {}) {
    const version = options.version ?? '0.12.3';
    const name = assetCandidates(machine).at(-1) ?? '';
    const releases = new FakeReleases().add({
      version,
      assets: [
        { name, url: `https://dl/${name}`, size: ARCHIVE.length, ...(options.digest === false ? {} : { sha256: sha256(ARCHIVE) }) },
        ...(options.list === undefined ? [] : [{ name: 'sha256sum.txt', url: 'https://dl/sha256sum.txt' }]),
      ],
    });
    const downloader = new FakeDownloader();
    downloader.files.set(`https://dl/${name}`, ARCHIVE);
    if (options.list !== undefined) { downloader.files.set('https://dl/sha256sum.txt', options.list); }
    const extractor = new FakeExtractor();
    const progress: number[] = [];
    const install = new Installer({ releases, downloader, extractor, machine, clock: () => 42 });
    const request = (more: Partial<Parameters<Installer['install']>[0]> = {}) => install.install({
      version: 'latest', force: false, dataDir, cacheDir, prune: true, progress: (f) => { progress.push(f); }, ...more,
    });
    return { install, request, releases, downloader, extractor, progress, name };
  }

  it('picks the release file for each OS and architecture', () => {
    expect(assetCandidates({ platform: 'win32', arch: 'x64' })).toEqual(['ollama-windows-amd64.zip']);
    expect(assetCandidates({ platform: 'win32', arch: 'arm64' })).toEqual(['ollama-windows-arm64.zip']);
    expect(assetCandidates({ platform: 'darwin', arch: 'arm64' })).toEqual(['ollama-darwin.tgz', 'ollama-darwin.zip']);
    expect(assetCandidates(LINUX)).toEqual(['ollama-linux-amd64.tar.zst', 'ollama-linux-amd64.tgz']);
    expect(() => assetCandidates({ platform: 'linux', arch: 'ia32' })).toThrow(/no release for linux on ia32/);
    expect(() => assetCandidates({ platform: 'freebsd', arch: 'x64' })).toThrow(/no release/);
  });

  it('downloads, checks the sha-256, unpacks into the data folder and records it', async () => {
    const { request, extractor, progress, name } = installer();
    const outcome = await request();
    expect(outcome).toMatchObject({ checked: 'sha256', already: false });
    expect(outcome.install).toEqual({ version: '0.12.3', binary: join(dataDir, 'ollama', '0.12.3', 'bin', 'ollama'), asset: name, sha256: sha256(ARCHIVE), installedAt: 42 });
    expect(await readInstall(dataDir)).toEqual(outcome.install);
    // unpacked into a new, empty staging folder inside the data folder, then moved; the download is gone
    expect(extractor.extracted[0]?.into).toMatch(/[\\/]ollama[\\/]\.staging-/);
    expect(await readdir(join(dataDir, 'ollama'))).toEqual(['0.12.3', 'install.json']);
    expect(await readdir(join(cacheDir, 'downloads'))).toEqual([]);
    expect(progress.at(0)).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('does nothing for a version already installed, unless forced', async () => {
    const { request, downloader } = installer();
    await request();
    expect((await request()).already).toBe(true);
    expect(downloader.downloaded).toHaveLength(1);
    expect((await request({ force: true })).already).toBe(false);
    expect(downloader.downloaded).toHaveLength(2);
  });

  it('takes the sha-256 from the release\'s checksum list when the file carries none', async () => {
    const { request } = installer(LINUX, { digest: false, list: `${'0'.repeat(64)}  ./other.tgz\n${sha256(ARCHIVE)}  ./ollama-linux-amd64.tgz\n` });
    expect((await request()).checked).toBe('sha256');
  });

  it('refuses a download that doesn\'t match, leaving nothing installed', async () => {
    const { request } = installer(LINUX, { digest: false, list: `${'a'.repeat(64)}  ./ollama-linux-amd64.tgz\n` });
    await expect(request()).rejects.toThrow(/doesn't match the release's sha-256/);
    expect(await readInstall(dataDir)).toBeUndefined();
    expect(await readdir(join(dataDir, 'ollama')).catch(() => [])).toEqual([]);
    expect(await readdir(join(cacheDir, 'downloads'))).toEqual([]);
  });

  it('refuses a checksum list that doesn\'t name the file, and installs unchecked only when the release has no checksum at all', async () => {
    await expect(installer(LINUX, { digest: false, list: `${'a'.repeat(64)}  ./else.tgz\n` }).request()).rejects.toThrow(/doesn't list/);
    expect((await installer(LINUX, { digest: false }).request()).checked).toBe('none');
  });

  it('refuses an archive without the program, and a release without this machine\'s file', async () => {
    const { request, extractor } = installer();
    extractor.holds = ['README.md'];
    await expect(request()).rejects.toThrow(/has no ollama/);
    expect(await readInstall(dataDir)).toBeUndefined();
    const releases = new FakeReleases().add({ version: '0.1.0', assets: [{ name: 'ollama-darwin.tgz', url: 'https://dl/x' }] });
    const other = new Installer({ releases, downloader: new FakeDownloader(), extractor: new FakeExtractor(), machine: LINUX, clock: () => 0 });
    await expect(other.install({ version: 'latest', force: false, dataDir, cacheDir, prune: true, progress: () => undefined })).rejects.toThrow(/has no ollama-linux-amd64.tar.zst or ollama-linux-amd64.tgz/);
  });

  it('finds the Windows program at the archive\'s root, and keeps an older version while the server runs it', async () => {
    const windows = installer({ platform: 'win32', arch: 'x64' }, { version: '0.12.2' });
    windows.extractor.holds = ['ollama.exe', 'lib/ollama/ggml.dll'];
    expect((await windows.request()).install.binary).toBe(join(dataDir, 'ollama', '0.12.2', 'ollama.exe'));
    const newer = installer({ platform: 'win32', arch: 'x64' }, { version: '0.12.3' });
    newer.extractor.holds = ['ollama.exe'];
    await newer.request({ prune: false });
    expect((await readdir(join(dataDir, 'ollama'))).sort()).toEqual(['0.12.2', '0.12.3', 'install.json']);
    expect(JSON.parse(await readFile(join(dataDir, 'ollama', 'install.json'), 'utf8'))).toMatchObject({ version: '0.12.3' });
  });

  it('plans an install without downloading, for the approval card', async () => {
    const { install, downloader, name } = installer(LINUX, { digest: false, list: 'x' });
    const plan = await install.plan('latest', dataDir);
    expect(plan).toMatchObject({ version: '0.12.3', asset: { name }, checksum: 'list', into: join(dataDir, 'ollama', '0.12.3'), installed: false });
    expect(downloader.downloaded).toEqual([]);
  });

  it('reads a sha256sum list', () => {
    const hex = 'b'.repeat(64);
    expect(checksumOf(`${hex}  ./ollama-darwin.tgz`, 'ollama-darwin.tgz')).toBe(hex);
    expect(checksumOf(`${hex.toUpperCase()} *ollama-darwin.tgz\r\n`, 'ollama-darwin.tgz')).toBe(hex);
    expect(checksumOf('not a line', 'ollama-darwin.tgz')).toBeUndefined();
  });
});
