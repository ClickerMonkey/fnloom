/**
 * The manifest as it is now: the contract's, plus fns added at runtime. Its hash goes in `hello`, so the hub only asks
 * for the manifest when its copy is stale; runtime changes go as patches carrying the new hash.
 */
import { Json, Manifest, ManifestPatch, SystemName, splitName, type ClientAssets, type FnDecl, type QualifiedName } from '@harness/core';
import type { AnyFnDef } from '../fn.ts';
import { canonicalJson, fnDecl, manifestBody, sha256, type ManifestOptions } from '../manifest.ts';
import type { SystemTable } from './table.ts';

/** The systems a runtime fn refers to (its deps and its kind), other than its own. */
function systemsOf(own: string, def: AnyFnDef): string[] {
  const names: QualifiedName[] = [...Object.values(def.deps).map((dep) => dep.name), ...(def.kind === 'native' ? [] : [def.kind.name])];
  return names.map((name) => splitName(name).system).filter((system) => system !== own);
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
    const full = {
      ...body,
      fns: [...body.fns, ...added.map(([local, { def }]) => fnDecl(local, def))],
      requires: [...requires].sort().map((system) => SystemName.parse(system)),
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

  /** A patch that removes one fn. */
  async remove(local: string): Promise<ManifestPatch> {
    return ManifestPatch.parse({ hash: await this.hash(), upsert: {}, remove: { fns: [local] } });
  }
}
