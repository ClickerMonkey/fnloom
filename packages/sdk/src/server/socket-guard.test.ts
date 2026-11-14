/**
 * The hosted socket guard in a real Node process: only the allowed endpoint is reached, and a raw socket, an `http`
 * request with an agent of its own, a server and a name lookup are refused (Node 22's permission model and the proxy
 * variables don't stop those), each printing the line the runner reports. And the guard's rules in this process, over
 * stand-ins for net, dgram and dns (the real ones it would fix in place for good): how each way of naming a target is read.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NETWORK_ALLOW_VAR, endpointOf, endpointsText, guardNetwork, parseEndpoints, refusedOfLine } from './socket-guard.ts';

/** Stand-ins for the modules the guard fixes: each method answers what it is, so a call that gets through shows. */
const stand = vi.hoisted(() => {
  const answer = (name: string) => function (this: unknown): string { return name; };
  // the guard reaches each class through its prototype only
  const Socket = { prototype: { connect: answer('connected') } };
  const Server = { prototype: { listen: answer('listening') } };
  const Udp = { prototype: { bind: answer('bound'), connect: answer('udp'), send: answer('sent') } };
  const Resolver = { prototype: { resolve4: answer('resolved'), reverse: answer('reversed'), lookup: answer('looked up') } };
  const PromiseResolver = { prototype: { resolve: answer('resolved') } };
  // dns.promises has no lookup of its own here, which the guard leaves be
  const promises = { resolveTxt: answer('resolved'), Resolver: PromiseResolver };
  const dns = { lookup: answer('looked up'), lookupService: answer('service'), resolve: answer('resolved'), reverse: answer('reversed'), setServers: answer('set'), promises, Resolver };
  return { net: { Socket, Server }, dgram: { Socket: Udp }, dns };
});
vi.mock('node:net', () => ({ default: stand.net }));
vi.mock('node:dgram', () => ({ default: stand.dgram }));
vi.mock('node:dns', () => ({ default: stand.dns }));

const GUARD = fileURLToPath(new URL('./hosted-network-guard.ts', import.meta.url));

/** What the child does: each attempt prints `name ok` or `name refused: message`. */
const SCRIPT = `
import net from 'node:net';
import http from 'node:http';
import dns from 'node:dns/promises';
const [allowed, other] = process.argv.slice(-2).map(Number);
const outcome = (name, run) => Promise.resolve().then(run).then(() => console.log(name + ' ok'), (e) => console.log(name + ' refused: ' + (e.cause?.message ?? e.message)));
const socket = (port) => () => new Promise((done, fail) => { const s = net.connect(port, '127.0.0.1', () => { s.end(); done(); }); s.on('error', fail); });
await outcome('allowed', socket(allowed));
await outcome('raw', socket(other));
await outcome('agent', () => new Promise((done, fail) => { http.get({ host: '127.0.0.1', port: other, agent: new http.Agent() }, (res) => { res.resume(); done(); }).on('error', fail); }));
await outcome('fetch', () => fetch('http://127.0.0.1:' + other + '/'));
await outcome('listen', () => new Promise((done, fail) => { const s = net.createServer(); s.on('error', fail); s.listen(0, () => { s.close(); done(); }); }));
await outcome('lookup', () => dns.lookup('example.com'));
await outcome('pipe', socket('guard-test.sock'));
`;

function serve(): Promise<Server> {
  return new Promise((done) => { const server = createServer((_req, res) => { res.end('hi'); }); server.listen(0, '127.0.0.1', () => { done(server); }); });
}
function portOf(server: Server): number {
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') { throw new Error('the server has no port'); }
  return address.port;
}

describe('the hosted socket guard', () => {
  let allowed: Server;
  let other: Server;
  beforeAll(async () => { [allowed, other] = await Promise.all([serve(), serve()]); });
  afterAll(() => { allowed.close(); other.close(); });

  it('reads endpoints the way the runner writes them', () => {
    const endpoints = [endpointOf('http://LocalHost:4300/'), endpointOf('https://[::1]/'), endpointOf('ws://hub.local')];
    expect(endpointsText(endpoints)).toBe('localhost:4300,::1:443,hub.local:80');
    expect(parseEndpoints(endpointsText(endpoints))).toEqual(endpoints);
    expect(refusedOfLine('harness.network.refused 10.0.0.1:80')).toBe('10.0.0.1:80');
    expect(refusedOfLine('anything else')).toBeUndefined();
  });

  it('lets a process reach only the allowed endpoint', { timeout: 30_000 }, async () => {
    const env = { ...process.env, [NETWORK_ALLOW_VAR]: `127.0.0.1:${String(portOf(allowed))}` };
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--require', GUARD, '--input-type=module', '--eval', SCRIPT, String(portOf(allowed)), String(portOf(other))],
      { env, cwd: fileURLToPath(new URL('.', import.meta.url)) });
    const lines = stdout.trim().split(/\r?\n/);
    expect(lines[0]).toBe('allowed ok');
    const refusal = `127.0.0.1:${String(portOf(other))} is not in this system's grants.network`;
    expect(lines.slice(1)).toEqual([
      `raw refused: ${refusal}`, `agent refused: ${refusal}`, `fetch refused: ${refusal}`,
      expect.stringMatching(/^listen refused: listen is not/), expect.stringMatching(/^lookup refused: example\.com is not/), "pipe refused: guard-test.sock is not in this system's grants.network",
    ]);
    expect(stderr).toContain(`harness.network.refused 127.0.0.1:${String(portOf(other))}`);
  });
});

