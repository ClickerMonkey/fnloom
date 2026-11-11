/**
 * `harness system build [dir]`: `@harness/build`'s `buildSystem` (typecheck, the contract's name, the context folder,
 * a self-contained `dist/server/main.js`, `dist/client/`, `dist/context/`, `dist/system.json` and the bundle's scan),
 * printing its problems or what it built.
 */
import { relative, resolve } from 'node:path';
import { buildSystem as build } from '@harness/build';
import type { SystemPackageManifest } from '@harness/core';
import { z } from 'zod';
import { command, type CliIo } from '../command.ts';

/** What the build says about each failed stage before its problems. */
const STAGE_HEADING = { typecheck: "doesn't typecheck:", contract: undefined, context: 'has context problems:' } as const;

/** Build a system folder; its built manifest, or `undefined` once the problems are printed. Shared with `pack`. */
export async function buildSystem(dir: string, io: CliIo, options: { typecheck: boolean }): Promise<SystemPackageManifest | undefined> {
  const label = relative(io.cwd, dir) || '.';
  const result = await build(dir, io, options);
  if (!result.ok) {
    const heading = STAGE_HEADING[result.stage];
    if (heading === undefined) {
      for (const problem of result.problems) { io.out.warn(problem); }
    } else {
      io.out.warn(`${label} ${heading}`);
      for (const problem of result.problems) { io.out.warn(`  ${problem}`); }
    }
    return undefined;
  }
  const concerns = result.scan.concerns.length;
  io.out.line(`built ${result.manifest.name} ${result.manifest.version} into ${relative(io.cwd, result.dist) || result.dist}`
    + ` (${result.scan.size} bytes${concerns === 0 ? '' : `, ${concerns} lines of concern in the scan`})`);
  return result.manifest;
}

export const buildCommand = command({
  path: ['system', 'build'],
  summary: 'Typecheck a system, check its name and context, and bundle its server and client into dist/.',
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
