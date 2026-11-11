import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { ApiError } from '@ayepi/core';
import { InstanceName, LINK_PROTOCOL, MAIN_INSTANCE, SystemName, type InstallSource, type Manifest, type SystemPackageManifest } from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, manifestFor, shop, vectors } from '../catalog/fixtures.ts';
import { settle } from '../testing.ts';
import { StoredKeyPair } from './keys.ts';
import { NodeInstaller, readManifest, type Installer, type SystemPackage } from './process.ts';
import { FakeLauncher, FakeSystem, RIG_SETTINGS, linkRig, systemJson, type LinkRig } from './rig.ts';
import { RESTART_CODE, SYSTEM_ENV } from '@harness/sdk/server';
import { ProcessSupervisor } from './supervisor.ts';

/** Writes a system.json for the source's version instead of running npm or git. */
class FakeInstaller implements Installer {
  readonly name: string;
  instances: SystemPackageManifest['instances'] = 'one';

  constructor(name: string) {
    this.name = name;
  }
  async fetch(source: InstallSource, dir: string): Promise<SystemPackage> {
    if ('path' in source) { return this.describe(source.path); }
    const version = 'package' in source ? (source.version === 'latest' ? '9.0.0' : source.version) : 'git' in source ? source.ref : '1.0.0';
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'system.json'), JSON.stringify(systemJson(this.name, version, { instances: this.instances })));
    return this.describe(dir);
  }
  describe(dir: string): Promise<SystemPackage> {
    return new NodeInstaller({ npm: RIG_SETTINGS.packaging.HARNESS_NPM, maxBytes: RIG_SETTINGS.packaging.HARNESS_PACKAGE_MAX }).describe(dir);
  }
}

let rig: LinkRig;
let dir: string;
let launcher: FakeLauncher;
const SHOP = SystemName.parse('shop');

function supervisor(name = 'shop', perHour = 2, installer = new FakeInstaller(name), systemsDir = dir) {
  return new ProcessSupervisor({
    store: rig.store, log: rig.log, clock: () => rig.time.now, links: rig.links, pairing: rig.pairing, config: rig.config, instances: rig.instances,
    launcher, installer,
    settings: { systemsDir, hubLink: 'ws://hub:4300/link', stopTimeout: 50, backoff: 5, perHour, maxBackoff: 300_000 },
  });
}

