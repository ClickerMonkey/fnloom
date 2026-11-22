/**
 * Building a system folder, as `harness system build` and fs's `install_system` do: typecheck it, check its
 * contract's name equals `system.json`'s, check its context folder, bundle `server/` into one self-contained
 * `dist/server/main.js` (everything inlined but `server.external` and Node's own modules), build `client/` into
 * `dist/client/`, copy `context/` into `dist/context/`, write `dist/system.json` with the built entries and
 * `dist/contract.json` with the contract's manifest and hash, and scan the bundle. The contract is read once, in the
 * builder's sandboxed child process (no file writes, network or child processes), so no system code runs in the
 * builder, and pairing can bind an approved install to the hash in `contract.json` without running the server.
 */
import { join } from 'node:path';
import { Manifest, PACKAGE_MANIFEST_FILE, type SystemPackageManifest } from '@harness/core';
import { CONTEXT_FOLDER, contextFolderLinks, formatContextProblem, packageManifestText } from '@harness/sdk/server';
import { contractHash, hub } from '@harness/sdk';
import { z } from 'zod';
import { ContractError, summaryOf, summaryOfManifest, type ContractSummary, type SystemBuilder } from './builder.ts';
import { checkContextFolder } from './context.ts';
import type { BuildFiles } from './files.ts';
import { BUILT, DIST, builtManifest, readSystemJson } from './folder.ts';
import { scanBundle, type ScanReport } from './scan.ts';

/** Where a system's contract is. */
export const CONTRACT_ENTRY = 'shared/index.ts';

/** Where a build writes its contract, in `dist/`. */
export const CONTRACT_FILE = 'contract.json';

/**
 * `dist/contract.json`: the contract's manifest as the sandboxed reader gave it (without the built client) and its
 * `contractHash`, the hash an approved install's pairing grant is bound to and the running system's hello must match.
 */
export const BuiltContract = z.object({ manifest: Manifest, hash: z.string().min(1) });
export type BuiltContract = z.infer<typeof BuiltContract>;

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
  readonly known?: KnownToBuild;
  /**
   * The hub's catalog, asked which of the names the context folder links to (beyond the system's own) exist, used
   * when `known` is unset. Its answer is added to what the system requires (`requiredNames`).
   */
  readonly catalog?: CatalogLookup;
}

/** Names a build may link to, qualified. */
export interface KnownToBuild { readonly fns: readonly string[]; readonly context: readonly string[] }

/** A hub catalog a build asks about names (the CLI's, over the web API). */
export interface CatalogLookup {
  /** Which of these qualified names the hub has. */
  existing(names: KnownToBuild): Promise<KnownToBuild>;
}

/** A build that worked: the manifest in `dist/`, its contract, where `dist/` is, and the bundle's scan. */
export interface Built {
  readonly ok: true;
  readonly manifest: SystemPackageManifest;
  /** What `dist/contract.json` holds. */
  readonly contract: BuiltContract;
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
  let manifests: Manifest[];
  try {
    manifests = await builder.manifests(join(dir, CONTRACT_ENTRY), { version: manifest.version });
  } catch (error) {
    if (error instanceof ContractError) { return { ok: false, stage: 'contract', problems: error.message.split(/\r?\n/) }; }
    throw error;
  }
  const read = manifests.find((found) => found.name === manifest.name);
  if (read === undefined) {
    const problem = manifests.length === 0
      ? `${CONTRACT_ENTRY} exports no system contract`
      : `${CONTRACT_ENTRY} exports ${manifests.map((m) => `"${m.name}"`).join(', ')}, but system.json names "${manifest.name}"`;
    return { ok: false, stage: 'contract', problems: [problem] };
  }
  const contract: ContractSummary = summaryOfManifest(read);
  const context = join(dir, CONTEXT_FOLDER);
  const hasContext = (await files.stat(context))?.kind === 'folder';
  if (hasContext) {
    const known = options.known ?? await knownNames(context, contract, options.catalog);
    const checked = await checkContextFolder(context, {
      system: manifest.name,
      fns: new Set([...contract.fns, ...known.fns]),
      context: new Set([...contract.context, ...known.context]),
      agents: await agentNames(contract, known.fns),
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
  const written: BuiltContract = { manifest: read, hash: await contractHash(read) };
  await files.write(join(dist, CONTRACT_FILE), `${JSON.stringify(written, null, 2)}
`);
  return { ok: true, manifest: built, contract: written, dist, scan: scanBundle(await files.readText(server)) };
}

/**
 * The agents an injection in the context folder may name exactly: the system's own and the hub's (both known here to
 * be `hub/llm` fns), and the other systems' fns it may link to, whose kind the build can't see (the hub refuses one
 * that is no agent when the system declares it).
 */
async function agentNames(contract: ContractSummary, known: readonly string[]): Promise<Set<string>> {
  const ofHub = contract.requires.includes(hub.name) ? await summaryOf(hub) : undefined;
  const hubFns = new Set<string>(ofHub?.fns ?? []);
  const own = new Set<string>(contract.fns);
  const elsewhere = known.filter((name) => !hubFns.has(name) && !own.has(name) && !name.startsWith(`${hub.name}/`));
  return new Set([...(contract.agents ?? []), ...(ofHub?.agents ?? []), ...elsewhere]);
}

/** What a context folder may link to: what the system requires, and the names it links to that the catalog has. */
async function knownNames(context: string, contract: ContractSummary, catalog: CatalogLookup | undefined): Promise<KnownToBuild> {
  const required = await requiredNames(contract);
  if (catalog === undefined) { return required; }
  const links = await contextFolderLinks(context);
  const known = { fns: new Set([...contract.fns, ...required.fns]), context: new Set([...contract.context, ...required.context]) };
  const asked = { fns: links.fns.filter((name) => !known.fns.has(name)), context: links.context.filter((name) => !known.context.has(name)) };
  if (asked.fns.length === 0 && asked.context.length === 0) { return required; }
  const found = await catalog.existing(asked);
  return { fns: [...required.fns, ...found.fns], context: [...required.context, ...found.context] };
}

/**
 * The other systems' names a contract can link to when no hub catalog is at hand: the fns its own fns depend on, and
 * when it requires the hub, every hub fn and context item (the SDK's `hub` contract).
 */
export async function requiredNames(contract: ContractSummary): Promise<{ fns: readonly string[]; context: readonly string[] }> {
  const ofHub = contract.requires.includes(hub.name) ? await summaryOf(hub) : undefined;
  return { fns: [...contract.references, ...(ofHub?.fns ?? [])], context: ofHub?.context ?? [] };
}
