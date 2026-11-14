import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceName, MAIN_INSTANCE, SystemName, type ContentRef, type InstanceRef, type SystemPackageManifest } from '@harness/core';
import { NETWORK_GUARD, SYSTEM_ENV } from '@harness/sdk/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, manifestFor, vectors } from '../catalog/fixtures.ts';
import { settle } from '../testing.ts';
import { StoredKeyPair } from './keys.ts';
import { readExport, sealPackage, unzip, zip, type ZipEntry } from './package/index.ts';
import { contentBytes, HubPackages, newer, ZIP_MIME } from './packages.ts';
import { NodeInstaller } from './process.ts';
import { FakeLauncher, FakeNetwork, FakeSystem, RIG_SETTINGS, linkRig, systemJson, type LinkRig } from './rig.ts';
import { ProcessSupervisor } from './supervisor.ts';

const NAME = SystemName.parse('vectors');
const text = (s: string) => new TextEncoder().encode(s);

let rig: LinkRig;
let dir: string;
let launcher: FakeLauncher;
let supervisor: ProcessSupervisor;
let packages: HubPackages;

beforeEach(async () => {
  rig = await linkRig();
  dir = mkdtempSync(join(tmpdir(), 'harness-packages-'));
  launcher = new FakeLauncher();
  const installer = new NodeInstaller({ npm: RIG_SETTINGS.packaging.HARNESS_NPM, maxBytes: RIG_SETTINGS.packaging.HARNESS_PACKAGE_MAX, zips: { bytes: (hash) => contentBytes(rig.content, hash) } });
  supervisor = new ProcessSupervisor({
    store: rig.store, log: rig.log, clock: () => rig.time.now, links: rig.links, pairing: rig.pairing, config: rig.config, instances: rig.instances,
    launcher, installer, network: new FakeNetwork(), settings: { systemsDir: dir, hubLink: 'ws://hub:4300/link', stopTimeout: 50, backoff: 5, perHour: 2, maxBackoff: 300_000 },
  });
  packages = new HubPackages({
    content: () => rig.content, supervisor, admin: rig.admin, instances: rig.instances, links: rig.links, config: rig.config, exportTimeout: 200, log: rig.log,
    clock: () => rig.time.now, maxBytes: 1e7,
  });
});
afterEach(async () => {
  await supervisor.stopAll('shutdown');
  await rig.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A packed package zip of the vectors system, in the rig's content store. */
async function packed(version: string, extra: Partial<SystemPackageManifest> = {}, files: ZipEntry[] = [{ path: 'server/main.js', bytes: text(`// ${version}`) }]): Promise<ContentRef> {
  return rig.content.put(zip(sealPackage(systemJson('vectors', version, { server: { entry: 'server/main.js', external: {} }, ...extra }), files)), ZIP_MIME);
}

/** Connect a fake process for an installed instance with the key the hub wrote for it. */
async function connect(ref: InstanceRef): Promise<FakeSystem> {
  const keys = StoredKeyPair.parse(JSON.parse(await readFile(join(supervisor.dirsOf(ref).state, 'key.json'), 'utf8')));
  const system = new FakeSystem(rig.app, ref.system, await manifestFor(vectors), keys);
  system.instance = ref.instance;
  await system.start();
  await settle(5);
  return system;
}

describe('installing a package zip', () => {
  it('checks, places, pairs and starts it with its own folders, and keeps data out of the package', async () => {
    const ref = await packages.installZip({ zip: await packed('1.0.0'), by: ADMIN });
    expect(ref).toEqual({ system: NAME, instance: MAIN_INSTANCE });
    const dirs = supervisor.dirsOf(ref);
    expect(launcher.last.command).toMatchObject({
      args: ['--require', NETWORK_GUARD, join(dir, 'vectors', 'versions', '1.0.0', 'server', 'main.js')],
      env: { [SYSTEM_ENV.data]: dirs.data, [SYSTEM_ENV.cache]: dirs.cache, [SYSTEM_ENV.state]: dirs.state, [SYSTEM_ENV.instance]: 'main' },
    });
    expect(await readFile(join(dir, 'vectors', 'versions', '1.0.0', 'server', 'main.js'), 'utf8')).toBe('// 1.0.0');
    expect(await rig.instances.get(ref)).toMatchObject({ installed: { source: { file: 'vectors-1.0.0.zip' } }, dirs });
    const system = await connect(ref);
    expect((await rig.instances.get(ref))?.status).toBe('connected');
    system.drop();
  });

  it('refuses a tampered zip, a path escape and something that is not a zip', async () => {
    const sealed = sealPackage(systemJson('vectors', '1.0.0', { server: { entry: 'server/main.js', external: {} } }), [{ path: 'server/main.js', bytes: text('ok') }]);
    const tampered = await rig.content.put(zip(sealed.map((f) => (f.path === 'server/main.js' ? { ...f, bytes: text('evil') } : f))), ZIP_MIME);
    await expect(packages.installZip({ zip: tampered, by: ADMIN })).rejects.toMatchObject({ status: 422, code: 'BAD_PACKAGE' });
    const escape = await rig.content.put(zip([...sealed, { path: '../../outside.js', bytes: text('x') }]), ZIP_MIME);
    await expect(packages.installZip({ zip: escape, by: ADMIN })).rejects.toMatchObject({ status: 422, code: 'BAD_PACKAGE' });
    const junk = await rig.content.put(text('not a zip'), ZIP_MIME);
    await expect(packages.installZip({ zip: junk, by: ADMIN })).rejects.toMatchObject({ status: 422, code: 'BAD_ZIP' });
    await expect(packages.installZip({ zip: { hash: '0'.repeat(64), size: 1, mime: ZIP_MIME }, by: ADMIN })).rejects.toMatchObject({ status: 404 });
    expect(launcher.launched).toHaveLength(0);
    expect(await rig.instances.of(NAME)).toEqual([]);
  });

  it('adds instances to a fleet package, refuses a second instance of a one-instance package and the same version twice', async () => {
    const fleet = await packed('1.0.0', { instances: 'many' });
    await packages.installZip({ zip: fleet, instance: InstanceName.parse('laptop'), autoStart: false, by: ADMIN });
    await packages.installZip({ zip: fleet, instance: InstanceName.parse('desk'), autoStart: false, by: ADMIN });
    expect((await supervisor.list()).map((i) => i.instance).sort()).toEqual(['desk', 'laptop']);
    await expect(packages.installZip({ zip: fleet, instance: InstanceName.parse('desk'), by: ADMIN })).rejects.toMatchObject({ status: 409, code: 'ALREADY_INSTALLED' });

    const single = await packed('1.0.0', { name: SystemName.parse('solo') });
    await packages.installZip({ zip: single, autoStart: false, by: ADMIN });
    await expect(packages.installZip({ zip: single, instance: InstanceName.parse('two'), by: ADMIN })).rejects.toMatchObject({ status: 409, code: 'ONE_INSTANCE' });
  });

  it('upgrades every instance when the same instance comes with a newer version, keeping their data', async () => {
    const ref = await packages.installZip({ zip: await packed('1.0.0'), autoStart: false, by: ADMIN });
    await mkdir(supervisor.dirsOf(ref).data, { recursive: true });
    await writeFile(join(supervisor.dirsOf(ref).data, 'kept.txt'), 'mine');
    await packages.installZip({ zip: await packed('1.1.0'), autoStart: false, by: ADMIN });
    expect((await supervisor.list())[0]).toMatchObject({ version: '1.1.0' });
    expect(launcher.launched).toHaveLength(0);
    expect(await readFile(join(supervisor.dirsOf(ref).data, 'kept.txt'), 'utf8')).toBe('mine');
    await expect(packages.installZip({ zip: await packed('1.0.5'), by: ADMIN })).rejects.toMatchObject({ status: 409, code: 'ALREADY_INSTALLED' });
    // an upgrade keeps the instance's own data and config, so neither can come with it
    await expect(packages.installZip({ zip: await packed('1.2.0'), config: { x: 1 }, by: ADMIN })).rejects.toMatchObject({ status: 409, code: 'UPGRADE_KEEPS_DATA' });
    expect((await supervisor.list())[0]).toMatchObject({ version: '1.1.0' });
  });
});

describe('exporting and restoring data', () => {
  it('quiesces the instance, zips its data, and restores it into a new install with its config', async () => {
    const ref = await packages.installZip({ zip: await packed('1.0.0'), by: ADMIN });
    const system = await connect(ref);
    const data = supervisor.dirsOf(ref).data;
    await mkdir(join(data, 'notes'), { recursive: true });
    await writeFile(join(data, 'notes', 'a.md'), '# a');
    system.dataDir = data;

    const plain = await packages.exportData({ ref, withSecrets: false, by: ADMIN });
    expect(system.exports).toBe(1);
    const read = readExport(unzip(rig.content.bytes(plain), 1e6));
    expect(read.info).toMatchObject({ system: 'vectors', instance: 'main', version: '1.0.0', withSecrets: false, exportedBy: ADMIN });
    expect(read.config).toBeUndefined();
    expect(read.data.map((f) => f.path)).toEqual(['notes/a.md']);

    const secret = await packages.exportData({ ref, withSecrets: true, by: ADMIN });
    expect(readExport(unzip(rig.content.bytes(secret), 1e6))).toMatchObject({ info: { withSecrets: true }, config: {} });
    system.drop();
    await settle(5);

    // restore into a new install elsewhere: the data lands before it starts
    const restored = await packages.installZip({ zip: await packed('1.0.0', { name: SystemName.parse('vectors'), instances: 'many' }), instance: InstanceName.parse('copy'), data: secret, by: ADMIN });
    expect(await readFile(join(supervisor.dirsOf(restored).data, 'notes', 'a.md'), 'utf8')).toBe('# a');
    expect(launcher.last.command.env[SYSTEM_ENV.instance]).toBe('copy');
  });

  it('refuses to copy an instance that says its data is not ready', async () => {
    const ref = await packages.installZip({ zip: await packed('1.0.0'), by: ADMIN });
    const system = await connect(ref);
    system.exportRefused = 'vectors could not get its data ready: disk busy';
    await expect(packages.exportData({ ref, withSecrets: false, by: ADMIN })).rejects.toMatchObject({ status: 409, code: 'EXPORT_NOT_READY', message: 'vectors could not get its data ready: disk busy' });
    expect(system.exports).toBe(1);
  });

  it('copies an instance that is away as it lies, and refuses one the hub doesn’t run', async () => {
    const ref = await packages.installZip({ zip: await packed('1.0.0'), autoStart: false, by: ADMIN });
    const plain = await packages.exportData({ ref, withSecrets: true, by: ADMIN });
    // no config was ever set, so even with secrets there is none to carry
    expect(readExport(unzip(rig.content.bytes(plain), 1e6))).toMatchObject({ info: { withSecrets: false }, data: [] });
    const remote = new FakeSystem(rig.app, 'shopfront', await manifestFor(vectors));
    await rig.pairing.pairInstalled({ system: remote.name, instance: MAIN_INSTANCE }, remote.keys.publicKey, '1.0.0', ADMIN);
    await expect(packages.exportData({ ref: { system: remote.name, instance: MAIN_INSTANCE }, withSecrets: false, by: ADMIN })).rejects.toMatchObject({ status: 409 });
    await expect(packages.exportData({ ref: { system: NAME, instance: InstanceName.parse('ghost') }, withSecrets: false, by: ADMIN })).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an export of another system', async () => {
    const other = await rig.content.put(zip([{ path: 'export.json', bytes: text(JSON.stringify({ format: 1, system: 'notes', instance: 'main', version: '1.0.0', exportedAt: 1, exportedBy: ADMIN, withSecrets: false })) }]), ZIP_MIME);
    await expect(packages.installZip({ zip: await packed('1.0.0'), data: other, by: ADMIN })).rejects.toMatchObject({ status: 422, code: 'WRONG_EXPORT' });
  });

  it('uninstalls an installed instance it removes', async () => {
    const ref = await packages.installZip({ zip: await packed('1.0.0'), autoStart: false, by: ADMIN });
    await packages.removeInstance(ref, ADMIN);
    expect(await supervisor.list()).toEqual([]);
    expect((await rig.instances.get(ref))?.status).toBe('removed');
  });
});

describe('versions', () => {
  it('orders semantic versions', () => {
    expect(newer('1.10.0', '1.9.9')).toBe(true);
    expect(newer('1.0.0', '1.0.0')).toBe(false);
    expect(newer('2.0.0', '2.0.0-beta.2')).toBe(true);
    expect(newer('2.0.0-beta.10', '2.0.0-beta.2')).toBe(true);
    expect(newer('2.0.0-beta.1', '2.0.0')).toBe(false);
    expect(newer('1.0.0+build.5', '1.0.0')).toBe(false);
  });
});
