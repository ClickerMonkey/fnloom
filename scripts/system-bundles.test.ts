/**
 * A built system is one self-contained JS file (`harness system build` inlines every JS dependency), so it runs
 * without installing others and can be scanned as one artifact. The only packages a system may leave out of its
 * bundle (`system.json` `server.external`) are the ones made for the machine: a native addon, which the installer
 * builds there (it ships a `binding.gyp`), or a package whose executables come per platform as optional dependencies
 * (the Claude Agent SDK and the Claude Code binary it runs).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SystemPackageManifest } from '@harness/core';
import { describe, expect, it } from 'vitest';

const systems = join(import.meta.dirname, '..', 'systems');

/** Every system folder with a `system.json`, and its manifest. */
function manifests(): Array<{ name: string; dir: string; manifest: SystemPackageManifest }> {
  return readdirSync(systems, { withFileTypes: true }).flatMap((entry) => {
    const file = join(systems, entry.name, 'system.json');
    if (!entry.isDirectory() || !existsSync(file)) { return []; }
    return [{ name: entry.name, dir: join(systems, entry.name), manifest: SystemPackageManifest.parse(JSON.parse(readFileSync(file, 'utf8'))) }];
  });
}

/** The parts of a package.json this test reads. */
const PackageJson = z.object({ name: z.string().optional(), optionalDependencies: z.record(z.string(), z.string()).optional() });

/** A package's folder, found from its entry (its `package.json` may not be exported). */
function packageRoot(require: NodeJS.Require, name: string): string {
  let dir = dirname(require.resolve(name));
  while (!existsSync(join(dir, 'package.json')) || PackageJson.parse(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).name !== name) {
    const up = dirname(dir);
    if (up === dir) { throw new Error(`no package.json for ${name}`); }
    dir = up;
  }
  return dir;
}

/** Whether a package is made for the machine: a native addon, or one with per-platform executables. */
function machineMade(root: string, name: string): boolean {
  if (existsSync(join(root, 'binding.gyp'))) { return true; }
  const optional = Object.keys(PackageJson.parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).optionalDependencies ?? {});
  return optional.some((dependency) => dependency.startsWith(`${name}-${process.platform}`));
}

describe('system bundles', () => {
  it('leave out only what is made for the machine', () => {
    const found = manifests();
    expect(found.length).toBeGreaterThan(0);
    for (const { name, dir, manifest } of found) {
      const require = createRequire(join(dir, 'package.json'));
      for (const external of Object.keys(manifest.server.external)) {
        expect(machineMade(packageRoot(require, external), external), `${name} leaves ${external} out of its bundle, but it is not made for the machine`).toBe(true);
      }
    }
  });
});