beforeEach(async () => {
  rig = await linkRig();
  dir = mkdtempSync(join(tmpdir(), 'harness-sup-'));
  launcher = new FakeLauncher();
});
afterEach(async () => {
  await rig.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Connect a fake system with the key the supervisor wrote, as the real process would. */
async function connectInstalled(manifest: Manifest, name = 'shop', instance = 'main'): Promise<FakeSystem> {
  const keys = StoredKeyPair.parse(JSON.parse(await readFile(join(dir, name, 'instances', instance, 'state', 'key.json'), 'utf8')));
  const system = new FakeSystem(rig.app, name, manifest, keys);
  system.instance = InstanceName.parse(instance);
  await system.start();
  await settle(5);
  return system;
}

describe('installing', () => {
  it('installs a package into its version folder, pairs it with a key it made, and starts it', async () => {
    const sup = supervisor();
    const installed = await sup.install({ source: { package: '@x/shop', version: '1.0.0' }, config: { currency: 'EUR' }, by: ADMIN });
    expect(installed).toMatchObject({ name: 'shop', instance: 'main', version: '1.0.0', status: 'starting', autoStart: true, pid: 100, dir: join(dir, 'shop') });
    expect(launcher.last.command).toMatchObject({
      run: process.execPath,
      args: [join(dir, 'shop', 'versions', '1.0.0', 'server', 'main.ts')],
      env: {
        [SYSTEM_ENV.hub]: 'ws://hub:4300/link', [SYSTEM_ENV.name]: 'shop', [SYSTEM_ENV.instance]: 'main',
        [SYSTEM_ENV.state]: join(dir, 'shop', 'instances', 'main', 'state'), [SYSTEM_ENV.data]: join(dir, 'shop', 'instances', 'main', 'data'),
        [SYSTEM_ENV.cache]: join(dir, 'shop', 'instances', 'main', 'cache'),
        [SYSTEM_ENV.supervised]: 'true', [SYSTEM_ENV.restartCode]: String(RESTART_CODE),
      },
    });
    expect((await rig.store.table('instances').get({ system: SHOP, instance: MAIN_INSTANCE }))?.pairedBy).toBe(ADMIN);

    // the process connects with the key the hub made; its config was waiting for its contract
    const system = await connectInstalled(await manifestFor(shop));
    expect((await rig.store.table('systems').get(SHOP))?.status).toBe('connected');
    expect(await rig.store.table('instances').get({ system: SHOP, instance: MAIN_INSTANCE })).toMatchObject({ status: 'connected', config: { value: { currency: 'EUR' } } });
    expect(system.configured).toEqual([{ value: { currency: 'EUR' }, version: 1 }]);
    expect((await sup.list())[0]).toMatchObject({ status: 'running', goodVersion: '1.0.0' });
  });

  it('refuses a second install of the same system and a source it can’t fetch', async () => {
    const sup = supervisor();
    await sup.install({ source: { package: '@x/shop', version: '1.0.0' }, autoStart: false, by: ADMIN });
    await expect(sup.install({ source: { package: '@x/shop', version: '1.0.0' }, by: ADMIN })).rejects.toMatchObject({ status: 409, code: 'ALREADY_INSTALLED' });
    await expect(sup.install({ source: { path: join(dir, 'nowhere') }, by: ADMIN })).rejects.toBeInstanceOf(ApiError);
  });

  it('gives a process absolute folders when the systems folder is relative, since it runs in its package folder', async () => {
    const sup = supervisor('shop', 2, new FakeInstaller('shop'), relative(process.cwd(), dir));
    await sup.install({ source: { package: '@x/shop', version: '1.0.0' }, by: ADMIN });
    expect(launcher.last.command.env[SYSTEM_ENV.state]).toBe(join(dir, 'shop', 'instances', 'main', 'state'));
    expect(isAbsolute(launcher.last.command.args[0] ?? '')).toBe(true);
  });

  it('runs a folder source in place', async () => {
    const folder = join(dir, 'src-shop');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'system.json'), JSON.stringify(systemJson('shop', '0.1.0', { server: { entry: 'main.ts', external: {} } })));
    const sup = supervisor();
    const installed = await sup.install({ source: { path: folder }, autoStart: false, by: ADMIN });
    expect(installed.command).toMatchObject({ args: [join(folder, 'main.ts')], cwd: folder });
    expect(installed.status).toBe('stopped');
  });
});

