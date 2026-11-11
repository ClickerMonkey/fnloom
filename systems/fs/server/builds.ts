/**
 * `SystemBuilds` over `@harness/build`: `buildSystem` typechecks the folder with its own `tsconfig.json`, checks the
 * contract's name and the context folder, bundles one self-contained server file into `dist/`, builds the client and
 * scans the bundle; this copies `dist/` into the version folder, hashes the bundle, works out the contract's manifest
 * (`SystemBuilder.manifests`: the contract runs only in a sandboxed child process, never in fs) and words the card's
 * lines from it. The source hash covers every source
 * file (not `dist/`, `node_modules` and the like), so a change after approval is caught.
 */
import { cp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { BUILT, CONTRACT_ENTRY, ContractError, FolderError, NOT_SOURCE, buildSystem, type BuildFiles, type ScanReport, type SystemBuilder } from '@harness/build';
import type { Manifest } from '@harness/core';
import { contractHash } from '@harness/sdk';
import { contentHash, contentHasher, readClientBundle } from '@harness/sdk/server';
import type { BuiltSystem, SystemBuilds } from './hosting.ts';
import { InstallRefused } from './hosting.ts';

/** What the adapter is built from. */
export interface HarnessBuildsDeps {
  readonly builder: SystemBuilder;
  readonly files: BuildFiles;
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

/** The scan report, a line each. */
function scanLines(scan: ScanReport): string[] {
  const kb = Math.max(1, Math.round(scan.size / 1024));
  return [
    scan.builtins.length === 0 ? 'Imports no Node built-ins.' : `Node built-ins: ${scan.builtins.join(', ')}.`,
    scan.concerns.length === 0 ? 'No dynamic imports or requires, eval or new Function.' : `${String(scan.concerns.length)} lines of concern (below).`,
    scan.hosts.length === 0 ? 'Names no web hosts.' : `Web hosts it names: ${scan.hosts.join(', ')}.`,
    `Bundle: ${String(kb)} KB.`,
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
    const hasher = contentHasher();
    for (const path of files) {
      hasher.update(new TextEncoder().encode(`${path}\n`)).update(new TextEncoder().encode(`${contentHash(await this.#deps.files.read(join(dir, path)))}\n`));
    }
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
    const manifest = await this.#manifest(join(dir, CONTRACT_ENTRY), result.manifest.name, result.manifest.version, hasClient ? client : '');
    return {
      built: {
        manifest: result.manifest,
        manifestHash: await contractHash(manifest),
        bundleHash,
        entry,
        fns: manifest.fns.map((decl) => fnLine(manifest.name, decl)),
        adds: addsOf(manifest),
        scan: scanLines(result.scan),
        concerns: result.scan.concerns.map((concern) => ({ file: BUILT.server, line: concern.line, code: `${concern.code}  // ${concern.detail}` })),
      },
    };
  }

  /** The contract's manifest with the built client, read in the builder's sandboxed child process. */
  async #manifest(module: string, name: string, version: string, client: string): Promise<Manifest> {
    const assets = client === '' ? undefined : (await readClientBundle(client)).assets;
    let manifests: Manifest[];
    try {
      manifests = await this.#deps.builder.manifests(module, { version, client: assets });
    } catch (error) {
      if (error instanceof ContractError) { throw new InstallRefused(error.message); }
      throw error;
    }
    const manifest = manifests.find((found) => found.name === name);
    if (manifest === undefined) { throw new InstallRefused(`${CONTRACT_ENTRY} exports no contract named ${name}.`); }
    return manifest;
  }
}
