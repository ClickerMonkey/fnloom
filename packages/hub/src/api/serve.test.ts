import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemName, type Manifest } from '@harness/core';
import { clientUrl } from './web/chat.ts';
import { clientItemName } from '../link/lifecycle.ts';
import { ClientBuildRoute, WebAppRoute, type FileRoute } from './serve.ts';
import { testManifest } from './testing/rig.ts';

/** Serve some routes on a free local port; 404 when none answers. */
async function serveRoutes(routes: readonly FileRoute[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      for (const route of routes) { if (await route.serve(req, res, path)) { return; } }
      res.writeHead(404).end('none');
    })();
  });
  await new Promise<void>((resolve) => { server.listen(0, '0.0.0.0', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => { server.close(() => { resolve(); }); }) };
}

describe('WebAppRoute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-web-'));
  let site: Awaited<ReturnType<typeof serveRoutes>>;
  /** The display name the route reads on every request. */
  let hubName = 'Acme <Ops>';
  beforeAll(async () => {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Harness</title><meta name="apple-mobile-web-app-title" content="Harness">');
    writeFileSync(join(dir, 'assets', 'app-1a2b.js'), 'console.log(1)');
    writeFileSync(join(tmpdir(), 'harness-outside.txt'), 'secret');
    site = await serveRoutes([new WebAppRoute(dir, { identity: () => Promise.resolve({ name: hubName, source: 'setting' as const, version: '1.0.0' }) })]);
  });
  afterAll(async () => {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves files with their type, caching hashed assets for good', async () => {
    const res = await fetch(`${site.url}/assets/app-1a2b.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(await res.text()).toBe('console.log(1)');
  });

  it('answers app routes with index.html, checked again each time', async () => {
    for (const path of ['/', '/sessions/ses_1', '/admin/systems?tab=pairing']) {
      const res = await fetch(`${site.url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('<title>Acme &lt;Ops&gt;</title>');
    }
  });

  it('names the page and the install manifest after the hub, read on every request', async () => {
    hubName = 'Family Desk';
    const page = await (await fetch(`${site.url}/`)).text();
    expect(page).toContain('<title>Family Desk</title>');
    expect(page).toContain('name="apple-mobile-web-app-title" content="Family Desk"');
    expect(page).not.toContain('Harness');
    const manifest = await fetch(`${site.url}/manifest.webmanifest`);
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');
    expect(await manifest.json()).toMatchObject({ name: 'Family Desk', short_name: 'Family Desk', start_url: '/' });
    hubName = 'Acme <Ops>';
  });

  it('leaves missing files and paths outside the folder alone', async () => {
    expect((await fetch(`${site.url}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${site.url}/..%2f..%2fharness-outside.txt`)).status).toBe(404);
    expect((await fetch(`${site.url}/%E0%A4%A`)).status).toBe(200);
  });

  it('only serves reads', async () => {
    expect((await fetch(`${site.url}/`, { method: 'POST' })).status).toBe(404);
    const head = await fetch(`${site.url}/assets/app-1a2b.js`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('14');
  });
});

describe('ClientBuildRoute', () => {
  const fs = SystemName.parse('fs');
  const fileHash = 'b'.repeat(64);
  const manifest = { client: { entry: 'index.js', hash: 'build1', files: [{ path: 'chunks/view.js', size: 6, hash: fileHash }] } };
  let site: Awaited<ReturnType<typeof serveRoutes>>;
  /** The components switched off or waiting for review. */
  const held = new Set<string>();
  beforeAll(async () => {
    const route = new ClientBuildRoute({
      lifecycle: () => ({ off: () => Promise.resolve(held) }),
      catalog: { manifest: (system) => Promise.resolve(system === fs ? parseManifest(manifest) : undefined) },
      content: {
        open: (hash) => Promise.resolve(hash === fileHash
          ? { stream: new Blob(['view()']).stream(), size: 6, mime: 'application/octet-stream' }
          : undefined),
      },
    });
    site = await serveRoutes([route]);
  });
  afterAll(async () => { await site.close(); });

  it('serves a file of the current build by its path, cached for good', async () => {
    const res = await fetch(`${site.url}${clientUrl(fs, 'build1', 'chunks/view.js')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('etag')).toBe(`"${fileHash}"`);
    expect(await res.text()).toBe('view()');
  });

  it('serves nothing while the build is switched off or waits for review', async () => {
    held.add(clientItemName(fs));
    try { expect((await fetch(`${site.url}${clientUrl(fs, 'build1', 'chunks/view.js')}`)).status).toBe(404); } finally { held.clear(); }
  });

  it('says not modified when the browser has it', async () => {
    const res = await fetch(`${site.url}${clientUrl(fs, 'build1', 'chunks/view.js')}`, { headers: { 'if-none-match': `"${fileHash}"` } });
    expect(res.status).toBe(304);
  });

  it('refuses another build, an unknown file or system, and bad paths, without falling through to the app', async () => {
    expect((await fetch(`${site.url}/clients/fs/old/chunks/view.js`)).status).toBe(404);
    expect((await fetch(`${site.url}/clients/fs/build1/nope.js`)).status).toBe(404);
    expect((await fetch(`${site.url}/clients/other/build1/chunks/view.js`)).status).toBe(404);
    expect((await fetch(`${site.url}/clients/Bad!/x/y`)).status).toBe(404);
    expect((await fetch(`${site.url}/clients/fs/build1/%E0%A4%A`)).status).toBe(404);
    expect((await fetch(`${site.url}/clients/fs`)).status).toBe(404);
  });
});

/** Only the client part of a manifest matters to the route; the rest is filled with empty sections. */
function parseManifest(part: { client: NonNullable<Manifest['client']> }): Manifest {
  return testManifest(SystemName.parse('fs'), part);
}
