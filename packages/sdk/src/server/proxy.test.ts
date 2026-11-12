import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AllowlistProxy, hostAllowed, proxyEnv, type ProxyRefusal } from './proxy.ts';
import { AccessDeniedReader, scrubbedEnv } from './supervise.ts';

const open: Array<{ close(): unknown }> = [];
afterEach(async () => { for (const one of open.splice(0)) { await one.close(); } });

/** A plain web server on 127.0.0.1 answering `ok`; resolves to its port. */
async function target(): Promise<number> {
  const server: Server = createServer((_req, res) => { res.end('ok'); });
  open.push({ close: () => new Promise((done) => { server.close(done); }) });
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') { throw new Error('no port'); }
  return address.port;
}

/** What a child Node process gets fetching `url` with `env` on top of a scrubbed environment. */
function childFetch(url: string, env: Record<string, string>): Promise<string> {
  const code = `fetch(${JSON.stringify(url)}).then((r) => r.text().then((t) => console.log(r.status + ' ' + t)), (e) => console.log('failed ' + String(e.cause?.message ?? e.message)))`;
  return new Promise((done) => {
    const child = spawn(process.execPath, ['-e', code], { env: scrubbedEnv(process.env, env) });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('exit', () => { done(out.trim()); });
  });
}

describe('the allowlist proxy', () => {
  it('matches hosts by name or by a wildcard under a domain', () => {
    expect(hostAllowed(['api.tavily.com', '*.googleapis.com'], 'api.tavily.com')).toBe(true);
    expect(hostAllowed(['api.tavily.com', '*.googleapis.com'], 'www.googleapis.com')).toBe(true);
    expect(hostAllowed(['api.tavily.com', '*.googleapis.com'], 'googleapis.com.evil.net')).toBe(false);
    expect(hostAllowed(['api.tavily.com'], 'tavily.com')).toBe(false);
  });

  it('lets a child reach the hosts it allows, and refuses and reports the rest', async () => {
    const port = await target();
    const refused: ProxyRefusal[] = [];
    const allowing = new AllowlistProxy({ allow: ['127.0.0.1'], onRefused: (refusal) => { refused.push(refusal); } });
    open.push(allowing);
    expect(await childFetch(`http://127.0.0.1:${String(port)}/`, proxyEnv(await allowing.start(), []))).toBe('200 ok');

    const strict = new AllowlistProxy({ allow: ['api.example.com'], onRefused: (refusal) => { refused.push(refusal); } });
    open.push(strict);
    // the proxy refuses the tunnel, so the request fails
    expect(await childFetch(`http://127.0.0.1:${String(port)}/`, proxyEnv(await strict.start(), []))).toMatch(/^failed /);
    expect(refused).toEqual([{ host: '127.0.0.1', port }]);
  });
});

describe('reading permission refusals', () => {
  it('reads the permission and path of an access Node refused', () => {
    const reader = new AccessDeniedReader();
    const lines = [
      'Error: Access to this API has been restricted. Use --allow-fs-read to manage permissions.',
      '    at Object.openSync (node:fs:560:18) {',
      "  code: 'ERR_ACCESS_DENIED',",
      "  permission: 'FileSystemRead',",
      "  resource: '\\\\\\\\?\\\\C:\\\\Windows\\\\win.ini'",
      '}',
    ];
    expect(lines.map((line) => reader.line(line)).filter((found) => found !== undefined)).toEqual([{ permission: 'FileSystemRead', resource: 'C:\\Windows\\win.ini' }]);
  });
});
