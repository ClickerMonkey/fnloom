import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceName, LINK_PROTOCOL, MAIN_INSTANCE, PACKAGE_FORMAT, SystemPackageManifest } from '@harness/core';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { serve } from './index.ts';
import {
  builtPackageManifest, checkPackage, findPackageManifest, packageFileProblems, packageManifestText, packageProblems, packedPackageManifest,
  PackageManifestError, parsePackageManifest, readPackageManifest,
} from './package.ts';
import { FakeHub } from './testing.ts';

const source = SystemPackageManifest.parse({
  format: PACKAGE_FORMAT,
  name: 'notes',
  version: '1.4.0',
  description: 'Notes.',
  protocol: LINK_PROTOCOL,
  server: { entry: 'server/main.ts', external: { 'better-sqlite3': '^12.0.0' } },
  client: { entry: 'client/index.ts' },
});

const notes = system('notes', { description: 'Notes.' }).with({ fns: { ping: fn({ description: 'Ping.', args: g.obj({}), returns: g.text() }) } });

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) { await rm(dir, { recursive: true, force: true }); }
  dir = undefined;
});

async function folderWith(text: string | undefined): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'harness-sdk-package-'));
  if (text !== undefined) { await writeFile(join(dir, 'system.json'), text); }
  return dir;
}

describe('reading system.json', () => {
  it('reads and checks one, filling in its defaults', async () => {
    const folder = await folderWith(packageManifestText(source));
    expect(await readPackageManifest(folder)).toEqual(source);
    expect(await findPackageManifest(folder)).toEqual(source);
    expect(parsePackageManifest(JSON.stringify({ ...source, instances: undefined })).instances).toBe('one');
  });

  it('says what is wrong with a bad one, and finds none in a folder without one', async () => {
    expect(() => parsePackageManifest('{', 'x/system.json')).toThrow(/x\/system.json: not JSON/);
    expect(() => parsePackageManifest(JSON.stringify({ ...source, version: 'one' }))).toThrow(/version/);
    expect(() => parsePackageManifest(JSON.stringify({ ...source, server: { entry: '../escape.js' } }))).toThrow(PackageManifestError);
    const empty = await folderWith(undefined);
    expect(await findPackageManifest(empty)).toBeUndefined();
    await expect(readPackageManifest(empty)).rejects.toThrow(/cannot be read/);
  });

  it('says so when system.json is there but cannot be read, rather than taking it as missing', async () => {
    const folder = await folderWith(undefined);
    await mkdir(join(folder, 'system.json'));
    await expect(findPackageManifest(folder)).rejects.toThrow(/system.json: cannot be read/);
  });
});

describe('checking it against the contract', () => {
  it('needs the contract\'s name, this protocol and this format', () => {
    expect(packageProblems(notes, source)).toEqual([]);
    expect(packageProblems(notes, { ...source, name: SystemPackageManifest.shape.name.parse('memo'), protocol: LINK_PROTOCOL + 1 })).toEqual([
      'the contract is named notes but system.json names memo',
      `system.json speaks link protocol ${LINK_PROTOCOL + 1}; this SDK speaks ${LINK_PROTOCOL}`,
    ]);
    expect(() => { checkPackage(notes, { ...source, name: SystemPackageManifest.shape.name.parse('memo') }); }).toThrow(/named notes but system.json names memo/);
  });

  it('lets only a fleet system run as an instance other than main', () => {
    const laptop = InstanceName.parse('laptop');
    expect(packageProblems(notes, source, laptop)).toEqual(['system.json says notes runs one instance (main), but this one is laptop']);
    expect(packageProblems(notes, { ...source, instances: 'many' }, laptop)).toEqual([]);
    expect(packageProblems(notes, source, MAIN_INSTANCE)).toEqual([]);
  });

  it('is checked by serve before anything connects, which then uses its version', async () => {
    const hub = new FakeHub();
    const wrong = await folderWith(packageManifestText({ ...source, name: SystemPackageManifest.shape.name.parse('memo') }));
    await expect(serve(notes, { fns: { ping: { async run(_a, ctx) { return ctx.done('pong'); } } } }, { hub: 'ws://hub.test/link', state: 'unused', package: wrong }, hub.host()))
      .rejects.toThrow(PackageManifestError);
    expect(hub.hellos).toHaveLength(0);
    await rm(wrong, { recursive: true, force: true });
    const right = await folderWith(packageManifestText(source));
    const running = await serve(notes, { fns: { ping: { async run(_a, ctx) { return ctx.done('pong'); } } } }, { hub: 'ws://hub.test/link', state: 'unused', package: right }, hub.host());
    await running.ready();
    expect(hub.manifests.at(-1)?.version).toBe('1.4.0');
    await running.stop();
  });
});

describe('building and packing', () => {
  it('writes the built entries and drops hashes from the built copy', () => {
    const built = builtPackageManifest({ ...source, files: { 'server/main.js': 'a'.repeat(64) } }, { server: 'server/main.js', client: 'client/index.js' });
    expect(built).toEqual({ ...source, server: { ...source.server, entry: 'server/main.js' }, client: { entry: 'client/index.js' } });
    expect(builtPackageManifest(source, { server: 'server/main.js' })).not.toHaveProperty('client');
  });

  it('records each packed file\'s hash, and finds a missing, changed or extra file', () => {
    const files = new Map([['server/main.js', new TextEncoder().encode('run()')], ['client/index.js', new TextEncoder().encode('draw()')], ['system.json', new Uint8Array()]]);
    const packed = packedPackageManifest(source, files);
    expect(Object.keys(packed.files ?? {})).toEqual(['client/index.js', 'server/main.js']);
    expect(packageFileProblems(packed, files)).toEqual([]);
    const tampered = new Map(files);
    tampered.set('server/main.js', new TextEncoder().encode('steal()'));
    tampered.delete('client/index.js');
    tampered.set('server/extra.js', new Uint8Array([1]));
    expect(packageFileProblems(packed, tampered)).toEqual(['client/index.js is missing', 'server/main.js has changed', 'server/extra.js is not listed in system.json']);
    expect(packageFileProblems(source, files)).toEqual(['system.json lists no file hashes: the package was not made by pack']);
  });

  it('refuses a packed path that would leave the package', () => {
    expect(() => packedPackageManifest(source, new Map([['../outside.js', new Uint8Array()]]))).toThrow();
    expect(() => packedPackageManifest(source, new Map([['server/aux.js', new Uint8Array()]]))).toThrow();
  });

  it('writes system.json as two-space JSON with a final newline', () => {
    expect(packageManifestText(source)).toBe(`${JSON.stringify(source, null, 2)}\n`);
  });
});