/** Call `name` on `target` the way the guarded code would, by whatever is there now. */
function call(target: object, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== 'function') { throw new Error(`no ${name} on the stand-in`); }
  const result: unknown = Reflect.apply(method, target, args);
  return result;
}

/** What a call comes to: what the original answered, or the refusal's message. */
function outcome(target: object, name: string, ...args: unknown[]): unknown {
  try { return call(target, name, ...args); } catch (error) { return error instanceof Error ? error.message : error; }
}

describe('the socket guard\'s rules', () => {
  const allow = [{ host: '127.0.0.1', port: 4300 }, { host: '[::1]', port: 443 }, { host: 'Hub.Local.', port: 80 }];
  beforeAll(() => { guardNetwork({ allow, refused: (target, kind) => `${kind} ${target}` }); });

  it('lets a socket reach an allowed endpoint, however the call names it', () => {
    const socket = stand.net.Socket.prototype;
    // net.connect hands the socket its normalized arguments as an array
    expect(outcome(socket, 'connect', [{ host: '127.0.0.1', port: 4300 }, null])).toBe('connected');
    expect(outcome(socket, 'connect', { host: 'HUB.local', port: '80' })).toBe('connected');
    expect(outcome(socket, 'connect', 4300, '127.0.0.1')).toBe('connected');
    expect(outcome(socket, 'connect', '443', '[::1]')).toBe('connected');
  });

  it('refuses every other endpoint, a pipe, and a target it can\'t read, and names each', () => {
    const socket = stand.net.Socket.prototype;
    expect(outcome(socket, 'connect', { host: '127.0.0.1', port: 4301 })).toBe('connect 127.0.0.1:4301');
    // no host (or an empty one) is localhost, which isn't 127.0.0.1 by name
    expect(outcome(socket, 'connect', { port: 4300 })).toBe('connect localhost:4300');
    expect(outcome(socket, 'connect', { host: '', port: 80 })).toBe('connect localhost:80');
    expect(outcome(socket, 'connect', 4300)).toBe('connect localhost:4300');
    expect(outcome(socket, 'connect', '80', '')).toBe('connect localhost:80');
    expect(outcome(socket, 'connect', { path: '/run/hub.sock', host: '127.0.0.1', port: 4300 })).toBe('pipe /run/hub.sock');
    expect(outcome(socket, 'connect', 'hub.sock')).toBe('pipe hub.sock');
    expect(outcome(socket, 'connect', { path: '', port: 'any' })).toBe('connect any');
    expect(outcome(socket, 'connect')).toBe('connect undefined');
  });

  it('shuts servers and UDP', () => {
    expect(outcome(stand.net.Server.prototype, 'listen', 0)).toBe('listen listen');
    for (const name of ['bind', 'connect', 'send']) { expect(outcome(stand.dgram.Socket.prototype, name)).toBe(`udp ${name}`); }
  });

  it('looks up only an allowed host and shuts DNS queries', () => {
    const { dns } = stand;
    expect(outcome(dns, 'lookup', 'hub.local.')).toBe('looked up');
    expect(outcome(dns, 'lookup', '[::1]')).toBe('looked up');
    expect(outcome(dns, 'lookup', 'example.com')).toBe('dns example.com');
    expect(outcome(dns, 'lookup', 42)).toBe('dns 42');
    for (const name of ['lookupService', 'resolve', 'reverse']) { expect(outcome(dns, name, 'hub.local')).toBe(`dns ${name}`); }
    expect(outcome(dns.promises, 'resolveTxt', 'hub.local')).toBe('dns resolveTxt');
    expect('lookup' in dns.promises).toBe(false);
    // a resolver asks DNS servers itself, even for an allowed host
    expect(outcome(dns.Resolver.prototype, 'lookup', 'hub.local')).toBe('dns lookup');
    expect(outcome(dns.Resolver.prototype, 'resolve4', 'hub.local')).toBe('dns resolve4');
    expect(outcome(dns.promises.Resolver.prototype, 'resolve', 'hub.local')).toBe('dns resolve');
    // what the guard doesn't name is left as it was
    expect(outcome(dns, 'setServers', [])).toBe('set');
  });

  it('fixes each replacement in place, so the guarded code can\'t put the original back', () => {
    const socket = stand.net.Socket.prototype;
    expect(() => { Object.defineProperty(socket, 'connect', { value: () => 'connected' }); }).toThrow(TypeError);
    expect(Reflect.set(socket, 'connect', () => 'connected')).toBe(false);
    expect(outcome(socket, 'connect', { port: 1 })).toBe('connect localhost:1');
  });

  it('reads endpoints from a URL by its scheme, and drops malformed parts of an environment value', () => {
    expect([endpointOf('https://Hub.Local./x'), endpointOf('wss://hub.local'), endpointOf('ws://hub.local:9000')]).toEqual([
      { host: 'hub.local', port: 443 }, { host: 'hub.local', port: 443 }, { host: 'hub.local', port: 9000 },
    ]);
    expect(parseEndpoints(undefined)).toEqual([]);
    expect(parseEndpoints('nohost,:80,hub:0,hub:x,hub:1.5,HUB:81')).toEqual([{ host: 'hub', port: 81 }]);
  });
});
