/**
 * `SystemBuilds` over `@harness/build`: `buildSystem` typechecks the folder with its own `tsconfig.json`, checks the
 * contract's name and the context folder, bundles one self-contained server file into `dist/`, builds the client and
 * scans the bundle, and writes `dist/contract.json` (the contract's manifest and hash, read only in the builder's
 * sandboxed child process, never in fs); this copies `dist/` into the version folder, hashes the bundle, and words the
 * card's lines from the contract. The source hash covers every source
 * file (not `dist/`, `node_modules` and the like), so a change after approval is caught.
 */
import { cp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { BUILT, FolderError, NOT_SOURCE, buildSystem, type BuildFiles, type SystemBuilder } from '@harness/build';
import { mapConcurrent, type Manifest } from '@harness/core';
import { contentHash, contentHasher, readClientBundle } from '@harness/sdk/server';
import type { BuiltSystem, SystemBuilds } from './hosting.ts';
import { InstallRefused } from './hosting.ts';

/** What the adapter is built from. */
export interface HarnessBuildsDeps {
  readonly builder: SystemBuilder;
  readonly files: BuildFiles;
  /** How many source files hashing a folder reads at once (`FS_READ_PARALLEL`); one at a time when unset. */
  readonly readParallel?: number | undefined;
}

/** A fn's line on the card: its name, mode and tags. */
function fnLine(system: string, decl: Manifest['fns'][number]): string {
  const facts = [decl.effects?.mode, ...decl.tags].filter((fact): fact is string => fact !== undefined && fact !== '');
  return `${system}/${decl.name}${facts.length === 0 ? '' : ` (${facts.join(', ')})`}`;
}

/** What else a manifest adds, a line each. */
function addsOf(manifest: Manifest): string[] {
  const named = (what: string, names: readonly string[]) => (names.length === 0 ? [] : [`${what}: ${names.join(', ')}`]);
  return [
    ...named('Kinds', manifest.kinds.map((kind) => kind.name)),
    ...named('Types', manifest.types.map((type) => type.name)),
    ...named('Hooks', manifest.hooks.map((hook) => hook.name)),
    ...named('Mentions', manifest.mentions.map((mention) => mention.name)),
    ...named('Context', manifest.context.map((item) => item.name)),
    ...named('Model providers', (manifest.providers ?? []).map((provider) => provider.name)),
    ...(Object.keys(manifest.config.props ?? {}).length === 0 ? [] : [`Config: ${Object.keys(manifest.config.props ?? {}).join(', ')}`]),
    ...(manifest.client === undefined ? [] : [`Client renderers (${String(manifest.client.files.length)} files)`]),
  ];
}

/** Builds with `@harness/build`. */
export class HarnessBuilds implements SystemBuilds {
  readonly #deps: HarnessBuildsDeps;

  constructor(deps: HarnessBuildsDeps) {
    this.#deps = deps;
  }

  async sourceHash(dir: string): Promise<string> {
    const files = (await this.#deps.files.walk(dir, NOT_SOURCE)).map((path) => relative(dir, path).replaceAll('\\', '/')).sort();
    // the files read (and each hashed) side by side, then folded in path order
    const hashes = await mapConcurrent(files, async (path) => contentHash(await this.#deps.files.read(join(dir, path))), { limit: this.#deps.readParallel ?? 1 });
    const hasher = contentHasher();
    files.forEach((path, index) => {
      hasher.update(new TextEncoder().encode(`${path}\n`)).update(new TextEncoder().encode(`${hashes[index] ?? ''}\n`));
    });
    return hasher.digest();
  }

  async bundleHash(file: string): Promise<string> {
    return contentHash(new Uint8Array(await readFile(file)));
  }

  async build(dir: string, outDir: string): Promise<{ readonly problems: readonly string[] } | { readonly built: BuiltSystem }> {
    let result: Awaited<ReturnType<typeof buildSystem>>;
    try {
      result = await buildSystem(dir, { builder: this.#deps.builder, files: this.#deps.files });
    } catch (error) {
      if (error instanceof FolderError) { throw new InstallRefused(error.message); }
      throw error;
    }
    if (!result.ok) { return { problems: result.problems }; }
    await cp(result.dist, outDir, { recursive: true });
    // the bundle is an ES module, and serve() reads the system's version from the package.json where it runs
    await writeFile(join(outDir, 'package.json'), `${JSON.stringify({ name: result.manifest.name, version: result.manifest.version, private: true, type: 'module' }, null, 2)}\n`, 'utf8');
    const entry = join(outDir, BUILT.server);
    const bundleHash = await this.bundleHash(entry);
    const client = join(outDir, 'client');
    const hasClient = await stat(client).then((found) => found.isDirectory(), () => false);
    // the card lists the built client too; the hash leaves it out, so it stays the one in contract.json
    const manifest: Manifest = hasClient ? { ...result.contract.manifest, client: (await readClientBundle(client)).assets } : result.contract.manifest;
    return {
      built: {
        manifest: result.manifest,
        manifestHash: result.contract.hash,
        contract: { ...manifest, hash: result.contract.hash },
        ...(manifest.grants === undefined ? {} : { grants: manifest.grants }),
        bundleHash,
        entry,
        fns: manifest.fns.map((decl) => fnLine(manifest.name, decl)),
        adds: addsOf(manifest),
        scan: result.scan,
      },
    };
  }
}
