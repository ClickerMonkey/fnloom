/**
 * `harness system available`: the premade systems this copy of the harness carries (`systems/` beside the CLI), each
 * with what it is, whether `harness start` runs it, and the command that installs it. Read from their `system.json`,
 * with no hub involved.
 */
import { join, sep } from 'node:path';
import { z } from 'zod';
import { command, type CliIo } from '../command.ts';
import { BUNDLED_SYSTEMS_DIR, CLI_NAME, NOT_INSTALLABLE } from '../local.ts';

/** When `harness start` runs a premade system (by folder name); the others are installed on demand. */
export const STARTED_BY_DEFAULT: Readonly<Record<string, string>> = {
  fs: 'always', input: 'always', widgets: 'always', code: 'always',
  web: 'when TAVILY_API_KEY is set', 'google-calendar': 'when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set', embedder: 'when HARNESS_EMBEDDER_URL is set',
};

const SystemJson = z.object({ name: z.string(), description: z.string().default(''), instances: z.enum(['one', 'many']).default('one') });

/** A premade system: its folder name and what its `system.json` says. */
export interface BundledSystem {
  readonly folder: string;
  readonly dir: string;
  readonly name: string;
  readonly description: string;
  readonly instances: 'one' | 'many';
}

/** The premade systems in `dir` (every folder with a `system.json`, but the template), by folder name. */
export async function bundledSystems(io: Pick<CliIo, 'files'>, dir: string = BUNDLED_SYSTEMS_DIR): Promise<BundledSystem[]> {
  const manifests = (await io.files.walk(dir, ['node_modules', 'dist', 'client', 'server', 'shared', 'context']))
    .filter((path) => path.slice(dir.length + 1).split(sep).length === 2 && path.endsWith(`${sep}system.json`));
  const found: BundledSystem[] = [];
  for (const path of manifests) {
    const folder = path.slice(dir.length + 1).split(sep)[0] ?? '';
    if (NOT_INSTALLABLE.has(folder)) { continue; }
    const parsed = SystemJson.safeParse(JSON.parse(await io.files.readText(path)));
    if (parsed.success) { found.push({ folder, dir: join(dir, folder), ...parsed.data }); }
  }
  return found.sort((a, b) => a.folder.localeCompare(b.folder));
}

/** The premade system a bare name means (`database`), if this copy of the harness carries one by that folder name. */
export async function bundledSystem(io: Pick<CliIo, 'files'>, name: string, dir: string = BUNDLED_SYSTEMS_DIR): Promise<string | undefined> {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || NOT_INSTALLABLE.has(name)) { return undefined; }
  const folder = join(dir, name);
  return (await io.files.stat(join(folder, 'system.json')))?.kind === 'file' ? folder : undefined;
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
      const started = STARTED_BY_DEFAULT[system.folder];
      const how = started === undefined ? `${CLI_NAME} system install ${system.folder}` : `started by ${CLI_NAME} start ${started}`;
      io.out.line(`${system.folder.padEnd(width)}  ${system.description}${system.instances === 'many' ? ' (one instance per target)' : ''}`);
      io.out.line(`${''.padEnd(width)}  ${how}`);
    }
    return 0;
  },
});
