/**
 * Where a system's renderers are. A packed system (`harness system pack`) runs the bundle built beside its server
 * (`dist/client/index.js`, one folder up from `dist/server/main.js`); from source they are built on every start, so a
 * restart after editing them uploads the new bundle. The build tools (`@harness/sdk/build`, Vite) load only then, so a
 * packed system needs none of them installed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where to find or build a system's renderers. */
export interface RendererPlace {
  /** The server entry's own `import.meta.url`. */
  readonly main: string;
  /** Where to build them from source (the system's state or cache folder); emptied first. */
  readonly outDir: string;
  /** The client entry, relative to the server entry (default `../client/index.ts`). */
  readonly entry?: string;
}

/** The folder of the system's built renderers: the packed bundle when there is one, else built from source now. */
export async function rendererFolder(place: RendererPlace): Promise<string> {
  const packed = fileURLToPath(new URL('../client/', place.main));
  if (existsSync(join(packed, 'index.js'))) { return packed; }
  const { buildClient } = await import('@harness/sdk/build');
  await buildClient({ entry: fileURLToPath(new URL(place.entry ?? '../client/index.ts', place.main)), outDir: place.outDir });
  return place.outDir;
}
