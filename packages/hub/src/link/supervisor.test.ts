import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@ayepi/core';
import { SystemName, type InstallSource, type Manifest } from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, manifestFor, shop, vectors } from '../catalog/fixtures.ts';
import { settle } from '../catalog/testing.ts';
import { StoredKeyPair } from './keys.ts';
import { NodeInstaller, NodeLauncher, SystemPackageJson, type Installer, type ProcessExit, type ProcessLauncher, type SystemCommand, type SystemPackage, type SystemProcess } from './process.ts';
import { FakeSystem, linkRig, type LinkRig } from './rig.ts';
import { ProcessSupervisor, SYSTEM_ENV } from './supervisor.ts';

/** A process the test ends by hand. */
class FakeProcess implements SystemProcess {
  readonly pid: number;
  readonly exited: Promise<ProcessExit>;
  killed = false;
  #end: (exit: ProcessExit) => void = () => undefined;

  readonly command: SystemCommand;

  constructor(command: SystemCommand, pid: number) {
    this.command = command;
    this.pid = pid;
    this.exited = new Promise((resolve) => { this.#end = resolve; });
  }

  exit(code: number, output = ''): void { this.#end({ code, output }); }
  kill(): void { this.killed = true; this.exit(143, 'killed'); }
}

class FakeLauncher implements ProcessLauncher {
  readonly launched: FakeProcess[] = [];
  launch(command: SystemCommand): FakeProcess {
    const process = new FakeProcess(command, 100 + this.launched.length);
    this.launched.push(process);
    return process;
  }
  get last(): FakeProcess {
    const last = this.launched.at(-1);
    if (last === undefined) { throw new Error('nothing launched'); }
    return last;
  }
}

/** Writes a package.json for the source's version instead of running npm or git. */
class FakeInstaller implements Installer {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }
  async fetch(source: InstallSource, dir: string): Promise<SystemPackage> {
    if ('path' in source) { return this.describe(source.path); }
    const version = 'package' in source ? (source.version === 'latest' ? '9.0.0' : source.version) : source.ref;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `@x/${this.name}`, version, harness: { name: this.name, main: 'server/main.ts' } }));
    return this.describe(dir);
  }
  describe(dir: string): Promise<SystemPackage> {
    return new NodeInstaller().describe(dir);
  }
}

let rig: LinkRig;
let dir: string;
let launcher: FakeLauncher;
const SHOP = SystemName.parse('shop');

function supervisor(name = 'shop', perHour = 2) {
  return new ProcessSupervisor({
    store: rig.store, log: rig.log, clock: () => rig.time.now, links: rig.links, pairing: rig.pairing, config: rig.config, status: rig.status,
    launcher, installer: new FakeInstaller(name),
    settings: { systemsDir: dir, hubLink: 'ws://hub:4300/link', stopTimeout: 50, backoff: 5, perHour },
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
async function connectInstalled(manifest: Manifest, name = 'shop'): Promise<FakeSystem> {
  const keys = StoredKeyPair.parse(JSON.parse(await readFile(join(dir, name, 'state', 'key.json'), 'utf8')));
  const system = new FakeSystem(rig.app, name, manifest, keys);
  await system.start();
  await settle(5);
  return system;
}

describe('installing', () => {
  it('installs a package into its version folder, pairs it with a key it made, and starts it', async () => {
    const sup = supervisor();
    const installed = await sup.install({ source: { package: '@x/shop', version: '1.0.0' }, config: { currency: 'EUR' }, by: ADMIN });
    expect(installed).toMatchObject({ name: 'shop', version: '1.0.0', status: 'starting', autoStart: true, pid: 100, dir: join(dir, 'shop') });
    expect(launcher.last.command).toMatchObject({
      run: process.execPath,
      args: [join(dir, 'shop', 'versions', '1.0.0', 'server', 'main.ts')],
      env: { [SYSTEM_ENV.hub]: 'ws://hub:4300/link', [SYSTEM_ENV.state]: join(dir, 'shop', 'state'), [SYSTEM_ENV.name]: 'shop' },
    });
    expect((await rig.store.table('systems').get('shop'))?.pairedBy).toBe(ADMIN);

    // the process connects with the key the hub made; its config was waiting for its contract
    const system = await connectInstalled(await manifestFor(shop));
    expect((await rig.store.table('systems').get('shop'))).toMatchObject({ status: 'connected', config: { value: { currency: 'EUR' } } });
    expect(system.configured).toEqual([{ value: { currency: 'EUR' }, version: 1 }]);
    expect((await sup.list())[0]).toMatchObject({ status: 'running', goodVersion: '1.0.0' });
  });

  it('refuses a second install of the same system and a source it can’t fetch', async () => {
    const sup = supervisor();
    await sup.install({ source: { package: '@x/shop', version: '1.0.0' }, autoStart: false, by: ADMIN });
    await expect(sup.install({ source: { package: '@x/shop', version: '1.0.0' }, by: ADMIN })).rejects.toMatchObject({ status: 409, code: 'ALREADY_INSTALLED' });
    await expect(sup.install({ source: { path: join(dir, 'nowhere') }, by: ADMIN })).rejects.toBeInstanceOf(ApiError);
  });

  it('runs a folder source in place', async () => {
    const folder = join(dir, 'src-shop');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'shop', version: '0.1.0', harness: { name: 'shop', main: 'main.ts' } }));
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
    expect((await rig.store.table('systems').get('shop'))?.status).toBe('removed');
    await expect(sup.start(SHOP)).rejects.toMatchObject({ status: 404, code: 'NOT_INSTALLED' });
  });
});

describe('the Node ports', () => {
  it('reads a system package.json', () => {
    expect(SystemPackageJson.safeParse({ name: 'x', version: '1', harness: { name: 'Bad Name', main: 'm.ts' } }).success).toBe(false);
  });

  it('launches a real process and keeps the end of its output', async () => {
    const real = new NodeLauncher({ baseEnv: { PATH: process.env['PATH'] } });
    const child = real.launch({ run: process.execPath, args: ['-e', 'console.log("hi " + process.env.WHO); process.exit(3)'], env: { WHO: 'there' } });
    expect(await child.exited).toEqual({ code: 3, output: 'hi there\n' });
    const missing = real.launch({ run: join(dir, 'no-such-binary'), args: [], env: {} });
    expect((await missing.exited).code).toBe(-1);
  });
});
