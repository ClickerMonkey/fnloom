/**
 * `harness system available`: the premade systems this copy of the harness carries, each with what it is, whether
 * `harness start` runs it, and the command that installs it. They are the folders in `systems/` beside the CLI and, in
 * the published package, the package zips in `premade/` (the heavy systems, which bring their own npm dependencies
 * when installed: see `premade.ts`). Read from their `system.json`, with no hub involved.
 */
import { join, sep } from 'node:path';
import { PACKAGE_MANIFEST_FILE } from '@harness/core';
import { unzip } from '@harness/hub/package';
import { z } from 'zod';
import { command, type CliIo } from '../command.ts';
import { BUNDLED_SYSTEMS_DIR, CLI_NAME, NOT_INSTALLABLE, PREMADE_DIR } from '../local.ts';
import { PREMADE, startedWhen } from '../premade.ts';

const SystemJson = z.object({ name: z.string(), description: z.string().default(''), instances: z.enum(['one', 'many']).default('one') });

/** The largest premade package zip read for its `system.json`. */
const MAX_ZIP = 256 * 1024 * 1024;

/** A premade system: its folder name, where it is (a folder, or a package zip), and what its `system.json` says. */
export interface BundledSystem {
  readonly folder: string;
  /** Its folder, or its package zip (`premade/<name>.zip`) when the folder is not here. */
  readonly dir: string;
  readonly packaged: boolean;
  readonly name: string;
  readonly description: string;
  readonly instances: 'one' | 'many';
}

/** The premade package zip for a name, in `premadeDir`. */
const zipOf = (premadeDir: string, name: string): string => join(premadeDir, `${name}.zip`);

/** What a package zip's `system.json` says, if it reads. */
async function zippedSystemJson(io: Pick<CliIo, 'files'>, path: string): Promise<z.infer<typeof SystemJson> | undefined> {
  try {
    const entry = unzip(await io.files.read(path), MAX_ZIP).find((e) => e.path === PACKAGE_MANIFEST_FILE);
    if (entry === undefined) { return undefined; }
    const parsed = SystemJson.safeParse(JSON.parse(new TextDecoder().decode(entry.bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The premade systems: every folder in `dir` with a `system.json` (but the template), and every package zip in
 * `premadeDir` with no folder of its name, by folder name.
 */
export async function bundledSystems(io: Pick<CliIo, 'files'>, dir: string = BUNDLED_SYSTEMS_DIR, premadeDir: string = PREMADE_DIR): Promise<BundledSystem[]> {
  const manifests = (await io.files.stat(dir))?.kind === 'folder'
    ? (await io.files.walk(dir, ['node_modules', 'dist', 'client', 'server', 'shared', 'context']))
      .filter((path) => path.slice(dir.length + 1).split(sep).length === 2 && path.endsWith(`${sep}system.json`))
    : [];
  const found: BundledSystem[] = [];
  for (const path of manifests) {
    const folder = path.slice(dir.length + 1).split(sep)[0] ?? '';
    if (NOT_INSTALLABLE.has(folder)) { continue; }
    const parsed = SystemJson.safeParse(JSON.parse(await io.files.readText(path)));
    if (parsed.success) { found.push({ folder, dir: join(dir, folder), packaged: false, ...parsed.data }); }
  }
  for (const name of Object.keys(PREMADE)) {
    if (found.some((s) => s.folder === name) || (await io.files.stat(zipOf(premadeDir, name)))?.kind !== 'file') { continue; }
    const read = await zippedSystemJson(io, zipOf(premadeDir, name));
    if (read !== undefined) { found.push({ folder: name, dir: zipOf(premadeDir, name), packaged: true, ...read }); }
  }
  return found.sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * The premade system a bare name means (`database`), if this copy of the harness carries one by that name: its folder
 * when it is here (the repository, and the lightweight systems in the package), else its package zip.
 */
export async function bundledSystem(io: Pick<CliIo, 'files'>, name: string, dir: string = BUNDLED_SYSTEMS_DIR, premadeDir: string = PREMADE_DIR): Promise<string | undefined> {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || NOT_INSTALLABLE.has(name)) { return undefined; }
  const folder = join(dir, name);
  if ((await io.files.stat(join(folder, 'system.json')))?.kind === 'file') { return folder; }
  return PREMADE[name] !== undefined && (await io.files.stat(zipOf(premadeDir, name)))?.kind === 'file' ? zipOf(premadeDir, name) : undefined;
}

/** How a premade system gets onto a hub, in words. */
function howToGet(folder: string): string {
  const started = startedWhen(folder);
  if (started !== undefined) { return `started by ${CLI_NAME} start ${started}`; }
  if (folder === 'mcp') { return 'add MCP servers in the app (Admin > MCP servers): the hub runs one for each'; }
  const premade = PREMADE[folder];
  const along = premade?.with === undefined ? '' : ` (installs ${premade.with.join(', ')} with it)`;
  const own = premade?.package === true ? ', which fetches its own dependencies' : '';
  return `${CLI_NAME} system install ${folder}${own}${along}`;
}

export const availableCommand = command({
  path: ['system', 'available'],
  summary: 'List the premade systems this harness carries, which ones start runs, and how to install the others.',
  usage: '',
  args: z.object({ positionals: z.tuple([]), values: z.object({}) }),
  async run(_args, io) {
    const systems = await bundledSystems(io);
    if (systems.length === 0) { io.out.warn(`no premade systems in ${BUNDLED_SYSTEMS_DIR}`); return 1; }
    const width = Math.max(...systems.map((s) => s.folder.length));
    for (const system of systems) {
      io.out.line(`${system.folder.padEnd(width)}  ${system.description}${system.instances === 'many' ? ' (one instance per target)' : ''}`);
      io.out.line(`${''.padEnd(width)}  ${howToGet(system.folder)}`);
    }
    return 0;
  },
});
