/**
 * A built system is one self-contained JS file (`harness system build` inlines every JS dependency), so it runs
 * without installing others and can be scanned as one artifact. The only packages a system may leave out of its
 * bundle (`system.json` `server.external`) are native addons, which the installer builds on the machine: each must
 * ship a `binding.gyp`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

describe('system bundles', () => {
  it('leave out native addons only', () => {
    const found = manifests();
    expect(found.length).toBeGreaterThan(0);
    for (const { name, dir, manifest } of found) {
      const require = createRequire(join(dir, 'package.json'));
      for (const external of Object.keys(manifest.server.external)) {
        const root = dirname(require.resolve(`${external}/package.json`));
        expect(existsSync(join(root, 'binding.gyp')), `${name} leaves ${external} out of its bundle, but it is no native addon`).toBe(true);
      }
    }
  });
});
