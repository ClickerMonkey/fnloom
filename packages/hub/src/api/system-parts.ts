/**
 * `systemParts`: what one system added beyond its fns, context and types, read from the manifest the catalog accepted
 * (its contract, with `runtime` naming what the running system added) and, for its fns' examples, one bounded page of
 * the `fnExamples` table. Each part's version is the hash of its declaration, the way fn, type and context versions are.
 */
import { canonicalJson, sha256 } from '@harness/sdk';
import {
  Json, qualify, runtimeNames, SYSTEM_PART_EXAMPLES,
  type DeclaredBy, type Manifest, type ManifestSection, type SystemName, type SystemPart, type SystemPartSection, type SystemParts,
} from '@harness/core';
import type { HubServices } from '../boot/index.ts';

/** The manifest sections listed as they are, each under its part section. */
const LISTED = [['kinds', 'kinds'], ['mentions', 'mentions'], ['hooks', 'hooks'], ['actions', 'actions'], ['settings', 'settings'], ['attachments', 'attachments'], ['embedders', 'embedders'], ['sectioners', 'sectioners']] as const satisfies ReadonlyArray<readonly [ManifestSection & SystemPartSection, SystemPartSection]>;

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

/** Everything a system added beyond its fns, context and types; empty for a system the catalog has no manifest of. */
export async function systemParts(hub: Pick<HubServices, 'catalog' | 'store'>, system: SystemName): Promise<SystemParts> {
  const manifest = await hub.catalog.manifest(system);
  if (manifest === undefined) { return { parts: [], more: {} }; }
  const parts: SystemPart[] = [];
  for (const [from, section] of LISTED) {
    const origin = originIn(manifest, from);
    for (const decl of manifest[from]) {
      parts.push(await part(section, qualify(system, decl.name), 'description' in decl ? decl.description : `${String(decl.dimensions)} dimensions`, origin(decl.name), decl));
    }
  }
  const contextOrigin = originIn(manifest, 'context');
  for (const decl of manifest.context) {
    if (decl.command === undefined) { continue; }
    parts.push(await part('commands', `/${decl.command.name}`, decl.description, contextOrigin(decl.name), decl.command, { visibility: decl.suggest, owner: qualify(system, decl.name) }));
  }
  // the manifest's lists are replaced whole while running and say nothing of where each entry came from: the contract's
  for (const decl of manifest.providers ?? []) { parts.push(await part('providers', qualify(system, decl.name), decl.description, 'contract', decl)); }
  for (const decl of manifest.registries ?? []) { parts.push(await part('registries', qualify(system, decl.name), decl.description, 'contract', decl)); }
  for (const decl of manifest.contributes ?? []) { parts.push(await part('components', `${decl.registry}: ${decl.label}`, decl.description ?? decl.label, 'contract', decl)); }
  const examples = hub.store.table('fnExamples');
  const page = await examples.find({ where: { system, source: { in: ['decl', 'runtime'] } }, order: [['fn', 'asc'], ['order', 'asc']], limit: SYSTEM_PART_EXAMPLES });
  for (const example of page.items) {
    const name = example.source === 'runtime' && example.key !== undefined ? `${example.fn} (${example.key})` : `${example.fn} #${String(example.order + 1)}`;
    const { id: _id, createdAt: _createdAt, ...decl } = example;
    parts.push(await part('examples', name, example.text.split('\n')[0] ?? '', example.source === 'runtime' ? 'runtime' : 'contract', decl, { owner: example.fn }));
  }
  const more = page.cursor === undefined ? {} : { examples: await examples.count({ system, source: { in: ['decl', 'runtime'] } }) };
  return { parts, more };
}
