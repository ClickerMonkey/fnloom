/**
 * The manifest as it is now: the contract's, plus fns and types added at runtime and every runtime patch (`SystemTable.patch`). Its hash goes in `hello`, so the hub only asks
 * for the manifest when its copy is stale; runtime changes go as patches carrying the new hash.
 */
import { Json, Manifest, ManifestPatch, SystemName, splitName, type ClientAssets, type FnDecl, type QualifiedName, type TypeDecl } from '@harness/core';
import type { AnyFnDef } from '../fn.ts';
import { canonicalJson, fnDecl, manifestBody, sha256, type ManifestOptions } from '../manifest.ts';
import type { SystemPatch, SystemTable } from './table.ts';

/** The systems a runtime fn refers to (its deps and its kind), other than its own. */
function systemsOf(own: string, def: AnyFnDef): string[] {
  const names: QualifiedName[] = [...Object.values(def.deps).map((dep) => dep.name), ...(def.kind === 'native' ? [] : [def.kind.name])];
  return names.map((name) => splitName(name).system).filter((system) => system !== own);
}

/** The manifest's `runtime` field: absent when nothing was added while running, so a contract-only hash is unchanged. */
function runtimeOf(entries: NonNullable<Manifest['runtime']>): Pick<Manifest, 'runtime'> {
  return Object.keys(entries).length === 0 ? {} : { runtime: entries };
}

/** Builds the current manifest and the patches that keep the hub's copy current. */
export class ManifestState {
  readonly #table: SystemTable;
  readonly #options: ManifestOptions;
  #client: ClientAssets | undefined;

  constructor(table: SystemTable, options: ManifestOptions) {
    this.#table = table;
    this.#options = options;
    this.#client = options.client;
  }

  /** Set the client assets (once they are uploaded). */
  setClient(client: ClientAssets | undefined): void {
    this.#client = client;
  }

  /** The manifest as it is now, hashed and checked. */
  async current(): Promise<Manifest> {
    const contract = this.#table.contract;
    const body = manifestBody(contract, { ...this.#options, ...(this.#client === undefined ? {} : { client: this.#client }) });
    const added = [...this.#table.added()];
    const requires = new Set<string>(body.requires);
    for (const [, { def }] of added) {
      for (const system of systemsOf(contract.name, def)) { requires.add(system); }
    }
    // runtime types replace a contract type of the same name, which the table refuses, so they only add
    const table = this.#table;
    const fns = table.overlay('fns', [...body.fns, ...added.map(([local, { def }]) => fnDecl(local, def))]);
    for (const decl of fns) {
      if (decl.kind !== 'native' && splitName(decl.kind).system !== contract.name) { requires.add(splitName(decl.kind).system); }
    }
    const lists = table.lists() ?? {};
    const full = {
      ...body,
      ...lists,
      types: table.overlay('types', [...body.types, ...table.addedTypes().values()]),
      settings: table.overlay('settings', body.settings),
      attachments: table.overlay('attachments', body.attachments),
      kinds: table.overlay('kinds', body.kinds),
      fns,
      context: table.overlay('context', body.context),
      hooks: table.overlay('hooks', body.hooks),
      mentions: table.overlay('mentions', body.mentions),
      embedders: table.overlay('embedders', body.embedders),
      sectioners: table.overlay('sectioners', body.sectioners),
      actions: table.overlay('actions', body.actions),
      requires: [...requires].sort().map((system) => SystemName.parse(system)),
      ...runtimeOf(table.runtimeEntries()),
    };
    return Manifest.parse({ ...full, hash: await sha256(canonicalJson(Json.parse(full))) });
  }

  /** The current hash. */
  async hash(): Promise<string> {
    return (await this.current()).hash;
  }

  /** A patch that adds (or replaces) one fn. */
  async upsert(local: string, def: AnyFnDef): Promise<ManifestPatch> {
    const decl: FnDecl = fnDecl(local, def);
    return ManifestPatch.parse({ hash: await this.hash(), upsert: { fns: [decl] }, remove: {} });
  }

  /** A patch that adds or replaces types and removes others, by local name (as the table now holds them). */
  async types(upsert: readonly TypeDecl[], remove: readonly string[]): Promise<ManifestPatch> {
    return ManifestPatch.parse({ hash: await this.hash(), upsert: upsert.length === 0 ? {} : { types: [...upsert] }, remove: remove.length === 0 ? {} : { types: [...remove] } });
  }

  /** The wire patch of a change the table has applied: its entries as sent, and the new hash. */
  async patch(change: SystemPatch): Promise<ManifestPatch> {
    return ManifestPatch.parse({
      hash: await this.hash(),
      upsert: change.upsert ?? {},
      remove: change.remove ?? {},
      ...(change.lists === undefined ? {} : { lists: change.lists }),
      ...(change.roots === undefined ? {} : { roots: change.roots }),
    });
  }

  /** A patch that removes one fn. */
  async remove(local: string): Promise<ManifestPatch> {
    return ManifestPatch.parse({ hash: await this.hash(), upsert: {}, remove: { fns: [local] } });
  }
}
