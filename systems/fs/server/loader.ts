/**
 * The loader hosted systems run under: the tsx fs itself runs under, imported by absolute URL (so a bundle in a data
 * folder outside this checkout still finds it), and the folders of the packages it loads at run time (tsx, esbuild and
 * esbuild's platform binary), which a hosted system must be allowed to read under Node's permission model.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

/** The fields of a `package.json` that name what it needs at run time. */
const PackageDeps = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

/** The folder of a package and of every package it depends on at run time, found from `from` (missing optional ones skipped). */
export function packageClosure(name: string, from: string): string[] {
  const found = new Map<string, string>();
  const visit = (pkg: string, base: string): void => {
    if (found.has(pkg)) { return; }
    let manifest: string;
    try {
      manifest = createRequire(base).resolve(`${pkg}/package.json`);
    } catch {
      return; // an optional dependency for another platform
    }
    found.set(pkg, dirname(manifest));
    const deps = PackageDeps.parse(JSON.parse(readFileSync(manifest, 'utf8')));
    for (const dep of Object.keys({ ...deps.dependencies, ...deps.optionalDependencies })) { visit(dep, manifest); }
  };
  visit(name, from);
  return [...found.values()];
}

/** How hosted systems are run: the Node flags that load tsx, and the folders it reads. */
export interface HostedLoader {
  readonly nodeArgs: readonly string[];
  readonly reads: readonly string[];
}

/** The tsx loader this process can import (`from` is the importing module's URL, `import.meta.url`). */
export function tsxLoader(from: string): HostedLoader {
  const url = pathToFileURL(createRequire(from).resolve('tsx')).href;
  return { nodeArgs: ['--import', url], reads: packageClosure('tsx', from) };
}
