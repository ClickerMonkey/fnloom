import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { ActorId, InstanceName, LINK_PROTOCOL, PACKAGE_FORMAT, SystemName, type SystemDataExport, type SystemPackageManifest } from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_FILES, PackageError, pathProblems, readExport, readPackage, readTree, sealExport, sealPackage, sha256, unzip, writeTree, zip, ZipError, type ZipEntry } from './index.ts';

const text = (s: string) => new TextEncoder().encode(s);
const entry = (path: string, body: string): ZipEntry => ({ path, bytes: text(body) });
const MANIFEST: SystemPackageManifest = {
  format: PACKAGE_FORMAT, name: SystemName.parse('notes'), version: '1.2.0', description: 'Notes.', protocol: LINK_PROTOCOL,
  server: { entry: 'server/main.js', external: {} }, client: { entry: 'client' }, instances: 'many',
};
const FILES = [entry('server/main.js', 'console.log(1)'), entry('client/index.js', 'export {}'), entry('client/style.css', 'a{}')];

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-pkg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('zip', () => {
  it('round-trips files, deterministically, and skips folders', () => {
    const files = [entry('a.txt', 'hello'), entry('deep/b.bin', ''), entry('ünïcode/ç.md', '# hi'.repeat(1_000))];
    const bytes = zip(files);
    expect(zip(files)).toEqual(bytes);
    expect(unzip(bytes, 1e6)).toEqual(files);
  });

  it('reads stored entries and folders as other tools write them', () => {
    const stored = storedZip([{ path: 'dir/', bytes: new Uint8Array() }, entry('dir/x.txt', 'plain')]);
    expect(unzip(stored, 1e6)).toEqual([entry('dir/x.txt', 'plain')]);
  });

  it('refuses what it cannot read safely', () => {
    const good = zip([entry('a.txt', 'hello world')]);
    expect(() => unzip(new Uint8Array([1, 2, 3]), 1e6)).toThrow(ZipError);
    expect(() => unzip(good, 5)).toThrow(/more than 5 bytes/);
    const corrupt = new Uint8Array(good);
    corrupt.set([(corrupt[30 + 'a.txt'.length + 1] ?? 0) ^ 0xff], 30 + 'a.txt'.length + 1);
    expect(() => unzip(corrupt, 1e6)).toThrow(ZipError);
    const encrypted = new Uint8Array(good);
    const central = Buffer.from(encrypted.buffer).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    encrypted.set([(encrypted[central + 8] ?? 0) | 1], central + 8);
    expect(() => unzip(encrypted, 1e6)).toThrow(/encrypted/);
    const method = new Uint8Array(good);
    method[central + 10] = 12;
    expect(() => unzip(method, 1e6)).toThrow(/compression method 12/);
  });
});

