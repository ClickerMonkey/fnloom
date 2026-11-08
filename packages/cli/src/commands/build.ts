/**
 * `harness system build [dir]`: typecheck the system, check its contract's name equals `system.json`'s, bundle
 * `server/` into `dist/server/main.js` (everything inlined but `server.external` and Node's own modules), build
 * `client/` into `dist/client/`, and write `dist/system.json` with the built entries.
 */
import { join, relative, resolve } from 'node:path';
import { PACKAGE_MANIFEST_FILE, type SystemPackageManifest } from '@harness/core';
import { manifestBytes } from '@harness/hub/package';
import { z } from 'zod';
import { command, type CliIo } from '../command.ts';
import { BUILT, DIST, builtManifest, readSystemJson } from '../folder.ts';

/** Where a system's contract is. */
export const CONTRACT_ENTRY = 'shared/index.ts';

/** Build a system folder; true when it built. Shared with `pack`, which builds when `dist/` is stale. */
export async function buildSystem(dir: string, io: CliIo, options: { typecheck: boolean }): Promise<SystemPackageManifest | undefined> {
  const manifest = await readSystemJson(io.files, dir);
  const label = relative(io.cwd, dir) || '.';
  if (options.typecheck) {
    const problems = await io.builder.typecheck(dir);
    if (problems.length > 0) {
      io.out.warn(`${label} doesn't typecheck:`);
      for (const problem of problems) { io.out.warn(`  ${problem}`); }
      return undefined;
    }
  }
  const names = await io.builder.contractNames(join(dir, CONTRACT_ENTRY));
  if (!names.includes(manifest.name)) {
    io.out.warn(names.length === 0
      ? `${CONTRACT_ENTRY} exports no system contract`
      : `${CONTRACT_ENTRY} exports ${names.map((n) => `"${n}"`).join(', ')}, but system.json names "${manifest.name}"`);
    return undefined;
  }
  const dist = join(dir, DIST);
  await io.files.remove(dist);
  await io.builder.bundleServer({
    entry: join(dir, manifest.server.entry), outDir: join(dist, 'server'), fileName: BUILT.server.slice('server/'.length), external: Object.keys(manifest.server.external),
  });
  if (manifest.client !== undefined) { await io.builder.buildClient({ entry: join(dir, manifest.client.entry), outDir: join(dist, 'client') }); }
  const built = builtManifest(manifest);
  await io.files.write(join(dist, PACKAGE_MANIFEST_FILE), manifestBytes(built));
  io.out.line(`built ${manifest.name} ${manifest.version} into ${relative(io.cwd, dist) || dist}`);
  return built;
}

export const buildCommand = command({
  path: ['system', 'build'],
  summary: 'Typecheck a system, check its name, and bundle its server and client into dist/.',
  usage: '[dir] [--skip-typecheck]',
  args: z.object({
    positionals: z.array(z.string()).max(1),
    values: z.object({ 'skip-typecheck': z.boolean().default(false) }),
  }),
  async run({ positionals, values }, io) {
    const built = await buildSystem(resolve(io.cwd, positionals[0] ?? '.'), io, { typecheck: !values['skip-typecheck'] });
    return built === undefined ? 1 : 0;
  },
});
