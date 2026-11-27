/**
 * The harness on this machine, as `harness start` runs it: where its data folder is, the admin account it made (kept
 * in `<data>/admin.json`, readable by its owner only, so `harness system install` and the other hub commands sign in
 * without being told how), the premade systems this copy of the harness carries (`systems/` beside the CLI, in the
 * repository and in the published package alike), and the script that starts the stack (`scripts/start.ts`).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** The repository (or the installed package): this file is at `packages/cli/src/local.ts` in both. */
export const HARNESS_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The command people type: the root `package.json`'s bin in the published package (`release.bin`, `fnloom`), else
 * `harness` (the repository's workspace bin).
 */
export const CLI_NAME: string = (() => {
  try {
    const parsed = z.object({ bin: z.record(z.string(), z.string()).optional() }).safeParse(JSON.parse(readFileSync(join(HARNESS_ROOT, 'package.json'), 'utf8')));
    return (parsed.success ? Object.keys(parsed.data.bin ?? {})[0] : undefined) ?? 'harness';
  } catch {
    return 'harness';
  }
})();

/** The premade systems this copy of the harness carries. */
export const BUNDLED_SYSTEMS_DIR = join(HARNESS_ROOT, 'systems');

/**
 * The heavy premade systems as package zips (`premade/<name>.zip`), in the published package only: `harness system
 * install <name>` installs one and the hub fetches the npm packages it left out into its own folder (`premade.ts`).
 */
export const PREMADE_DIR = join(HARNESS_ROOT, 'premade');

/** Folders in `systems/` that are not systems to install: the template `harness system new` copies. */
export const NOT_INSTALLABLE = new Set(['template']);

/** The script `harness start` runs. */
export const START_SCRIPT = join(HARNESS_ROOT, 'scripts', 'start.ts');

/** Where `harness start` keeps the admin account it made, inside the data folder. */
export const ADMIN_FILE = 'admin.json';

/** The admin account `harness start` made: the hub it is for (`http://127.0.0.1:<port>`) and its sign-in. */
export const AdminFile = z.object({ url: z.string(), email: z.email(), password: z.string().min(8) });
export type AdminFile = z.infer<typeof AdminFile>;

/** The data folder: the option, else `HARNESS_DATA`, else `~/.harness`. */
export function dataFolder(cwd: string, option: string | undefined, environment: Readonly<Record<string, string | undefined>>): string {
  const given = option ?? environment['HARNESS_DATA'];
  return given === undefined || given === '' ? join(homedir(), '.harness') : resolve(cwd, given);
}

/** The admin account saved in a data folder, if there is one and it reads. */
export function readAdminFile(data: string): AdminFile | undefined {
  try {
    const parsed = AdminFile.safeParse(JSON.parse(readFileSync(join(data, ADMIN_FILE), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Whether two hub addresses are the same hub on this machine (`localhost` and `127.0.0.1` alike, the same port). */
export function sameLocalHub(a: string, b: string): boolean {
  const key = (url: string): string | undefined => {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname === 'localhost' || parsed.hostname === '[::1]' ? '127.0.0.1' : parsed.hostname;
      return host === '127.0.0.1' ? `${host}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}` : undefined;
    } catch {
      return undefined;
    }
  };
  const left = key(a);
  return left !== undefined && left === key(b);
}

/** How `harness start` was asked to run. */
export interface StartOptions {
  readonly cwd: string;
  readonly port?: string | undefined;
  readonly data?: string | undefined;
  readonly root?: string | undefined;
  readonly systems?: string | undefined;
  readonly out: { line(text: string): void; warn(text: string): void };
}

/** What `scripts/start.ts` exports. */
export interface StartScript {
  startHarness(options: StartOptions): Promise<number>;
}

/** Whether a loaded module is the start script (it is loaded by path, so nothing types it). */
export function isStartScript(module: unknown): module is StartScript {
  return typeof module === 'object' && module !== null && 'startHarness' in module && typeof module.startHarness === 'function';
}
