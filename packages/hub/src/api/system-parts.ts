/**
 * `systemParts`: what one system added beyond its fns, context and types, read from the manifest the catalog accepted
 * (its contract, with `runtime` naming what the running system added). Its embedders are its providers' embedding
 * models (text or images), the ones the index can use, and for its fns' examples, one bounded page of
 * the `fnExamples` table. Each part's version is the hash of its declaration, the way fn, type and context versions are.
 */
import { canonicalJson, sha256 } from '@harness/sdk';
import {
  EMBEDDING_CAPABILITIES, Json, qualify, runtimeNames, SYSTEM_PART_EXAMPLES,
  type DeclaredBy, type ProviderModelDecl, type QualifiedName, type Manifest, type ManifestSection, type SystemName, type SystemPart, type SystemPartSection, type SystemParts,
} from '@harness/core';
import type { HubServices } from '../boot/index.ts';
import { examplePartName } from '../fns/examples.ts';
import { itemKey } from '../link/lifecycle.ts';

/** The manifest sections listed as they are, each under its part section. */
const LISTED = [['kinds', 'kinds'], ['mentions', 'mentions'], ['hooks', 'hooks'], ['actions', 'actions'], ['settings', 'settings'], ['attachments', 'attachments'], ['sectioners', 'sectioners']] as const satisfies ReadonlyArray<readonly [ManifestSection & SystemPartSection, SystemPartSection]>;

/** A system's embedders: each of its providers' models that embeds text or images, named `<system>/<model>` as the index names it. */
function embedderModels(manifest: Manifest): Array<{ name: QualifiedName; model: ProviderModelDecl; provider: string }> {
  return (manifest.providers ?? []).flatMap((provider) => provider.models
    .filter((model) => EMBEDDING_CAPABILITIES.some((capability) => model.capabilities.includes(capability)))
    .map((model) => ({ name: qualify(manifest.name, model.id), model, provider: provider.name })));
}

/** How an embedding model reads in one line: what it embeds and its vectors' size. */
function embedderAbout(model: ProviderModelDecl): string {
  const what = model.capabilities.includes('crossModalEmbedding') ? 'Text and images in one space' : model.capabilities.includes('imageEmbedding') ? (model.capabilities.includes('embedding') ? 'Text and images' : 'Images') : 'Text';
  return `${what}, ${String(model.dimensions)} dimensions`;
}

/** The hash of a declaration, so equal content gives equal versions. */
async function versionOf(decl: unknown): Promise<string> {
  return sha256(canonicalJson(Json.parse(decl)));
}

/** One part, with its version worked out from its declaration. */
async function part(section: SystemPartSection, name: string, about: string, origin: DeclaredBy, decl: unknown, extra: Pick<SystemPart, 'visibility' | 'owner'> = {}): Promise<SystemPart> {
  return { section, name, about, origin, version: await versionOf(decl), decl: Json.parse(decl), ...extra };
}

/** Where a manifest entry came from: added while running when the manifest's `runtime` names it. */
function originIn(manifest: Manifest, section: ManifestSection): (local: string) => DeclaredBy {
  const runtime = runtimeNames(manifest, section);
  return (local) => (runtime.has(local) ? 'runtime' : 'contract');
}

/** The `fnExamples` rows that are a system's parts: the ones its contract declared or it added while running. */
const exampleRows = (system: SystemName) => ({ system, source: { in: ['decl', 'runtime'] as const } });

/**
 * How many parts `systemParts` lists for a system, without its examples' cut: the manifest's sections (one stored row)
 * and its examples counted in the database.
 */
export async function partCount(hub: Pick<HubServices, 'store'>, system: SystemName, manifest: Manifest | undefined): Promise<number> {
  if (manifest === undefined) { return 0; }
  const listed = LISTED.reduce((sum, [from]) => sum + manifest[from].length, 0);
  const commands = manifest.context.filter((decl) => decl.command !== undefined).length;
  const declared = (manifest.providers?.length ?? 0) + (manifest.registries?.length ?? 0) + (manifest.contributes?.length ?? 0);
  return listed + commands + declared + embedderModels(manifest).length + await hub.store.table('fnExamples').count(exampleRows(system));
}

/** Everything a system added beyond its fns, context and types; empty for a system the catalog has no manifest of. */
export async function systemParts(
  hub: Pick<HubServices, 'catalog' | 'store'> & { readonly link: { readonly lifecycle: Pick<HubServices['link']['lifecycle'], 'offItems'> } }, system: SystemName,
): Promise<SystemParts> {
  const manifest = await hub.catalog.manifest(system);
  if (manifest === undefined) { return { parts: [], more: {} }; }
  const parts: SystemPart[] = [];
  for (const [from, section] of LISTED) {
    const origin = originIn(manifest, from);
    for (const decl of manifest[from]) {
      parts.push(await part(section, qualify(system, decl.name), decl.description, origin(decl.name), decl));
    }
  }
  const contextOrigin = originIn(manifest, 'context');
  for (const decl of manifest.context) {
    if (decl.command === undefined) { continue; }
    parts.push(await part('commands', `/${decl.command.name}`, decl.description, contextOrigin(decl.name), decl.command, { visibility: decl.suggest, owner: qualify(system, decl.name) }));
  }
  // the manifest's lists are replaced whole while running and say nothing of where each entry came from: the contract's
  for (const decl of manifest.providers ?? []) { parts.push(await part('providers', qualify(system, decl.name), decl.description, 'contract', decl)); }
  for (const { name, model, provider } of embedderModels(manifest)) { parts.push(await part('embedders', name, embedderAbout(model), 'contract', { provider, ...model })); }
  for (const decl of manifest.registries ?? []) { parts.push(await part('registries', qualify(system, decl.name), decl.description, 'contract', decl)); }
  for (const decl of manifest.contributes ?? []) { parts.push(await part('components', `${decl.registry}: ${decl.label}`, decl.description ?? decl.label, 'contract', decl)); }
  const examples = hub.store.table('fnExamples');
  const page = await examples.find({ where: exampleRows(system), order: [['fn', 'asc'], ['order', 'asc']], limit: SYSTEM_PART_EXAMPLES });
  for (const example of page.items) {
    const name = examplePartName(example);
    const { id: _id, createdAt: _createdAt, ...decl } = example;
    parts.push(await part('examples', name, example.text.split('\n')[0] ?? '', example.source === 'runtime' ? 'runtime' : 'contract', decl, { owner: example.fn }));
  }
  const more = page.cursor === undefined ? {} : { examples: await examples.count(exampleRows(system)) };
  // build 7: each part says whether it is on (switched by `switchPart`, or held while a review waits)
  const off = new Set((await hub.link.lifecycle.offItems(system)).map((item) => itemKey(item)));
  return { parts: parts.map((p) => ({ ...p, on: !off.has(itemKey(p)) })), more };
}
