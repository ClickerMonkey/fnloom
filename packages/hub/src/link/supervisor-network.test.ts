/**
 * The network of an instance the hub's supervisor runs, held to its grant: real Node processes started by the SDK's
 * `NodeStarter` through the supervisor, each with its own `AllowlistProxy` of the grant's hosts and the socket guard
 * preloaded, reaching local web servers on 127.0.0.1. What one is refused is kept as that instance's refusal. And,
 * over fake gates, that a gate lives exactly as long as its process and follows a grant that changes while it runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIN_INSTANCE, SystemName, type RefusalRecord } from '@harness/core';
import { NodeStarter, RESTART_CODE, type ProcessCommand, type ProcessStarter } from '@harness/sdk/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN } from '../catalog/fixtures.ts';
import { allRows } from '../store/rows.ts';
import { settle } from '../testing.ts';
import { NodeInstaller } from './process.ts';
import { FakeLauncher, FakeNetwork, RIG_SETTINGS, linkRig, systemJson, type LinkRig } from './rig.ts';
import { ProcessSupervisor, grantedNetwork, type SupervisorNetwork } from './supervisor.ts';

const SHOP = SystemName.parse('shop');
const MAIN = { system: SHOP, instance: MAIN_INSTANCE };

let rig: LinkRig;
let dir: string;
const servers: Server[] = [];
let portA = 0;
let portB = 0;

function serve(): Promise<number> {
  return new Promise((done) => {
    const server = createServer((_req, res) => { res.end('ok'); });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address: AddressInfo | string | null = server.address();
      done(address === null || typeof address === 'string' ? 0 : address.port);
    });
  });
}

beforeAll(async () => { [portA, portB] = await Promise.all([serve(), serve()]); });
afterAll(() => { for (const server of servers) { server.close(); } });
beforeEach(async () => {
  rig = await linkRig();
  dir = mkdtempSync(join(tmpdir(), 'harness-supnet-'));
});
afterEach(async () => {
  await rig.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Approve `network` as the live grant of the shop system. */
async function approve(network: string[]): Promise<void> {
  await rig.store.table('systemReviews').put({ system: SHOP, live: { version: '0.1.0', hash: 'h', grants: { hub: [], network }, runtime: [], by: ADMIN, at: 1 }, updatedAt: 1 });
}

/** A NodeStarter that keeps what it launched and what each process printed. */
class RecordingStarter implements ProcessStarter {
  readonly commands: ProcessCommand[] = [];
  output = '';
  readonly #starter = new NodeStarter({ baseEnv: process.env, nodeArgs: [], outputTail: 8_192 });
  launch(command: ProcessCommand) {
    this.commands.push(command);
    return this.#starter.launch({ ...command, onOutput: (text) => { this.output += text; command.onOutput?.(text); } });
  }
}

/**
 * A folder system whose server fetches A (127.0.0.1) and B (localhost) the way a system would, opens a raw socket to
 * A around the proxy, says what came of each, and then waits to be stopped.
 */
async function folderSystem(): Promise<string> {
  const folder = join(dir, 'src-shop');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'system.json'), JSON.stringify(systemJson('shop', '0.1.0', { server: { entry: 'main.mjs', external: {} } })));
  await writeFile(join(folder, 'main.mjs'), `
import net from 'node:net';
const outcome = (name, run) => Promise.resolve().then(run).then((said) => console.log(name + ' ' + said), (e) => console.log(name + ' failed ' + (e.cause?.message ?? e.message)));
await outcome('a', () => fetch('http://127.0.0.1:${String(portA)}/').then((r) => r.text()));
await outcome('b', () => fetch('http://localhost:${String(portB)}/').then((r) => r.status === 200 ? r.text() : 'status ' + r.status));
await outcome('raw', () => new Promise((done, fail) => { const s = net.connect(${String(portA)}, '127.0.0.1', () => { s.end(); done('ok'); }); s.on('error', fail); }));
console.log('done');
setInterval(() => {}, 60_000);
`);
  return folder;
}

function supervisor(launcher: ProcessStarter, network: SupervisorNetwork): ProcessSupervisor {
  return new ProcessSupervisor({
    store: rig.store, log: rig.log, clock: () => rig.time.now, links: rig.links, pairing: rig.pairing, config: rig.config, instances: rig.instances,
    launcher, installer: new NodeInstaller({ npm: RIG_SETTINGS.packaging.HARNESS_NPM, maxBytes: RIG_SETTINGS.packaging.HARNESS_PACKAGE_MAX }), network,
    // the hub's host is one nothing here resolves, so every local request goes to the proxy
    settings: { systemsDir: dir, hubLink: 'ws://hub.invalid:4300/link', stopTimeout: 50, backoff: 5, perHour: 2, maxBackoff: 300_000 },
  });
}

/** Whether something listens at a URL's port on 127.0.0.1. */
function listening(url: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(Number(new URL(url).port), '127.0.0.1', () => { socket.end(); done(true); });
    socket.on('error', () => { done(false); });
  });
}

