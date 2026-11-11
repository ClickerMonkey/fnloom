/**
 * The catalog over the hub store. It imports manifests and patches (checking every gin type in the scope of the
 * named types it needs, refusing incompatible changes to things other systems depend on, and asking kinds to
 * describe their fns), keeps the last accepted manifest of every system, and works out what can be used now.
 */
import type { Type } from '@aeye/gin';
import type { Logger } from '@ayepi/log';
import {
  Json, noFnStats, QualifiedName, qualify, splitName,
  type ActorId, type Availability, type ContextDecl, type ContextRecord, type FnDecl, type FnRecord, type GinTypeDef, type ImportReport,
  type KindDecl, type KindRecord, type Manifest, type ManifestPatch, type ManifestSection, type SectionDecl, type SystemName,
  type InstanceName, type TypeDecl, type TypeRecord,
} from '@harness/core';
import { canonicalJson, sha256 } from '@harness/sdk';
import { z } from 'zod';
import type { EventBus } from '../bus.ts';
import { removeLinksFrom, writeDerivedLinks } from '../contextor/graph.ts';
import { contextTokens } from '../contextor/tokens.ts';
import type { HubStore } from '../store/index.ts';
import { AvailabilityRules, sameAvailability, systemAvailability, systemOf, unavailable } from './availability.ts';
import type { Catalog, CatalogEntry, FnSignature, KindDescriber } from './index.ts';
import { allRows } from './rows.ts';
import { GinScopes, messageOf, type TypeLookup } from './scope.ts';
import { Serial } from './serial.ts';

/** What the catalog needs. */
export interface CatalogOptions {
  readonly store: HubStore;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly clock: () => number;
  /** Asks a kind's system to check and describe a fn's payload. */
  readonly describer: KindDescriber;
  readonly scopes?: GinScopes;
}

/** Every manifest section as a list of its declarations. `Manifest` is one of these. */
type SectionLists = { [S in ManifestSection]: Array<SectionDecl<S>> };

/** Build every section's list. Listing the sections here makes a new section a compile error until it is handled. */
function eachSection(make: <S extends ManifestSection>(section: S) => Array<SectionDecl<S>>): SectionLists {
  return {
    types: make('types'), settings: make('settings'), attachments: make('attachments'), kinds: make('kinds'), fns: make('fns'),
    context: make('context'), hooks: make('hooks'), mentions: make('mentions'), embedders: make('embedders'), sectioners: make('sectioners'),
    actions: make('actions'),
  };
}

/** The empty report. */
const emptyReport = (): ImportReport => ({ added: [], updated: [], removed: [], refused: [] });

/** The fleet instance a type belongs to, if one does. */
export const typeOwner = (decl: TypeDecl): InstanceName | undefined => decl.instance;

/** The fleet instance a fn belongs to (one routed to it always), if one does. */
export const fnOwner = (decl: FnDecl): InstanceName | undefined => (decl.routing?.to === 'instance' ? decl.routing.instance : undefined);

/** One owned section of a manifest from `from`: the others' entries kept from before, its own and the shared ones as sent. */
function ownedSection<D extends { name: string }>(before: readonly D[], sent: readonly D[], from: InstanceName, owner: (decl: D) => InstanceName | undefined): D[] {
  const kept = before.filter((decl) => { const own = owner(decl); return own !== undefined && own !== from; });
  const taken = new Set(kept.map((decl) => decl.name));
  const mine = sent.filter((decl) => { const own = owner(decl); return !taken.has(decl.name) && (own === undefined || own === from); });
  return [...mine, ...kept];
}

/**
 * A manifest as an instance of a fleet sent it, joined with what the system's other instances own: their types and fns
 * stay as they were, and anything it says about them (an update, a removal, a claim to own one) is ignored.
 */
export function fromInstance(before: Manifest | undefined, sent: Manifest, from: InstanceName): Manifest {
  return { ...sent, types: ownedSection(before?.types ?? [], sent.types, from, typeOwner), fns: ownedSection(before?.fns ?? [], sent.fns, from, fnOwner) };
}

/** Running numbers for a fn that has never run. */

/** `@system/name` references in context text. */
const MENTION = /@([a-z][a-z0-9-]*\/[A-Za-z_](?:[\w.-]*\w)?)/g;

/** The hash of a JSON value, so equal content gives equal versions. */
async function hashOf(value: unknown): Promise<string> {
  return sha256(canonicalJson(Json.parse(value)));
}

