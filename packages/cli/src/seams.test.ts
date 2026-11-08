/**
 * The CLI's real seams, on a temporary folder: the disk (`NodeFiles`), the settings and hub target, a hub reached
 * with a token over an injected fetch, and the builder (typecheck, contract names, the server bundle).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BUILD_ONLY_MODULES, isExternal, ViteBuilder } from './builder.ts';
import { NodeFiles } from './files.ts';
import { cliSettings, connectHub, hubTarget } from './hub.ts';
import { waitFor } from './hub-client.ts';

const root = mkdtempSync(join(tmpdir(), 'harness-cli-seams-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('NodeFiles', () => {
  it('writes into new folders, reads, stats, walks skipping folders, copies and removes', async () => {
    const files = new NodeFiles();
    const dir = join(root, 'files');
    await files.write(join(dir, 'a', 'one.txt'), 'one');
    await files.write(join(dir, 'node_modules', 'x.js'), 'skipped');
    await files.write(join(dir, 'two.bin'), new Uint8Array([1, 2, 3]));
    expect(await files.readText(join(dir, 'a', 'one.txt'))).toBe('one');
    expect([...await files.read(join(dir, 'two.bin'))]).toEqual([1, 2, 3]);
    expect(await files.stat(join(dir, 'a'))).toMatchObject({ kind: 'folder' });
    expect((await files.stat(join(dir, 'two.bin')))?.kind).toBe('file');
    expect(await files.stat(join(dir, 'missing'))).toBeUndefined();
    expect(await files.walk(dir, ['node_modules'])).toEqual([join(dir, 'a', 'one.txt'), join(dir, 'two.bin')].sort());
    await files.copy(join(dir, 'a'), join(root, 'copied'));
    expect(await files.readText(join(root, 'copied', 'one.txt'))).toBe('one');
    await files.remove(dir);
    expect(await files.stat(dir)).toBeUndefined();
  });
});

describe('the hub target', () => {
  it('reads .env under the environment, and lets options win', () => {
    writeFileSync(join(root, '.env'), 'HARNESS_URL=http://from-env-file:4300/\nHARNESS_ADMIN_EMAIL=ada@example.com\nHARNESS_ADMIN_PASSWORD=pw\n');
    const settings = cliSettings(root, { HARNESS_TOKEN: 'from-environment' });
    expect(settings.HARNESS_URL).toBe('http://from-env-file:4300/');
    expect(hubTarget(settings, {})).toEqual({ url: 'http://from-env-file:4300', token: 'from-environment', admin: { email: 'ada@example.com', password: 'pw' } });
    expect(hubTarget(settings, { hub: 'http://other:1/', token: 't' })).toMatchObject({ url: 'http://other:1', token: 't' });
  });

  it('refuses to sign in with neither a token nor an admin account', async () => {
    await expect(connectHub({ url: 'http://hub' })).rejects.toThrow(/--token/);
  });
});

describe('a hub reached with a token', () => {
  /** A hub answering the upload calls and serving one download, recording each request. */
  function fakeHub() {
    const seen: Array<{ method: string; url: string; authorization: string | null }> = [];
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const fetcher: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push({ method: request.method, url: request.url, authorization: request.headers.get('authorization') });
      const { pathname } = new URL(request.url);
      if (pathname === '/api/upload') { return json({ url: '/content/up_1', upload: 'up_1' }); }
      if (pathname === '/api/uploaded') { return json({ hash: 'a'.repeat(64), size: 3, mime: 'application/zip' }); }
      if (pathname === '/content/up_1') { return new Response(null, { status: request.method === 'PUT' ? 200 : 404 }); }
      if (pathname === '/download/ok') { return new Response(new Uint8Array([7, 8])); }
      return new Response('no', { status: 403 });
    };
    return { seen, fetcher };
  }

  it('uploads with the token, then downloads by address', async () => {
    const { seen, fetcher } = fakeHub();
    const hub = await connectHub({ url: 'http://hub', token: 'tok' }, fetcher);
    expect(await hub.upload(new Uint8Array([1, 2, 3]), 'x.zip', 'application/zip')).toEqual({ hash: 'a'.repeat(64), size: 3, mime: 'application/zip' });
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['POST /api/upload', 'PUT /content/up_1', 'POST /api/uploaded']);
    expect(seen[0]?.authorization).toBe('Bearer tok');
    expect([...await hub.download('/download/ok')]).toEqual([7, 8]);
    await expect(hub.download('/download/nope')).rejects.toThrow('HTTP 403');
    hub.close();
  });

  it('says when the hub refuses an upload’s bytes', async () => {
    const { fetcher } = fakeHub();
    const refusing: typeof fetch = (input, init) => (init?.method === 'PUT' ? Promise.resolve(new Response(null, { status: 413 })) : fetcher(input, init));
    const hub = await connectHub({ url: 'http://hub', token: 'tok' }, refusing);
    await expect(hub.upload(new Uint8Array([1]), 'big.zip', 'application/zip')).rejects.toThrow('refused the upload of big.zip: HTTP 413');
  });
});

