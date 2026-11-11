/**
 * Building a system folder, as `harness system build` and fs's `install_system` do: typecheck it, check its
 * contract's name equals `system.json`'s, check its context folder, bundle `server/` into one self-contained
 * `dist/server/main.js` (everything inlined but `server.external` and Node's own modules), build `client/` into
 * `dist/client/`, copy `context/` into `dist/context/`, write `dist/system.json` with the built entries, and scan the
 * bundle.
 */
import { join } from 'node:path';
import { PACKAGE_MANIFEST_FILE, type SystemPackageManifest } from '@harness/core';
import { CONTEXT_FOLDER, formatContextProblem, packageManifestText } from '@harness/sdk/server';
import { hub } from '@harness/sdk';
import { summaryOf, type ContractSummary, type SystemBuilder } from './builder.ts';
import { checkContextFolder } from './context.ts';
import type { BuildFiles } from './files.ts';
import { BUILT, DIST, builtManifest, readSystemJson } from './folder.ts';
import { scanBundle, type ScanReport } from './scan.ts';

/** Where a system's contract is. */
export const CONTRACT_ENTRY = 'shared/index.ts';

/** What a build uses. */
export interface BuildDeps {
  readonly builder: SystemBuilder;
  readonly files: BuildFiles;
}

/** How to build. */
export interface BuildOptions {
  /** Typecheck first (default true). */
  readonly typecheck?: boolean;
  /**
   * Names the context folder may link to beyond the system's own: the hub's catalog when one is reachable. Unset,
   * they are what the system requires that the build can know without a hub (`requiredNames`). Qualified names.
   */
  readonly known?: { readonly fns: readonly string[]; readonly context: readonly string[] };
}

/** A build that worked: the manifest in `dist/`, where `dist/` is, and the bundle's scan. */
export interface Built {
  readonly ok: true;
  readonly manifest: SystemPackageManifest;
  readonly dist: string;
  readonly scan: ScanReport;
}

/** A build that didn't: why, one line per problem (`file:line:col message` where there is a place). */
export interface BuildRefused {
  readonly ok: false;
  /** What failed: the typecheck, the contract's name, or the context folder. */
  readonly stage: 'typecheck' | 'contract' | 'context';
  readonly problems: readonly string[];
}

export type BuildResult = Built | BuildRefused;

/** Build a system folder. Throws `FolderError` when it has no valid `system.json`. */
export async function buildSystem(dir: string, deps: BuildDeps, options: BuildOptions = {}): Promise<BuildResult> {
  const { builder, files } = deps;
  const manifest = await readSystemJson(files, dir);
  if (options.typecheck ?? true) {
    const problems = await builder.typecheck(dir);
    if (problems.length > 0) { return { ok: false, stage: 'typecheck', problems }; }
  }
  const contracts = await builder.contracts(join(dir, CONTRACT_ENTRY));
  const contract = contracts.find((summary) => summary.name === manifest.name);
  if (contract === undefined) {
    const problem = contracts.length === 0
      ? `${CONTRACT_ENTRY} exports no system contract`
      : `${CONTRACT_ENTRY} exports ${contracts.map((c) => `"${c.name}"`).join(', ')}, but system.json names "${manifest.name}"`;
    return { ok: false, stage: 'contract', problems: [problem] };
  }
  const context = join(dir, CONTEXT_FOLDER);
  const hasContext = (await files.stat(context))?.kind === 'folder';
  if (hasContext) {
    const known = options.known ?? await requiredNames(contract);
    const checked = await checkContextFolder(context, {
      system: manifest.name,
      fns: new Set([...contract.fns, ...known.fns]),
      context: new Set([...contract.context, ...known.context]),
    });
    if (checked.problems.length > 0) { return { ok: false, stage: 'context', problems: checked.problems.map(formatContextProblem) }; }
  }
  const dist = join(dir, DIST);
  await files.remove(dist);
  const server = join(dist, BUILT.server);
  await builder.bundleServer({ entry: join(dir, manifest.server.entry), outDir: join(dist, 'server'), fileName: BUILT.server.slice('server/'.length), external: Object.keys(manifest.server.external) });
  if (manifest.client !== undefined) { await builder.buildClient({ entry: join(dir, manifest.client.entry), outDir: join(dist, 'client') }); }
  if (hasContext) { await files.copy(context, join(dist, CONTEXT_FOLDER)); }
  const built = builtManifest(manifest);
  await files.write(join(dist, PACKAGE_MANIFEST_FILE), packageManifestText(built));
  return { ok: true, manifest: built, dist, scan: scanBundle(await files.readText(server)) };
}

/**
 * The other systems' names a contract can link to when no hub catalog is at hand: the fns its own fns depend on, and
 * when it requires the hub, every hub fn and context item (the SDK's `hub` contract).
 */
export async function requiredNames(contract: ContractSummary): Promise<{ fns: readonly string[]; context: readonly string[] }> {
  const ofHub = contract.requires.includes(hub.name) ? await summaryOf(hub) : undefined;
  return { fns: [...contract.references, ...(ofHub?.fns ?? [])], context: ofHub?.context ?? [] };
}