async function networkRefusals(): Promise<RefusalRecord[]> {
  return (await allRows(rig.store.table('refusals'))).filter((r) => r.rule === 'network');
}

describe('a supervised instance\'s network', () => {
  it('reaches the hosts its grant names through its own proxy, is refused the rest, and keeps each refusal as its own', { timeout: 30_000 }, async () => {
    await approve(['127.0.0.1']);
    const starter = new RecordingStarter();
    const sup = supervisor(starter, grantedNetwork(rig.grants, rig.bus));
    await sup.install({ source: { path: await folderSystem() }, by: ADMIN });
    await vi.waitFor(() => { expect(starter.output).toContain('done'); }, { timeout: 20_000, interval: 50 });

    const lines = starter.output.split(/\r?\n/);
    expect(lines).toContain('a ok');
    expect(lines.some((line) => line.startsWith('b ') && line !== 'b ok')).toBe(true);
    // the raw socket went around the proxy, so the guard refused it
    expect(lines.find((line) => line.startsWith('raw '))).toMatch(/^raw failed .*grants\.network/);
    const command = starter.commands[0];
    const proxy = command?.env?.['HTTP_PROXY'] ?? '';
    expect(command?.env).toMatchObject({ NO_PROXY: 'hub.invalid', NODE_USE_ENV_PROXY: '1', HARNESS_NETWORK_ALLOW: `${new URL(proxy).host},hub.invalid:4300` });
    await vi.waitFor(async () => {
      expect(await networkRefusals()).toEqual(expect.arrayContaining([
        expect.objectContaining({ system: SHOP, instance: MAIN_INSTANCE, attempt: `localhost:${String(portB)}` }),
        expect.objectContaining({ system: SHOP, instance: MAIN_INSTANCE, attempt: `127.0.0.1:${String(portA)}` }),
      ]));
    }, { timeout: 5_000, interval: 50 });
    expect(await networkRefusals()).toHaveLength(2);

    // stopped, it has no proxy any more
    expect(await listening(proxy)).toBe(true);
    await sup.stop(SHOP, 'shutdown');
    expect(await listening(proxy)).toBe(false);
  });

  it('reaches any host with a grant of *', { timeout: 30_000 }, async () => {
    await approve(['*']);
    const starter = new RecordingStarter();
    const sup = supervisor(starter, grantedNetwork(rig.grants, rig.bus));
    await sup.install({ source: { path: await folderSystem() }, by: ADMIN });
    await vi.waitFor(() => { expect(starter.output).toContain('done'); }, { timeout: 20_000, interval: 50 });
    const lines = starter.output.split(/\r?\n/);
    expect(lines).toEqual(expect.arrayContaining(['a ok', 'b ok']));
    await sup.stop(SHOP, 'shutdown');
    // only the raw socket around the proxy was refused
    expect((await networkRefusals()).map((r) => r.attempt)).toEqual([`127.0.0.1:${String(portA)}`]);
  });
});

describe('a supervised instance\'s gate', () => {
  it('is opened for each process and closed once it exits, stops or restarts', async () => {
    const launcher = new FakeLauncher();
    const network = new FakeNetwork();
    const sup = supervisor(launcher, network);
    await sup.install({ source: { path: await folderSystem() }, by: ADMIN });
    expect(network.gates).toHaveLength(1);
    expect(network.gates[0]?.allow).toEqual(['hub.invalid']);
    expect(launcher.last.command.env).toMatchObject({ HTTP_PROXY: network.gates[0]?.url });

    // a restart closes the old gate and opens a new one
    launcher.last.exit(RESTART_CODE);
    await settle(10);
    expect(network.gates.map((gate) => gate.closed)).toEqual([true, false]);
    expect(launcher.launched).toHaveLength(2);
    expect(launcher.last.command.env).toMatchObject({ HTTP_PROXY: network.gates[1]?.url });

    await sup.stop(SHOP, 'shutdown');
    expect(network.gates.map((gate) => gate.closed)).toEqual([true, true]);
  });

  it('follows a grant approved while the process runs', async () => {
    const launcher = new FakeLauncher();
    const fake = new FakeNetwork();
    const sup = supervisor(launcher, { ...grantedNetwork(rig.grants, rig.bus), gate: (allow) => fake.gate(allow) });
    await sup.install({ source: { path: await folderSystem() }, by: ADMIN });
    // nothing is known of its contract yet
    expect(fake.gates[0]?.allow).toEqual(['hub.invalid']);
    await approve(['api.example.com']);
    rig.bus.publish('capabilities.changed', {});
    await settle(10);
    expect(fake.gates[0]?.allow).toEqual(['api.example.com', 'hub.invalid']);
    await sup.stop(SHOP, 'shutdown');
    expect((await rig.instances.get(MAIN))?.installed?.status).toBe('stopped');
  });
});