describe('waitFor', () => {
  it('polls until a value comes, and times out naming what it waited for and the last failure', async () => {
    let tries = 0;
    expect(await waitFor('three tries', () => { tries += 1; return Promise.resolve(tries >= 3 ? 'done' : undefined); }, { timeout: 1_000, every: 1 })).toBe('done');
    await expect(waitFor('nothing', () => Promise.reject(new Error('still down')), { timeout: 20, every: 5 })).rejects.toThrow(/waiting for nothing: still down/);
  });
});

describe('ViteBuilder', () => {
  const builder = new ViteBuilder();

  it('leaves Node’s modules, the named externals and the build-only tools out of a bundle', () => {
    expect(isExternal('node:fs', [])).toBe(true);
    expect(isExternal('path', [])).toBe(true);
    expect(isExternal('better-sqlite3/lib', ['better-sqlite3'])).toBe(true);
    for (const name of BUILD_ONLY_MODULES) { expect(isExternal(name, [])).toBe(true); }
    expect(isExternal('zod', [])).toBe(false);
  });

  it('reads the names of the contracts a module exports', async () => {
    const module = join(root, 'contracts.mjs');
    writeFileSync(module, "export const notes = { name: 'notes', defs: {}, with() {} };\nexport const other = { name: 'x' };\nexport const n = 1;\n");
    expect(await builder.contractNames(module)).toEqual(['notes']);
  });

  it('bundles a server entry into one file, keeping externals as imports', async () => {
    const dir = join(root, 'bundle');
    const files = new NodeFiles();
    await files.write(join(dir, 'helper.ts'), 'export const twice = (n: number): number => n * 2;\n');
    await files.write(join(dir, 'main.ts'), "import { readFileSync } from 'node:fs';\nimport { twice } from './helper.ts';\nexport const out = [twice(2), typeof readFileSync];\n");
    await builder.bundleServer({ entry: join(dir, 'main.ts'), outDir: join(dir, 'dist'), fileName: 'server.js', external: [] });
    const bundled = readFileSync(join(dir, 'dist', 'server.js'), 'utf8');
    expect(bundled).toContain('node:fs');
    expect(bundled).toContain('n * 2');
  }, 60_000);

  it('typechecks a folder: no problems when it compiles, the compiler’s lines when not', async () => {
    const dir = join(root, 'typed');
    const files = new NodeFiles();
    await files.write(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }, files: ['main.ts'] }));
    await files.write(join(dir, 'main.ts'), 'export const n: number = 1;\n');
    expect(await builder.typecheck(dir)).toEqual([]);
    await files.write(join(dir, 'main.ts'), "export const n: number = 'one';\n");
    const problems = await builder.typecheck(dir);
    expect(problems.join('\n')).toContain('TS2322');
  }, 60_000);
});
