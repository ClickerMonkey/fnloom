/**
 * Security finding M3 (2026-11-21): the hub's own pages and files carry protective headers. The app page has a content
 * security policy with no inline or outside scripts and no framing, and a system client build's `.html` or `.svg` is
 * sent as a download, so it can't run as a page on the hub's origin. (The headers on every response, API included,
 * are checked on a running hub in `boot/start.test.ts`.)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemName } from '@harness/core';
import { appCsp, ClientBuildRoute, secureResponse, WebAppRoute, type FileRoute } from './serve.ts';

/** Serve routes on a free local port the way the HTTP front does: the security headers first. */
async function serveRoutes(routes: readonly FileRoute[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      secureResponse(res);
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      for (const route of routes) { if (await route.serve(req, res, path)) { return; } }
      res.writeHead(404).end('none');
    })();
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => { server.close(() => { resolve(); }); }) };
}

/** The directives of a policy, by name. */
function directives(policy: string | null): Map<string, string[]> {
  return new Map((policy ?? '').split(';').map((part) => part.trim().split(/\s+/)).filter((words) => words[0] !== '').map(([name = '', ...values]) => [name, values]));
}

describe('the app page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-headers-'));
  let site: Awaited<ReturnType<typeof serveRoutes>>;
  beforeAll(async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Harness</title>');
    writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    site = await serveRoutes([new WebAppRoute(dir, { identity: () => Promise.resolve({ name: 'Harness', source: 'default' as const, version: '1' }) }, 'https://hub.example')]);
  });
  afterAll(async () => {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('can\'t be framed, sniffed or run inline or outside scripts', async () => {
    const res = await fetch(`${site.url}/sessions/ses_1`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    const csp = directives(res.headers.get('content-security-policy'));
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'https:']);
    // requests and sockets reach the hub only: this origin, the host it was reached at, and HARNESS_URL
    expect(csp.get('connect-src')).toEqual(expect.arrayContaining(["'self'", 'https://hub.example', 'wss://hub.example', `ws://${new URL(site.url).host}`]));
    expect(csp.get('connect-src')?.some((source) => source === '*' || source === 'https:')).toBe(false);
  });

  it('keeps a Host header that isn\'t a plain host out of the policy', () => {
    expect(appCsp('http://localhost:4300', "evil; script-src *")).not.toContain('evil');
    expect(directives(appCsp('http://localhost:4300', "evil; script-src *")).get('script-src')).toEqual(["'self'"]);
  });

  it('sends the other files with the headers that stop framing and sniffing', async () => {
    const res = await fetch(`${site.url}/favicon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(directives(res.headers.get('content-security-policy')).get('frame-ancestors')).toEqual(["'none'"]);
  });
});

describe('a system client build', () => {
  const fs = SystemName.parse('fs');
  const files = { 'index.js': 'export {}', 'page.html': '<script>alert(document.cookie)</script>', 'art.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'view.css': 'a{}' };
  const hashOf = (path: string): string => path.replace(/\W/g, '').padEnd(64, '0');
  let site: Awaited<ReturnType<typeof serveRoutes>>;
  beforeAll(async () => {
    const client = { entry: 'index.js', hash: 'build1', files: Object.entries(files).map(([path, text]) => ({ path, size: text.length, hash: hashOf(path) })) };
    const route = new ClientBuildRoute({
      lifecycle: () => ({ approvedClient: (system: SystemName) => Promise.resolve(system === fs ? client : undefined) }),
      content: {
        open: (hash) => {
          const found = Object.entries(files).find(([path]) => hashOf(path) === hash);
          return Promise.resolve(found === undefined ? undefined : { stream: new Blob([found[1]]).stream(), size: found[1].length, mime: 'application/octet-stream' });
        },
      },
    });
    site = await serveRoutes([route]);
  });
  afterAll(async () => { await site.close(); });

  it('sends its .html and .svg as downloads, never as pages on the hub', async () => {
    for (const path of ['page.html', 'art.svg']) {
      const res = await fetch(`${site.url}/clients/fs/build1/${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('attachment');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('serves its scripts and styles as they are, for the app to load', async () => {
    for (const path of ['index.js', 'view.css']) {
      const res = await fetch(`${site.url}/clients/fs/build1/${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBeNull();
    }
  });
});