/** Whether two declarations are the same. */
function sameDecl(a: unknown, b: unknown): boolean {
  return canonicalJson(Json.parse(a)) === canonicalJson(Json.parse(b));
}

/** The work of importing one manifest: what was checked, what kinds described, and what is refused. */
interface ImportWork {
  readonly system: SystemName;
  readonly force: boolean;
  /** Type definitions as they will be after this import, for parsing everything else. */
  readonly lookup: TypeLookup;
  readonly kinds: ReadonlyMap<string, KindDecl>;
  /** The decl each accepted fn is stored with (described by its kind). */
  readonly described: Map<string, FnDecl>;
  /** The named types each described fn's payload references, from its kind's description. */
  readonly describedTypes: Map<string, readonly string[]>;
  /** Fn records and type mentions of other systems, read once per import when a change needs them. */
  others?: Promise<{ fns: FnRecord[] }>;
}

/** The catalog, kept in the hub store. */
export class StoreCatalog implements Catalog {
  readonly #scopes: GinScopes;
  readonly #serial = new Serial();
  readonly #types = new Map<string, TypeRecord>();
  readonly #manifests = new Map<string, Manifest>();
  readonly #signatures = new Map<string, { version: string; signature: FnSignature }>();
  /**
   * The named types each kind fn's description said its payload references (`KindDescription.types`), so a change to
   * one re-describes the fn. Kept in memory: after a restart the kind's system re-describes every fn as it connects.
   */
  readonly #describedTypes = new Map<string, readonly string[]>();
  #loaded: Promise<void> | undefined;

  private readonly options: CatalogOptions;