describe('running', () => {
  it('restarts a crashed system with backoff, then gives up after too many crashes an hour', async () => {
    const sup = supervisor('shop', 2);
    await sup.install({ source: { package: '@x/shop', version: '1.0.0' }, by: ADMIN });
    launcher.last.exit(1, 'boom');
    await settle(20);
    expect(launcher.launched).toHaveLength(2);
    expect((await sup.list())[0]?.lastExit).toMatchObject({ code: 1, output: 'boom' });
    launcher.last.exit(1);
    await settle(30);
    expect(launcher.launched).toHaveLength(3);
    launcher.last.exit(1);
    await settle(30);
    expect(launcher.launched).toHaveLength(3);
    expect((await sup.list())[0]?.status).toBe('disabled');
    // an admin starting it again resets the count
    await sup.start(SHOP);
    expect(launcher.launched).toHaveLength(4);
  });

  it('rolls an upgrade that keeps crashing back to the last good version', async () => {
    const sup = supervisor('shop', 1);
    await sup.install({ source: { package: '@x/shop', version: '1.0.0' }, by: ADMIN });
    const system = await connectInstalled(await manifestFor(shop));
    system.drop();
    expect(await sup.upgrade(SHOP, '2.0.0')).toEqual({ from: '1.0.0', to: '2.0.0' });
    await settle(60);
    expect(launcher.launched[0]?.killed).toBe(true);
    expect(launcher.last.command.args[0]).toContain(join('versions', '2.0.0'));
    launcher.last.exit(1);
    await settle(20);
    launcher.last.exit(1);
    await settle(20);
    const [installed] = await sup.list();
    expect(installed).toMatchObject({ version: '1.0.0', goodVersion: '1.0.0' });
    expect(launcher.last.command.args[0]).toContain(join('versions', '1.0.0'));
  });

  it('starts a system that exits with the restart code again at once, without counting a crash', async () => {
    const sup = supervisor('shop', 1);
    await sup.install({ source: { package: '@x/shop', version: '1.0.0' }, by: ADMIN });
    for (let restart = 1; restart <= 3; restart++) {
      launcher.last.exit(RESTART_CODE);
      await settle(5);
      expect(launcher.launched).toHaveLength(restart + 1);
    }
    expect((await sup.list())[0]).toMatchObject({ status: 'starting', lastExit: { code: RESTART_CODE } });
    // a real crash after the restarts is still the first one, so it is restarted too
    launcher.last.exit(1);
    await settle(20);
    expect(launcher.launched).toHaveLength(5);
  });

  it('does not restart a system that exits cleanly, or one it stopped', async () => {
    const sup = supervisor();
    await sup.install({ source: { package: '@x/shop', version: '1.0.0' }, by: ADMIN });
    launcher.last.exit(0);
    await settle(20);
    expect(launcher.launched).toHaveLength(1);
    expect((await sup.list())[0]?.status).toBe('stopped');
    await sup.start(SHOP);
    const stopping = sup.stop(SHOP, 'shutdown');
    launcher.last.exit(0);
    await stopping;
    await settle(20);
    expect(launcher.launched).toHaveLength(2);
    expect(launcher.last.killed).toBe(false);
  });

  it('asks a connected system to stop before ending its process', async () => {
    const sup = supervisor('vectors');
    await sup.install({ source: { package: '@x/vectors', version: '1.0.0' }, by: ADMIN });
    const system = await connectInstalled(await manifestFor(vectors), 'vectors');
    const stopped = sup.stopAll('shutdown');
    await settle(5);
    expect(system.stops).toEqual(['shutdown']);
    launcher.last.exit(0);
    await stopped;
    expect((await sup.list())[0]?.status).toBe('stopped');
  });

  it('starts every auto-start system with the hub, and uninstalls one', async () => {
    const sup = supervisor();
    await sup.install({ source: { package: '@x/shop', version: '1.0.0' }, autoStart: false, by: ADMIN });
    await sup.startAll();
    expect(launcher.launched).toHaveLength(0);
    await sup.upgrade(SHOP, '1.1.0');
    expect(launcher.launched).toHaveLength(0);
    const stop = sup.start(SHOP).then(() => sup.uninstall(SHOP));
    await settle(5);
    launcher.last.exit(0);
    await stop;
    expect(await sup.list()).toEqual([]);
    expect((await rig.store.table('systems').get(SystemName.parse('shop')))?.status).toBe('removed');
    await expect(sup.start(SHOP)).rejects.toMatchObject({ status: 404, code: 'NOT_INSTALLED' });
  });
});

describe('the Node ports', () => {
  it('reads a system.json, refusing a bad one and another link protocol', async () => {
    await writeFile(join(dir, 'system.json'), JSON.stringify({ ...systemJson('x', '1.0.0'), name: 'Bad Name' }));
    await expect(readManifest(dir)).rejects.toThrow(/name/);
    await writeFile(join(dir, 'system.json'), JSON.stringify(systemJson('x', '1.0.0', { protocol: LINK_PROTOCOL + 1 })));
    await expect(readManifest(dir)).rejects.toThrow(/link protocol/);
    await writeFile(join(dir, 'system.json'), '{ not json');
    await expect(readManifest(dir)).rejects.toThrow(/system.json/);
    expect((await new NodeInstaller({ npm: RIG_SETTINGS.packaging.HARNESS_NPM, maxBytes: RIG_SETTINGS.packaging.HARNESS_PACKAGE_MAX }).describe(join(dir, '..', 'nowhere-at-all')).catch((e: unknown) => e)) instanceof Error).toBe(true);
  });

});