describe('the package format', () => {
  it('seals a folder with every file’s hash and reads it back', () => {
    const sealed = sealPackage(MANIFEST, FILES);
    expect(sealed[0]?.path).toBe('system.json');
    const read = readPackage(unzip(zip(sealed), 1e6));
    expect(read.manifest.files).toEqual(Object.fromEntries(FILES.map((f) => [f.path, sha256(f.bytes)])));
    expect(read.files.map((f) => f.path)).toEqual(['client/index.js', 'client/style.css', 'server/main.js']);
  });

  it('refuses a tampered file, an extra file, a missing file and a missing entry', () => {
    const sealed = sealPackage(MANIFEST, FILES);
    const tampered = sealed.map((f) => (f.path === 'server/main.js' ? entry(f.path, 'evil()') : f));
    expect(() => readPackage(tampered)).toThrow(/server\/main.js doesn't match its hash/);
    expect(() => readPackage([...sealed, entry('extra.js', '')])).toThrow(/extra.js is not listed/);
    expect(() => readPackage(sealed.filter((f) => f.path !== 'client/style.css'))).toThrow(/client\/style.css is listed but missing/);
    const noServer = sealPackage(MANIFEST, FILES.filter((f) => !f.path.startsWith('server/')));
    expect(() => readPackage(noServer)).toThrow(/entry server\/main.js is missing/);
  });

  it('refuses a path leaving the folder, a bad manifest, another protocol and a zip pack didn’t make', () => {
    const sealed = sealPackage(MANIFEST, FILES);
    expect(() => readPackage([...sealed, entry('../escape.js', '')])).toThrow(/\.\.\/escape.js is not a path inside the package/);
    expect(() => sealPackage(MANIFEST, [entry('C:/abs.js', '')])).toThrow(PackageError);
    expect(() => readPackage(FILES)).toThrow(/no system.json/);
    expect(() => readPackage([entry('system.json', '{"format":1}'), ...FILES])).toThrow(/system.json/);
    expect(() => readPackage(sealed, LINK_PROTOCOL + 1)).toThrow(/link protocol/);
    expect(() => readPackage([entry('system.json', JSON.stringify(MANIFEST)), ...FILES])).toThrow(/lists no file hashes/);
  });

  it('checks paths the way Windows and git need them', () => {
    for (const bad of ['/abs', 'a\\b', 'a//b', './a', 'a/../b', 'C:/x', 'x/aux.js', 'CON', 'lpt1.txt', 'file:stream']) { expect(pathProblems(bad)).toHaveLength(1); }
    for (const good of ['a', 'server/main.js', 'auxiliary.js', 'con-tent/x', '.env']) { expect(pathProblems(good)).toEqual([]); }
  });

  it('writes a tree and reads it back, refusing a path outside', async () => {
    await writeTree(FILES, dir);
    expect(await readFile(join(dir, 'server', 'main.js'), 'utf8')).toBe('console.log(1)');
    expect(await readTree(dir)).toEqual([...FILES].sort((a, b) => a.path.localeCompare(b.path)));
    await expect(writeTree([entry('../out.txt', 'x')], dir)).rejects.toThrow(PackageError);
  });
});

describe('the data export format', () => {
  const info: SystemDataExport = {
    format: PACKAGE_FORMAT, system: SystemName.parse('notes'), instance: InstanceName.parse('laptop'), version: '1.2.0', exportedAt: 5,
    exportedBy: ActorId.parse('act_admin'), withSecrets: true,
  };

  it('round-trips data and config', () => {
    const data = [entry('db.sqlite', 'rows'), entry('notes/a.md', '# a')];
    const read = readExport(unzip(zip(sealExport({ info, config: { token: 's3cret' }, data })), 1e6));
    expect(read).toEqual({ info, config: { token: 's3cret' }, data });
    const bare = readExport(sealExport({ info: { ...info, withSecrets: false }, data }));
    expect(bare.config).toBeUndefined();
  });

  it('carries its config exactly when made with secrets, and refuses what doesn’t belong', () => {
    expect(() => sealExport({ info, data: [] })).toThrow(PackageError);
    expect(() => sealExport({ info: { ...info, withSecrets: false }, config: {}, data: [] })).toThrow(PackageError);
    const sealed = sealExport({ info, config: {}, data: [] });
    expect(() => readExport([...sealed, entry('stray.txt', '')])).toThrow(/stray.txt doesn't belong/);
    expect(() => readExport(sealed.filter((e) => e.path !== EXPORT_FILES.info))).toThrow(/export.json/);
    expect(() => readExport(sealed.map((e) => (e.path === EXPORT_FILES.config ? entry(e.path, '{nope') : e)))).toThrow(/config.json is not JSON/);
  });
});

/** A zip with stored (uncompressed) entries, as some tools write it, built by hand from the format. */
function storedZip(files: readonly ZipEntry[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path);
    const crc = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(10, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.bytes.length, 18); local.writeUInt32LE(file.bytes.length, 22); local.writeUInt16LE(name.length, 26);
    const dirEntry = Buffer.alloc(46);
    dirEntry.writeUInt32LE(0x02014b50, 0); dirEntry.writeUInt32LE(crc, 16); dirEntry.writeUInt32LE(file.bytes.length, 20);
    dirEntry.writeUInt32LE(file.bytes.length, 24); dirEntry.writeUInt16LE(name.length, 28); dirEntry.writeUInt32LE(offset, 42);
    parts.push(local, name, Buffer.from(file.bytes));
    central.push(dirEntry, name);
    offset += 30 + name.length + file.bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