  constructor(options: CatalogOptions) {
    this.options = options;
    this.#scopes = options.scopes ?? new GinScopes();
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  async manifest(system: SystemName): Promise<Manifest | undefined> {
    await this.#load();
    return this.#manifests.get(system);
  }

  async entries<S extends ManifestSection>(section: S, filter: { system?: SystemName } = {}): Promise<Array<CatalogEntry<S>>> {
    await this.#load();
    const out: Array<CatalogEntry<S>> = [];
    for (const manifest of this.#manifests.values()) {
      if (filter.system !== undefined && manifest.name !== filter.system) { continue; }
      const lists: SectionLists = manifest;
      for (const decl of lists[section]) { out.push({ name: qualify(manifest.name, decl.name), system: manifest.name, decl }); }
    }
    return out;
  }

  fn(name: QualifiedName): Promise<FnRecord | undefined> {
    return this.options.store.table('fns').get(name);
  }

  async fns(filter: { system?: SystemName; names?: readonly QualifiedName[]; available?: boolean }): Promise<FnRecord[]> {
    const fns = this.options.store.table('fns');
    const rows = filter.names === undefined
      ? await allRows(fns, filter.system === undefined ? undefined : { system: filter.system })
      : (await Promise.all(filter.names.map((name) => fns.get(name)))).filter((row) => row !== undefined);
    return rows.filter((row) => (filter.system === undefined || row.system === filter.system) && (filter.available === undefined || (row.available === true) === filter.available));
  }

  kind(name: QualifiedName): Promise<KindRecord | undefined> {
    return this.options.store.table('kinds').get(name);
  }

  async type(name: QualifiedName): Promise<TypeRecord | undefined> {
    await this.#load();
    return this.#types.get(name);
  }

  async typesOf(system: SystemName): Promise<TypeRecord[]> {
    await this.#load();
    return [...this.#types.values()].filter((type) => type.system === system);
  }

  async typeClosure(names: readonly QualifiedName[]): Promise<{ order: QualifiedName[]; missing: QualifiedName[] }> {
    await this.#load();
    const closure = this.#scopes.closure(names, this.#storedLookup);
    return { order: closure.order.filter((name) => this.#types.has(name)).map((name) => this.#typeName(name)), missing: closure.missing };
  }

  context(name: QualifiedName): Promise<ContextRecord | undefined> {
    return this.options.store.table('context').get(name);
  }

  async availability(name: QualifiedName): Promise<Availability> {
    const fn = await this.fn(name);
    if (fn !== undefined) { return fn.available; }
    const system = systemOf(name);
    if (system === undefined) { return unavailable('system-disconnected', `${name} names no valid system`); }
    return systemAvailability(system, await this.options.store.table('systems').get(system));
  }

  async signature(name: QualifiedName): Promise<FnSignature> {
    await this.#load();
    const fn = await this.fn(name);
    if (fn === undefined) { throw new Error(`no fn ${name}`); }
    const cached = this.#signatures.get(name);
    if (cached?.version === fn.version) { return cached.signature; }
    const { types: [args, returns], scope } = this.#scopes.parse([fn.decl.args, fn.decl.returns], this.#storedLookup);
    if (args === undefined || returns === undefined) { throw new Error(`${name}: its signature did not parse`); }
    const argsSchema = args.toValueSchema({ scope, includeDocs: 'all', unknownKeys: 'refuse' });
    const signature: FnSignature = {
      fn: name,
      args,
      returns,
      argsSchema,
      returnsSchema: returns.toValueSchema({ scope, includeDocs: 'all' }),
      argsJsonSchema: z.toJSONSchema(argsSchema, { unrepresentable: 'any' }),
    };
    this.#signatures.set(name, { version: fn.version, signature });
    return signature;
  }

  async check(_system: SystemName, type: GinTypeDef, value: unknown): Promise<string[]> {
    await this.#load();
    return this.#checkValue(type, value, this.#storedLookup);
  }

  // ─── Importing ────────────────────────────────────────────────────────────

  importManifest(manifest: Manifest, from?: InstanceName): Promise<ImportReport> {
    return this.#serial.run(async () => {
      if (from === undefined) { return this.#import(manifest, false); }
      await this.#load();
      return this.#import(fromInstance(this.#manifests.get(manifest.name), manifest, from), false);
    });
  }

  importPatch(system: SystemName, patch: ManifestPatch, from?: InstanceName): Promise<ImportReport> {
    return this.#serial.run(async () => {
      await this.#load();
      const previous = this.#manifests.get(system);
      if (previous === undefined) { return { ...emptyReport(), refused: [{ name: system, problems: ['no manifest to patch: send the whole manifest first'] }] }; }
      const upsert: { [S in ManifestSection]?: Array<SectionDecl<S>> | undefined } = patch.upsert;
      const lists: SectionLists = previous;
      const sections = eachSection((section) => {
        const removed = new Set(patch.remove[section] ?? []);
        const replaced = upsert[section] ?? [];
        const replacing = new Set(replaced.map((decl) => decl.name));
        return [...lists[section].filter((decl) => !removed.has(decl.name) && !replacing.has(decl.name)), ...replaced];
      });
      const next: Manifest = { ...previous, ...sections, hash: patch.hash };
      return this.#import(from === undefined ? next : fromInstance(previous, next, from), false);
    });
  }

  forgetInstance(system: SystemName, instance: InstanceName): Promise<ImportReport> {
    return this.#serial.run(async () => {
      await this.#load();
      const previous = this.#manifests.get(system);
      if (previous === undefined) { return emptyReport(); }
      const types = previous.types.filter((decl) => typeOwner(decl) !== instance);
      const fns = previous.fns.filter((decl) => fnOwner(decl) !== instance);
      if (types.length === previous.types.length && fns.length === previous.fns.length) { return emptyReport(); }
      return this.#import({ ...previous, types, fns }, false);
    });
  }

  reimport(system: SystemName): Promise<ImportReport> {
    return this.#serial.run(async () => {
      await this.#load();
      const manifest = this.#manifests.get(system);
      return manifest === undefined ? { ...emptyReport(), refused: [{ name: system, problems: ['no manifest has been imported'] }] } : this.#import(manifest, true);
    });
  }

  declare(system: SystemName, decl: FnDecl, by: ActorId): Promise<ImportReport> {
    return this.#serial.run(async () => {
      await this.#load();
      const name = qualify(system, decl.name);
      const work = this.#work(system, true, this.#storedLookup, await this.#storedKinds());
      const existing = await this.fn(name);
      if (existing?.origin === 'contract') { return { ...emptyReport(), refused: [{ name, problems: ['a fn of the contract has this name'] }] }; }
      const problems = await this.#checkFn(work, decl, existing);
      if (problems.length > 0) { return { ...emptyReport(), refused: [{ name, problems }] }; }
      const stored = work.described.get(decl.name) ?? decl;
      await this.options.store.table('fns').put(await this.#fnRecord(system, stored, existing, 'runtime', by));
      this.#rememberTypes(name, work, decl.name);
      await this.#refresh();
      const record = await this.fn(name);
      this.#announce([name], [], record === undefined ? [] : [record]);
      return { ...emptyReport(), ...(existing === undefined ? { added: [name] } : { updated: [name] }) };
    });
  }

  // ─── Availability ─────────────────────────────────────────────────────────

  async refreshAvailability(system: SystemName): Promise<void> {
    await this.#serial.run(async () => {
      const redescribed = await this.#redescribeKindsOf(system);
      const changed = new Map([...redescribed, ...await this.#refresh()].map((r) => [r.name, r]));
      if (changed.size > 0) { this.options.bus.publish('catalog.changed', { added: [], removed: [], fns: [...changed.values()] }); }
      this.options.bus.publish('capabilities.changed', {});
    });
  }

  /** Recompute every fn's availability; write and return the ones that changed. */
  async #refresh(): Promise<FnRecord[]> {
    const { store } = this.options;
    const [systems, kinds, fns] = await Promise.all([allRows(store.table('systems')), allRows(store.table('kinds')), allRows(store.table('fns'))]);
    const rules = new AvailabilityRules({
      systems: new Map(systems.map((r) => [r.name, r])),
      kinds: new Map(kinds.map((r) => [r.name, r])),
      fns: new Map(fns.map((r) => [r.name, r])),
    });
    const changed: FnRecord[] = [];
    for (const fn of fns) {
      const available = rules.fn(fn.name);
      if (sameAvailability(available, fn.available)) { continue; }
      changed.push(await store.table('fns').update(fn.name, { available, updatedAt: this.options.clock() }));
    }
    return changed;
  }

  /** Ask a connected kind system to describe its kinds' fns again, so a fn declared while it was away gets its signature. */
  async #redescribeKindsOf(system: SystemName): Promise<FnRecord[]> {
    const { store } = this.options;
    if (systemAvailability(system, await store.table('systems').get(system)) !== true) { return []; }
    const kindNames = new Set<string>((await allRows(store.table('kinds'), { system })).map((k) => k.name));
    if (kindNames.size === 0) { return []; }
    return this.#redescribe((await allRows(store.table('fns'))).filter((fn) => kindNames.has(fn.decl.kind)));
  }

  /**
   * Have kinds describe fns again, from their declarations as authored, and store what changed. A description now
   * refused is logged and the last one kept. Returns the records written.
   */
  async #redescribe(fns: readonly FnRecord[]): Promise<FnRecord[]> {
    const { store, log } = this.options;
    const kinds = await this.#storedKinds();
    const written: FnRecord[] = [];
    for (const fn of fns) {
      if (fn.decl.kind === 'native' || !kinds.has(fn.decl.kind)) { continue; }
      const work = this.#work(fn.system, true, this.#storedLookup, kinds);
      const declared = this.#manifests.get(fn.system)?.fns.find((d) => d.name === splitName(fn.name).local) ?? fn.decl;
      const problems = await this.#describe(work, declared);
      if (problems.length > 0) { log.warn('catalog.describe.refused', { fn: fn.name, problems }); continue; }
      this.#rememberTypes(fn.name, work, declared.name);
      const described = work.described.get(declared.name);
      if (described === undefined || sameDecl(described, fn.decl)) { continue; }
      written.push(await store.table('fns').put(await this.#fnRecord(fn.system, described, fn, fn.origin, fn.addedBy)));
    }
    return written;
  }

  /** Kind fns whose signature or described payload names one of `types`, leaving out `skip` (just imported). */
  async #referencing(types: ReadonlySet<string>, skip: ReadonlySet<string>): Promise<FnRecord[]> {
    if (types.size === 0) { return []; }
    return (await allRows(this.options.store.table('fns'))).filter((fn) => {
      if (fn.decl.kind === 'native' || skip.has(fn.name)) { return false; }
      const named = [...(this.#describedTypes.get(fn.name) ?? []), ...[fn.decl.args, fn.decl.returns].flatMap((def) => this.#scopes.mentions(def))];
      return named.some((name) => types.has(name));
    });
  }

  /** Keep the named types a fn's kind said its payload references (nothing for a fn not described this time). */
  #rememberTypes(fn: string, work: ImportWork, local: string): void {
    const types = work.describedTypes.get(local);
    if (types !== undefined) { this.#describedTypes.set(fn, types); }
  }

  // ─── The import itself ────────────────────────────────────────────────────

  async #import(next: Manifest, force: boolean): Promise<ImportReport> {
    await this.#load();
    const { store, log, clock } = this.options;
    const system = next.name;
    const previous = this.#manifests.get(system);
    const before: SectionLists = previous ?? eachSection(() => []);
    const staged = new Map<string, GinTypeDef>(next.types.map((t) => [qualify(system, t.name), t.def]));
    const lookup: TypeLookup = (name) => staged.get(name) ?? this.#storedLookup(name);

    const configProblems = this.#scopes.problems([next.config], lookup);
    if (configProblems.length > 0) {
      return { ...emptyReport(), refused: [{ name: `${system} (config)`, problems: configProblems }] };
    }

    const kinds = await this.#storedKinds();
    for (const kind of next.kinds) { kinds.set(qualify(system, kind.name), kind); }
    const work = this.#work(system, force, lookup, kinds);
    const report = emptyReport();
    const changedNames = new Set<QualifiedName>();
    const removedFrom = new Map<ManifestSection, QualifiedName[]>();

    const checkSection = async <S extends ManifestSection>(section: S, incoming: Array<SectionDecl<S>>): Promise<Array<SectionDecl<S>>> => {
      const old = new Map(before[section].map((decl) => [decl.name, decl]));
      const accepted: Array<SectionDecl<S>> = [];
      for (const decl of incoming) {
        const name = qualify(system, decl.name);
        const prior = old.get(decl.name);
        if (prior !== undefined && !force && sameDecl(prior, decl)) { accepted.push(decl); continue; }
        const problems = await this.#checkEntry(section, decl, work);
        if (problems.length > 0) {
          report.refused.push({ name, problems });
          if (prior !== undefined) { accepted.push(prior); }
          continue;
        }
        accepted.push(decl);
        if (prior === undefined) { report.added.push(name); changedNames.add(name); }
        else if (!sameDecl(prior, decl)) { report.updated.push(name); changedNames.add(name); }
      }
      const kept = new Set(accepted.map((decl) => decl.name));
      const gone = before[section].filter((decl) => !kept.has(decl.name)).map((decl) => qualify(system, decl.name));
      removedFrom.set(section, gone);
      report.removed.push(...gone);
      return accepted;
    };

    // Types first, so everything after parses against what this import accepts.
    const types = await checkSection('types', next.types);
    staged.clear();
    for (const t of types) { staged.set(qualify(system, t.name), t.def); }
    const accepted: SectionLists = {
      types,
      settings: await checkSection('settings', next.settings),
      attachments: await checkSection('attachments', next.attachments),
      kinds: await checkSection('kinds', next.kinds),
      fns: await checkSection('fns', next.fns),
      context: await checkSection('context', next.context),
      hooks: await checkSection('hooks', next.hooks),
      mentions: await checkSection('mentions', next.mentions),
      embedders: await checkSection('embedders', next.embedders),
      sectioners: await checkSection('sectioners', next.sectioners),
      actions: await checkSection('actions', next.actions),
    };
    const stored: Manifest = { ...next, ...accepted };
    const now = clock();

    const fnWrites: FnRecord[] = [];
    await store.tx(async (tx) => {
      for (const decl of accepted.types) {
        const name = qualify(system, decl.name);
        if (changedNames.has(name) || force) { await tx.table('types').put(this.#typeRecord(system, decl, now)); }
      }
      for (const decl of accepted.kinds) {
        const name = qualify(system, decl.name);
        if (changedNames.has(name) || force) { await tx.table('kinds').put({ name, system, decl }); }
      }
      for (const decl of accepted.fns) {
        const name = qualify(system, decl.name);
        const existing = await tx.table('fns').get(name);
        // a kind fn its kind could not describe this time keeps its last description while its declaration is unchanged
        const described = work.described.get(decl.name) ?? (decl.kind !== 'native' && !changedNames.has(name) ? existing?.decl ?? decl : decl);
        if (existing !== undefined && existing.origin === 'contract' && sameDecl(existing.decl, described)) { continue; }
        const record = await this.#fnRecord(system, described, existing, 'contract', undefined);
        fnWrites.push(await tx.table('fns').put(record));
        if (!changedNames.has(name)) { report.updated.push(name); changedNames.add(name); }
      }
      for (const decl of accepted.context) {
        const name = qualify(system, decl.name);
        if (changedNames.has(name) || force) {
          const record = await tx.table('context').put(await this.#contextRecord(tx, system, decl, accepted.context, now));
          // the context graph's declared and mentioned edges are rewritten in the same transaction, so they never drift
          await writeDerivedLinks(tx, record, now);
        }
      }
      for (const name of removedFrom.get('fns') ?? []) {
        if ((await tx.table('fns').get(name))?.origin === 'contract') { await tx.table('fns').remove(name); }
      }
      for (const name of removedFrom.get('types') ?? []) { await tx.table('types').remove(name); }
      for (const name of removedFrom.get('kinds') ?? []) { await tx.table('kinds').remove(name); }
      for (const name of removedFrom.get('context') ?? []) { await tx.table('context').remove(name); await removeLinksFrom(tx, name); }
      await tx.table('manifests').put({ system, manifest: stored, importedAt: now });
    });

    this.#manifests.set(system, stored);
    for (const name of removedFrom.get('types') ?? []) { this.#types.delete(name); }
    for (const decl of accepted.types) { this.#types.set(qualify(system, decl.name), this.#typeRecord(system, decl, now)); }
    for (const name of removedFrom.get('fns') ?? []) { this.#describedTypes.delete(name); }
    for (const fn of fnWrites) { this.#rememberTypes(fn.name, work, splitName(fn.name).local); }
    const changedTypes = new Set<string>([
      ...accepted.types.map((t) => qualify(system, t.name)).filter((name) => changedNames.has(name)), ...(removedFrom.get('types') ?? []),
    ]);
    // a signature is parsed in the scope of the named types it uses, so any type change can change it
    if (changedTypes.size > 0) { this.#signatures.clear(); }
    const redescribed = await this.#redescribe(await this.#referencing(changedTypes, changedNames));
    const availabilityChanged = await this.#refresh();
    const fns = new Map<string, FnRecord>([...fnWrites, ...redescribed, ...availabilityChanged].map((r) => [r.name, r]));
    this.#announce([...report.added, ...report.updated], report.removed, [...fns.values()]);
    log.info('catalog.imported', { system, added: report.added.length, updated: report.updated.length, removed: report.removed.length, refused: report.refused.length });
    return report;
  }

  /** Publish what changed, with the fn records that changed. */
  #announce(added: QualifiedName[], removed: QualifiedName[], records: FnRecord[]): void {
    this.options.bus.publish('catalog.changed', { added, removed, fns: records });
  }

  // ─── Checks per section ───────────────────────────────────────────────────

  #checkEntry<S extends ManifestSection>(section: S, decl: SectionDecl<S>, work: ImportWork): Promise<string[]> {
    const checks: { [K in ManifestSection]: (decl: SectionDecl<K>) => Promise<string[]> | string[] } = {
      types: (d) => this.#checkType(work, d),
      settings: (d) => this.#scopes.problems([d.type], work.lookup),
      attachments: (d) => this.#scopes.problems([d.data], work.lookup),
      kinds: (d) => this.#scopes.problems([d.payload], work.lookup),
      fns: async (d) => this.#checkFn(work, d, await this.fn(qualify(work.system, d.name))),
      context: () => [],
      hooks: () => [],
      mentions: (d) => this.#scopes.problems([d.target], work.lookup),
      embedders: () => [],
      sectioners: () => [],
      actions: (d) => this.#scopes.problems([d.input, d.returns, ...(d.state === undefined ? [] : [d.state])], work.lookup),
    };
    return Promise.resolve(checks[section](decl));
  }

  /** A type parses, and a change stays compatible with what other systems rely on. */
  async #checkType(work: ImportWork, decl: TypeDecl): Promise<string[]> {
    const problems = this.#scopes.problems([decl.def], work.lookup);
    if (problems.length > 0) { return problems; }
    const name = qualify(work.system, decl.name);
    const existing = this.#types.get(name);
    if (existing === undefined || sameDecl(existing.def, decl.def) || !(await this.#mentionedElsewhere(work, name))) { return []; }
    const { types: [next, old], scope } = this.#scopes.parse([decl.def, existing.def], work.lookup);
    if (next === undefined || old === undefined || next.compatible(old, undefined, scope)) { return []; }
    return [`${name} changed in a way other systems can't accept: it must still accept every value it accepted before`];
  }

  /** Whether another system's types or fns refer to a named type. */
  async #mentionedElsewhere(work: ImportWork, name: string): Promise<boolean> {
    for (const type of this.#types.values()) {
      if (type.system !== work.system && this.#scopes.mentions(type.def).includes(name)) { return true; }
    }
    const { fns } = await this.#others(work);
    return fns.some((fn) => [fn.decl.args, fn.decl.returns].some((def) => this.#scopes.mentions(def).includes(name)));
  }

  /** Fn records of other systems, read once per import. */
  #others(work: ImportWork): Promise<{ fns: FnRecord[] }> {
    work.others ??= allRows(this.options.store.table('fns')).then((fns) => ({ fns: fns.filter((fn) => fn.system !== work.system) }));
    return work.others;
  }

  /** A fn's types parse, its kind accepts and describes its payload, and a change keeps faith with its dependents. */
  async #checkFn(work: ImportWork, decl: FnDecl, existing: FnRecord | undefined): Promise<string[]> {
    const defs = [
      decl.args, decl.returns,
      ...[decl.undo, decl.resume, decl.state, decl.form].filter((d) => d !== undefined),
      ...Object.values(decl.handlers).flatMap((h) => [h.args, h.returns]),
    ];
    const problems = this.#scopes.problems(defs, work.lookup);
    if (problems.length > 0) { return problems; }
    const described = await this.#describe(work, decl);
    if (described.length > 0) { return described; }
    if (existing === undefined) { return []; }
    const next = work.described.get(decl.name) ?? decl;
    const name = qualify(work.system, decl.name);
    const { fns } = await this.#others(work);
    const dependents = fns.filter((fn) => fn.decl.deps.includes(name)).map((fn) => fn.name);
    if (dependents.length === 0) { return []; }
    const { types: [newArgs, newReturns, oldArgs, oldReturns], scope } = this.#scopes.parse([next.args, next.returns, existing.decl.args, existing.decl.returns], work.lookup);
    if (newArgs === undefined || newReturns === undefined || oldArgs === undefined || oldReturns === undefined) { return ['its signature did not parse']; }
    const out: string[] = [];
    if (!newArgs.compatible(oldArgs, undefined, scope)) { out.push(`its args no longer accept what ${dependents.join(', ')} pass`); }
    if (!oldReturns.compatible(newReturns, undefined, scope)) { out.push(`its result no longer fits what ${dependents.join(', ')} expect`); }
    if (out.length > 0) { work.described.delete(decl.name); }
    return out;
  }

  /**
   * Check a fn of a kind against the kind's payload type, then have the kind's system describe it. The description
   * must fit the args and result the author declared. Native fns need neither. A kind whose system can't be reached
   * leaves the fn as declared; it is described when that system connects.
   */
  async #describe(work: ImportWork, decl: FnDecl): Promise<string[]> {
    if (decl.kind === 'native') { return []; }
    const kind = work.kinds.get(decl.kind);
    if (kind === undefined) { return []; }
    if (decl.payload === undefined) { return [`a fn of the kind ${decl.kind} needs a payload`]; }
    const payloadProblems = this.#checkValue(kind.payload, decl.payload, work.lookup);
    if (payloadProblems.length > 0) { return payloadProblems.map((p) => `payload: ${p}`); }
    let answer: Awaited<ReturnType<KindDescriber['describe']>>;
    try {
      answer = await this.options.describer.describe(decl.kind, decl.payload, decl.routing?.to === 'instance' ? decl.routing.instance : undefined);
    } catch (error) {
      this.options.log.info('catalog.describe.unreachable', { fn: qualify(work.system, decl.name), kind: decl.kind, error: messageOf(error) });
      return [];
    }
    if (answer.problems.length > 0) { return answer.problems; }
    const description = answer.description;
    if (description === undefined) { return [`${decl.kind} did not describe the payload`]; }
    const parsed = this.#scopes.parse([description.args, description.returns, decl.args, decl.returns], work.lookup);
    const [args, returns, declaredArgs, declaredReturns] = parsed.types;
    if (args === undefined || returns === undefined || declaredArgs === undefined || declaredReturns === undefined) { return ['the description did not parse']; }
    const problems: string[] = [];
    if (!isAny(declaredArgs) && !args.compatible(declaredArgs, undefined, parsed.scope)) { problems.push('the args its kind works out do not accept the declared args'); }
    if (!declaredReturns.compatible(returns, undefined, parsed.scope)) { problems.push('the result its kind works out does not fit the declared result'); }
    if (problems.length > 0) { return problems; }
    work.describedTypes.set(decl.name, description.types ?? []);
    work.described.set(decl.name, {
      ...decl,
      args: description.args,
      returns: description.returns,
      deps: description.deps,
      operations: description.operations,
      handlers: description.handlers ?? decl.handlers,
      progress: description.progress ?? decl.progress,
      limits: description.limits ?? decl.limits,
      display: description.display ?? decl.display,
      // a write query asks every time: its kind says so for the payload, over whatever the fn declared
      ...(description.approval === undefined ? {} : { approval: description.approval }),
      // so are its effects: what the payload reads, writes or deletes
      ...(description.effects === undefined ? {} : { effects: { ...decl.effects, ...description.effects } }),
      // and how a person reads its payload (a query's SQL)
      ...(description.readable === undefined ? {} : { readable: description.readable }),
      // the fn's own status words win over what its kind says for the payload
      ...(decl.status === undefined && description.status !== undefined ? { status: description.status } : {}),
    });
    return [];
  }

  #checkValue(type: GinTypeDef, value: unknown, lookup: TypeLookup): string[] {
    let parsed: ReturnType<GinScopes['one']>;
    try {
      parsed = this.#scopes.one(type, lookup);
    } catch (error) {
      return [`the type is invalid: ${messageOf(error)}`];
    }
    if (parsed.missing.length > 0) { return parsed.missing.map((name) => `the type refers to the unknown type ${name}`); }
    const shape = parsed.type.toValueSchema({ scope: parsed.scope, unknownKeys: 'refuse' }).safeParse(value);
    if (!shape.success) { return shape.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message)); }
    try {
      parsed.type.parse(value);
      return [];
    } catch (error) {
      return [messageOf(error)];
    }
  }

  // ─── Records ──────────────────────────────────────────────────────────────

  #typeRecord(system: SystemName, decl: TypeDecl, now: number): TypeRecord {
    return {
      name: qualify(system, decl.name), system, description: decl.description, def: decl.def, display: decl.display,
      references: this.#scopes.references(decl.def), updatedAt: now,
      // a fleet's type keeps the instance that owns it (a database's table types)
      ...(decl.instance === undefined ? {} : { instance: decl.instance }),
    };
  }

  async #fnRecord(system: SystemName, decl: FnDecl, existing: FnRecord | undefined, origin: FnRecord['origin'], by: ActorId | undefined): Promise<FnRecord> {
    return {
      name: qualify(system, decl.name),
      system,
      decl,
      version: await hashOf(decl),
      origin,
      ...(by === undefined ? {} : { addedBy: by }),
      available: existing?.available ?? unavailable('system-disconnected', 'not checked yet'),
      paused: existing?.paused ?? false,
      disabled: existing?.disabled ?? false,
      stats: existing?.stats ?? noFnStats(),
      updatedAt: this.options.clock(),
    };
  }

  /** A context record, with the `@system/name` references its text makes sorted into fns and context. */
  async #contextRecord(store: HubStore, system: SystemName, decl: ContextDecl, siblings: readonly ContextDecl[], now: number): Promise<ContextRecord> {
    const fns: QualifiedName[] = [];
    const context: QualifiedName[] = [];
    const ownContext = new Set<string>(siblings.map((c) => qualify(system, c.name)));
    for (const match of (decl.content ?? '').matchAll(MENTION)) {
      const name = QualifiedName.parse(match[1]);
      if (fns.includes(name) || context.includes(name)) { continue; }
      if ((await store.table('fns').get(name)) !== undefined) { fns.push(name); }
      else if (ownContext.has(name) || (await store.table('context').get(name)) !== undefined) { context.push(name); }
    }
    return { name: qualify(system, decl.name), system, decl, mentions: { context, fns }, tokens: contextTokens(decl), stale: false, updatedAt: now };
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  #work(system: SystemName, force: boolean, lookup: TypeLookup, kinds: Map<string, KindDecl>): ImportWork {
    return { system, force, lookup, kinds, described: new Map(), describedTypes: new Map() };
  }

  async #storedKinds(): Promise<Map<string, KindDecl>> {
    return new Map((await allRows(this.options.store.table('kinds'))).map((k) => [k.name, k.decl]));
  }

  /** The stored definition of a named type. */
  readonly #storedLookup: TypeLookup = (name) => this.#types.get(name)?.def;

  /** A stored type's qualified name. */
  #typeName(name: string): QualifiedName {
    const record = this.#types.get(name);
    if (record === undefined) { throw new Error(`no type ${name}`); }
    return record.name;
  }

  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      const { store } = this.options;
      for (const row of await allRows(store.table('types'))) { this.#types.set(row.name, row); }
      for (const row of await allRows(store.table('manifests'))) { this.#manifests.set(row.system, row.manifest); }
    })();
    return this.#loaded;
  }
}

/** Whether a type is gin's `any` (an author who gave no args type). */
function isAny(type: Type): boolean {
  return type.name === 'any';
}
