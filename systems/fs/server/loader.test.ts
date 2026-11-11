import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packageClosure, tsxLoader } from './loader.ts';

let dir: string;

/** A package under `node_modules` with the dependencies given. */
async function pkg(name: string, deps: Record<string, string> = {}, optional: Record<string, string> = {}): Promise<void> {
  const folder = join(dir, 'node_modules', name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies: deps, optionalDependencies: optional }));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fs-loader-'));
  await pkg('loader', { helper: '1' }, { 'only-on-mac': '1' });
  await pkg('helper', { loader: '1' });
});

afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the hosted loader', () => {
  it('finds a package and what it needs at run time, once each, skipping optional ones that are not there', () => {
    const from = pathToFileURL(join(dir, 'main.js')).href;
    expect(packageClosure('loader', from)).toEqual([join(dir, 'node_modules', 'loader'), join(dir, 'node_modules', 'helper')]);
    expect(packageClosure('missing', from)).toEqual([]);
  });

  it('imports tsx by absolute URL and reads its packages', () => {
    const loader = tsxLoader(import.meta.url);
    expect(loader.nodeArgs[0]).toBe('--import');
    expect(loader.nodeArgs[1]).toMatch(/^file:\/\/.*tsx/);
    expect(loader.reads.some((folder) => folder.endsWith('tsx'))).toBe(true);
    expect(loader.reads.some((folder) => folder.endsWith('esbuild'))).toBe(true);
  });
});
