/**
 * What a rendered page's network can reach beyond request interception: each tab's connections go through its own
 * proxy, which connects only to the address the guard checked a host at (private ones refused), so WebSocket
 * handshakes, service workers and DNS rebinding can't reach this machine or its network. Chrome's side (its flags, the
 * context's proxy, the blocked WebSocket URLs) is checked as the rules it is given; that Chrome keeps to them is a
 * live check.
 */
import { createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCKED_URL_PATTERNS, BLOCKED_URLS, CHROME_ARGS, contextOptions } from './chrome.ts';
import { AddressGuard } from './guard.ts';
import { PageTabs, tabProxy } from './renderer.ts';
import { PUBLIC_DNS, fakeLauncher, tableLookup } from './testing.ts';

const open: Array<{ close(): unknown }> = [];
afterEach(async () => { for (const one of open.splice(0)) { await one.close(); } });

/** A server on this machine (what a page must never reach unless private addresses are allowed); resolves to its port. */
async function local(): Promise<number> {
  const server: Server = createServer((_req, res) => { res.end('inside'); });
  open.push({ close: () => new Promise((done) => { server.close(done); }) });
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

/** A plain http request for `url` through the proxy at `proxy`: its status and body. */
function viaProxy(proxy: string, url: string): Promise<string> {
  const at = new URL(proxy);
  return new Promise((done, fail) => {
    const asked = request({ host: at.hostname, port: at.port, path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      res.on('end', () => { done(`${String(res.statusCode)} ${body}`); });
    });
    asked.on('error', fail);
    asked.end();
  });
}

/** A `CONNECT` (https, wss) through the proxy at `proxy`: the status it answers. */
function tunnel(proxy: string, authority: string): Promise<number> {
  const at = new URL(proxy);
  return new Promise((done, fail) => {
    const asked = request({ host: at.hostname, port: at.port, method: 'CONNECT', path: authority });
    asked.on('connect', (res, socket) => { socket.destroy(); done(res.statusCode ?? 0); });
    asked.on('error', fail);
    asked.end();
  });
}

describe('a tab’s proxy', () => {
  it('refuses a name that resolves to this machine, whatever the page used to reach it (a WebSocket, a service worker)', async () => {
    const port = await local();
    // a rebinding name: public when the page was checked, this machine now
    const proxy = tabProxy(new AddressGuard(tableLookup({ ...PUBLIC_DNS, 'rebind.example.com': ['127.0.0.1'] }), false));
    open.push(proxy);
    const url = await proxy.start();
    expect(await viaProxy(url, `http://rebind.example.com:${String(port)}/`)).toBe('403 ');
    expect(await tunnel(url, `rebind.example.com:${String(port)}`)).toBe(403);
    expect(await viaProxy(url, `http://127.0.0.1:${String(port)}/`)).toBe('403 ');
    expect(await tunnel(url, `[::1]:${String(port)}`)).toBe(403);
  });

  it('reads a host in a number form as the address it means, never as a name to look up', async () => {
    const port = await local();
    const guard = new AddressGuard(tableLookup(PUBLIC_DNS), false);
    // 2130706433 and 0x7f.1 are 127.0.0.1
    await expect(guard.address('2130706433')).rejects.toMatchObject({ code: 'private-address' });
    await expect(guard.address('0x7f.1')).rejects.toMatchObject({ code: 'private-address' });
    // 0x5db8d822 is 93.184.216.34: connected at that address, with no lookup (the table knows no such name)
    await expect(guard.address('0x5db8d822')).resolves.toBe('93.184.216.34');
    const proxy = tabProxy(guard);
    open.push(proxy);
    expect(await tunnel(await proxy.start(), `2130706433:${String(port)}`)).toBe(403);
  });

  it('connects at the address the guard checked, never looking the name up again', async () => {
    const port = await local();
    // no DNS knows this name: only the guard's lookup does, so reaching the server proves the checked address is used
    const proxy = tabProxy(new AddressGuard(tableLookup({ 'only-the-guard-knows.test': ['127.0.0.1'] }), true));
    open.push(proxy);
    const url = await proxy.start();
    expect(await viaProxy(url, `http://only-the-guard-knows.test:${String(port)}/`)).toBe('200 inside');
    expect(await tunnel(url, `only-the-guard-knows.test:${String(port)}`)).toBe(200);
  });

  it('is opened for each tab and closed with it', async () => {
    const launch = fakeLauncher((load) => Promise.resolve({ html: '<html></html>', url: load.url }));
    const tabs = new PageTabs({ launch, concurrency: 1, timeout: 1_000, idle: 0, userAgent: 'test' });
    await tabs.renderer(new AddressGuard(tableLookup(PUBLIC_DNS), false)).render({ url: 'https://example.com/', html: '' });
    const proxy = launch.browsers[0]?.networks[0]?.proxy ?? '';
    expect(proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // closed once the page was taken
    await expect(viaProxy(proxy, 'http://example.com/')).rejects.toThrow();
  });
});

describe('Chrome’s network rules', () => {
  it('sends a context’s every connection through its proxy, this machine included, and blocks WebSockets', () => {
    expect(contextOptions({ proxy: 'http://127.0.0.1:5000' })).toEqual({ proxyServer: 'http://127.0.0.1:5000', proxyBypassList: ['<-loopback>'] });
    expect(BLOCKED_URL_PATTERNS).toEqual(['ws://*:*/*', 'wss://*:*/*']);
    expect(BLOCKED_URLS).toEqual(['ws://*', 'wss://*']);
    expect(CHROME_ARGS).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  });
});
