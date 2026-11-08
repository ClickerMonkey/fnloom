/**
 * `harness system pack [dir] [--out <file>]`: build when `dist/` is stale, hash every built file into `system.json`'s
 * `files`, and zip `dist/` to `<name>-<version>.zip` (deterministic: the same build packs to the same bytes).
 */
import { join, relative, resolve } from 'node:path';
import { PACKAGE_MANIFEST_FILE, packageFileName } from '@harness/core';
import { sealPackage, zip, type ZipEntry } from '@harness/hub/package';
import { z } from 'zod';
import { command } from '../command.ts';
import { DIST, isStale, readSystemJson } from '../folder.ts';
import { buildSystem } from './build.ts';

export const packCommand = command({
  path: ['system', 'pack'],
  summary: 'Build if needed, then zip dist/ with every file hashed into a package the hub installs.',
  usage: '[dir] [--out <file>] [--skip-typecheck]',
  args: z.object({
    positionals: z.array(z.string()).max(1),
    values: z.object({ out: z.string().optional(), 'skip-typecheck': z.boolean().default(false) }),
  }),
  async run({ positionals, values }, io) {
    const dir = resolve(io.cwd, positionals[0] ?? '.');
    if (await isStale(io.files, dir) && await buildSystem(dir, io, { typecheck: !values['skip-typecheck'] }) === undefined) { return 1; }
    const dist = join(dir, DIST);
    const manifest = await readSystemJson(io.files, dist);
    const files: ZipEntry[] = [];
    for (const path of await io.files.walk(dist)) {
      const inside = relative(dist, path).split(/[\\/]/).join('/');
      if (inside !== PACKAGE_MANIFEST_FILE) { files.push({ path: inside, bytes: await io.files.read(path) }); }
    }
    const bytes = zip(sealPackage(manifest, files));
    const out = values.out === undefined ? join(dir, packageFileName(manifest.name, manifest.version)) : resolve(io.cwd, values.out);
    await io.files.write(out, bytes);
    io.out.line(`packed ${manifest.name} ${manifest.version}: ${files.length} files, ${bytes.length} bytes, ${relative(io.cwd, out) || out}`);
    return 0;
  },
});
