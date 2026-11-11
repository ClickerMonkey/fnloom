/**
 * Building a system: typechecking it, reading the contracts its `shared/` exports, bundling its server into one
 * self-contained file and building its client renderers. `ViteBuilder` does it with the TypeScript compiler, the
 * process's own TypeScript loading (the CLI and fs run under tsx) and Vite; tests use a fake.
 */
import { execFile } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildClient } from '@harness/sdk/build';
import { isSystemContract, manifestOf } from '@harness/sdk';
import { qualify, type QualifiedName } from '@harness/core';
import { build } from 'vite';

/**
 * Modules that only build things; a server bundle leaves them out, so a system that builds its renderers when run
 * from source (as fs does) packs without its build tools. A packed system runs its built renderers instead.
 */
export const BUILD_ONLY_MODULES = ['vite', '@vitejs/plugin-vue', '@harness/sdk/build', '@harness/build'] as const;

/** What a build needs of a contract a module exports: its name, the fns and context it declares, the systems it requires. */
export interface ContractSummary {
  readonly name: string;
  readonly fns: readonly QualifiedName[];
  readonly context: readonly QualifiedName[];
  readonly requires: readonly string[];
  /** The other systems' fns its fns depend on (they exist, or the contract wouldn't work). */
  readonly references: readonly QualifiedName[];
}

/** What a build needs of a contract: its manifest's names, qualified. */
export async function summaryOf(contract: Parameters<typeof manifestOf>[0]): Promise<ContractSummary> {
  const manifest = await manifestOf(contract, { version: '0.0.0' });
  return {
    name: manifest.name,
    fns: manifest.fns.map((decl) => qualify(manifest.name, decl.name)),
    context: manifest.context.map((decl) => qualify(manifest.name, decl.name)),
    requires: manifest.requires,
    references: [...new Set(manifest.fns.flatMap((decl) => decl.deps))],
  };
}

/** Builds systems. */
export interface SystemBuilder {
  /** Typecheck a system folder; the problems, none when it compiles. */
  typecheck(dir: string): Promise<string[]>;
  /** The contracts a module exports (`system('notes', …)` gives `notes`), summarised. */
  contracts(module: string): Promise<ContractSummary[]>;
  /** Bundle a server entry into one ES module file, leaving `external` packages (and Node's own) out. */
  bundleServer(input: { entry: string; outDir: string; fileName: string; external: readonly string[] }): Promise<void>;
  /** Build client renderers into a folder (`index.js`). */
  buildClient(input: { entry: string; outDir: string }): Promise<void>;
}

const run = promisify(execFile);


/** Whether an import is left out of a server bundle. */
export function isExternal(id: string, external: readonly string[]): boolean {
  const named = [...external, ...BUILD_ONLY_MODULES];
  return id.startsWith('node:') || builtinModules.includes(id) || named.some((name) => id === name || id.startsWith(`${name}/`));
}

/** Builds with tsc, Node and Vite. */
export class ViteBuilder implements SystemBuilder {
  async typecheck(dir: string): Promise<string[]> {
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    try {
      await run(process.execPath, [tsc, '-b', join(dir, 'tsconfig.json')], { cwd: dir, maxBuffer: 16_000_000 });
      return [];
    } catch (error) {
      const stdout: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'stdout') : undefined;
      const text = typeof stdout === 'string' && stdout.trim() !== '' ? stdout : error instanceof Error ? error.message : String(error);
      return text.split(/\r?\n/).filter((line) => line.trim() !== '');
    }
  }

  async contracts(module: string): Promise<ContractSummary[]> {
    const loaded: unknown = await import(pathToFileURL(module).href);
    if (typeof loaded !== 'object' || loaded === null) { return []; }
    const contracts = Object.values(loaded).filter(isSystemContract);
    return Promise.all(contracts.map(summaryOf));
  }

  async bundleServer(input: { entry: string; outDir: string; fileName: string; external: readonly string[] }): Promise<void> {
    await build({
      configFile: false,
      logLevel: 'warn',
      ssr: { noExternal: true, target: 'node' },
      build: {
        ssr: input.entry,
        outDir: input.outDir,
        emptyOutDir: true,
        minify: false,
        target: 'node22',
        rolldownOptions: {
          external: (id) => isExternal(id, input.external),
          output: { format: 'es', entryFileNames: input.fileName, codeSplitting: false },
        },
      },
    });
  }

  async buildClient(input: { entry: string; outDir: string }): Promise<void> {
    await buildClient(input);
  }
}
