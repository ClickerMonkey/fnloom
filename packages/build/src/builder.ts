/**
 * Building a system: typechecking it, reading the contracts its `shared/` exports, bundling its server into one
 * self-contained file and building its client renderers. `ViteBuilder` does it with the TypeScript compiler and Vite;
 * tests use a fake.
 *
 * A contract module is code the system's author (or a model) wrote, so the builder never imports it. It bundles the
 * module with a small reader into one file (bundling runs no code) and runs that in a child process under Node's
 * permission model: it may read only that file and the client list, write nothing, start no processes or workers, and
 * gets the OS basics of the environment and nothing else. A fresh process each time, so an edited contract is never
 * read from the module cache of an earlier one.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildClient } from '@harness/sdk/build';
import { manifestOf } from '@harness/sdk';
import { permissionArgs } from '@harness/sdk/server';
import { Manifest, qualify, type ClientAssets, type QualifiedName } from '@harness/core';
import { build } from 'vite';
import { z } from 'zod';

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
  return summaryOfManifest(await manifestOf(contract, { version: '0.0.0' }));
}

/** What a build needs of a contract's manifest: its names, qualified. */
export function summaryOfManifest(manifest: Manifest): ContractSummary {
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
  /** The contracts a module exports (`system('notes', …)` gives `notes`), summarised; `ContractError` when it can't be read. */
  contracts(module: string): Promise<ContractSummary[]>;
  /** The manifests of the contracts a module exports, at a version and with a built client; `ContractError` when it can't be read. */
  manifests(module: string, options: ManifestsOptions): Promise<Manifest[]>;
  /** Bundle a server entry into one ES module file, leaving `external` packages (and Node's own) out. */
  bundleServer(input: { entry: string; outDir: string; fileName: string; external: readonly string[] }): Promise<void>;
  /** Build client renderers into a folder (`index.js`). */
  buildClient(input: { entry: string; outDir: string }): Promise<void>;
}

/** What `SystemBuilder.manifests` reads a contract module with. */
export interface ManifestsOptions {
  /** The system's version. */
  readonly version: string;
  /** Its built client, when it has one. */
  readonly client?: ClientAssets | undefined;
}

/** Why a contract module couldn't be read: it doesn't bundle, or it threw, timed out or gave no manifests. */
export class ContractError extends Error {}

/** How `ViteBuilder` reads contracts. */
export interface ViteBuilderOptions {
  /** How long reading a contract may take, in ms. */
  readonly probeTimeout: number;
  /** The environment the reader runs with: the OS basics only (`scrubbedEnv`), never the builder's own. */
  readonly probeEnv: Readonly<Record<string, string>>;
}

const run = promisify(execFile);

/** A path as an import specifier. */
function specifier(path: string): string {
  return JSON.stringify(path.replaceAll('\\', '/'));
}

/** The reader bundled with a contract module: it prints the manifest of every contract the module exports. */
function readerSource(module: string, sdk: string): string {
  return [
    "import { readFileSync } from 'node:fs';",
    `import * as loaded from ${specifier(module)};`,
    `import { isSystemContract, manifestOf } from ${specifier(sdk)};`,
    'const [version, clientFile] = process.argv.slice(2);',
    "const client = clientFile === undefined ? undefined : JSON.parse(readFileSync(clientFile, 'utf8'));",
    'const contracts = Object.values(loaded).filter(isSystemContract);',
    'const manifests = await Promise.all(contracts.map((contract) => manifestOf(contract, client === undefined ? { version } : { version, client })));',
    'process.stdout.write(JSON.stringify(manifests));',
    '',
  ].join('\n');
}

/** The SDK a module resolves, else the one this builder uses. */
function sdkFor(module: string): string {
  try {
    return createRequire(module).resolve('@harness/sdk');
  } catch {
    return createRequire(import.meta.url).resolve('@harness/sdk');
  }
}

/** What a failed child said: the end of its stderr, else the error's message. */
function failureOf(error: unknown): string {
  const stderr: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'stderr') : undefined;
  if (typeof stderr === 'string' && stderr.trim() !== '') { return stderr.trim().split(/\r?\n/).slice(-8).join('\n'); }
  return error instanceof Error ? error.message : String(error);
}


/** Whether an import is left out of a server bundle. */
export function isExternal(id: string, external: readonly string[]): boolean {
  const named = [...external, ...BUILD_ONLY_MODULES];
  return id.startsWith('node:') || builtinModules.includes(id) || named.some((name) => id === name || id.startsWith(`${name}/`));
}

/** Builds with tsc, Node and Vite. */
export class ViteBuilder implements SystemBuilder {
  readonly #options: ViteBuilderOptions;

  constructor(options: ViteBuilderOptions) {
    this.#options = options;
  }

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
    return (await this.manifests(module, { version: '0.0.0' })).map(summaryOfManifest);
  }

  async manifests(module: string, options: ManifestsOptions): Promise<Manifest[]> {
    // the SDK the contract is made with (else the builder's own), so the reader's `isSystemContract` knows its contracts
    const sdk = sdkFor(module);
    const dir = await mkdtemp(join(tmpdir(), 'harness-contract-'));
    try {
      const entry = join(dir, 'reader.js');
      const out = join(dir, 'out');
      await writeFile(entry, readerSource(module, sdk), 'utf8');
      try {
        await this.bundleServer({ entry, outDir: out, fileName: 'reader.js', external: [] });
      } catch (error) {
        throw new ContractError(`Its contract doesn't bundle: ${error instanceof Error ? error.message : String(error)}`);
      }
      const client = join(dir, 'client.json');
      if (options.client !== undefined) { await writeFile(client, JSON.stringify(options.client), 'utf8'); }
      const args = [...permissionArgs({ read: [out, client], write: [] }), join(out, 'reader.js'), options.version, ...(options.client === undefined ? [] : [client])];
      let stdout: string;
      try {
        ({ stdout } = await run(process.execPath, args, { cwd: out, timeout: this.#options.probeTimeout, maxBuffer: 32_000_000, env: { ...this.#options.probeEnv } }));
      } catch (error) {
        throw new ContractError(`Its contract couldn't be read: ${failureOf(error)}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {
        throw new ContractError(`Its contract printed something other than its manifests: ${stdout.slice(0, 200)}`);
      }
      const parsed = z.array(Manifest).safeParse(json);
      if (!parsed.success) { throw new ContractError(`Its contract gave no valid manifest: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`); }
      return parsed.data;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
