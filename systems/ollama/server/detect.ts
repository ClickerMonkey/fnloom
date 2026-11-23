/**
 * Finding Ollama on this machine without running anything: `ollama` programs on the PATH and where its installers
 * put them (by looking at files only), the instance's own managed install, and servers that already answer
 * (`/api/version`, read-only). `ollama/detect` gives what it finds; the `binary` mode with no `path` runs the first program.
 */
import { delimiter, join } from 'node:path';
import type { Detected } from '../shared/index.ts';
import { binaryName } from './install.ts';

/** What detection looks at. */
export interface DetectParts {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether a path is a file. */
  readonly isFile: (path: string) => Promise<boolean>;
  /** The version of the server at an address, or undefined when none answers. */
  readonly version: (url: string) => Promise<string | undefined>;
}

/** Where Ollama's own installers put the program, per OS. */
export function knownPlaces(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): string[] {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    const programs = env['ProgramFiles'] ?? 'C:\\Program Files';
    return [...(local === undefined ? [] : [join(local, 'Programs', 'Ollama', 'ollama.exe')]), join(programs, 'Ollama', 'ollama.exe')];
  }
  if (platform === 'darwin') { return ['/Applications/Ollama.app/Contents/Resources/ollama', '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama']; }
  return ['/usr/local/bin/ollama', '/usr/bin/ollama', '/usr/local/lib/ollama/bin/ollama'];
}

/** The `ollama` programs on the PATH, in PATH order. */
export async function onPath(parts: Pick<DetectParts, 'platform' | 'env' | 'isFile'>): Promise<string[]> {
  const path = parts.env['PATH'] ?? parts.env['Path'] ?? '';
  const name = binaryName(parts.platform);
  const dirs = path.split(parts.platform === 'win32' ? ';' : delimiter).filter((dir) => dir.trim() !== '');
  const found = await Promise.all(dirs.map(async (dir) => (await parts.isFile(join(dir, name)) ? join(dir, name) : undefined)));
  return found.filter((p): p is string => p !== undefined);
}

/** Everything detection finds: the managed install first, then the PATH's, then the known places'; and the servers that answer. */
export async function detect(parts: DetectParts, managed: string | undefined, urls: readonly string[]): Promise<Detected> {
  const [path, known, servers] = await Promise.all([
    onPath(parts),
    Promise.all(knownPlaces(parts.platform, parts.env).map(async (place) => (await parts.isFile(place) ? place : undefined))),
    Promise.all([...new Set(urls)].map(async (url) => { const version = await parts.version(url); return version === undefined ? undefined : { url, version }; })),
  ]);
  const seen = new Set<string>();
  const binaries: Detected['binaries'] = [];
  const add = (place: string, source: Detected['binaries'][number]['source']): void => {
    const key = parts.platform === 'win32' ? place.toLowerCase() : place;
    if (seen.has(key)) { return; }
    seen.add(key);
    binaries.push({ path: place, source });
  };
  if (managed !== undefined) { add(managed, 'managed'); }
  for (const place of path) { add(place, 'path'); }
  for (const place of known) { if (place !== undefined) { add(place, 'known'); } }
  return { binaries, servers: servers.filter((s): s is { url: string; version: string } => s !== undefined) };
}
