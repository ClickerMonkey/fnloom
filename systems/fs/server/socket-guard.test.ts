/**
 * The hosted socket guard in a real Node process: only the allowed endpoint is reached, and a raw socket, an `http`
 * request with an agent of its own, a server and a name lookup are refused (Node 22's permission model and the proxy
 * variables don't stop those), each printing the line the runner reports.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NETWORK_ALLOW_VAR, endpointOf, endpointsText, parseEndpoints, refusedOfLine } from './socket-guard.ts';

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
