/**
 * The catalog over the hub store. It imports manifests and patches (checking every gin type in the scope of the
 * named types it needs, refusing incompatible changes to things other systems depend on, and asking kinds to
 * describe their fns), keeps the last accepted manifest of every system, and works out what can be used now.
 */
import type { Type } from '@aeye/gin';
import type { Logger } from '@ayepi/log';
import {
  apiContextName, Json, MANIFEST_SECTION_NAMES, noFnStats, QualifiedName, qualify, runtimeNames, splitName,
  type ActorId, type Availability, type ContextDecl, type ContextRecord, type FnDecl, type FnRecord, type GinTypeDef, type ImportReport,
  type KindDecl, type KindRecord, type Manifest, type ManifestPatch, type ManifestSection, type SectionDecl, type SystemName,
  type InstanceName, type TypeDecl, type TypeRecord, type DeclaredBy, type FnLink, type ApiGroupDecl,
} from '@harness/core';
import { canonicalJson, sha256 } from '@harness/sdk';
import { z } from 'zod';
import type { EventBus } from '../bus.ts';
import { removeLinksFrom, writeDerivedLinks } from '../contextor/graph.ts';
import { contextTokens } from '../contextor/tokens.ts';
import type { HubStore } from '../store/index.ts';
import { AvailabilityRules, heldFns, sameAvailability, systemAvailability, systemOf, unavailable } from './availability.ts';
import type { Catalog, CatalogEntry, FnFilter, FnSignature, KindDescriber } from './index.ts';
import { allRows, rows } from '../store/rows.ts';
import { GinScopes, messageOf, type TypeLookup } from './scope.ts';
import { Serial } from './serial.ts';
import { itemChanges, writeItemVersions } from './versions.ts';
import { apiIndexDecls, isApiIndexName } from './api-index.ts';

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
  const types = ownedSection(before?.types ?? [], sent.types, from, typeOwner);
  const fns = ownedSection(before?.fns ?? [], sent.fns, from, fnOwner);
  // an entry another instance owns stays runtime if it was; the sender's own are as it says
  const runtimeIn = (section: 'types' | 'fns', kept: ReadonlyArray<{ name: string }>, owner: (name: string) => InstanceName | undefined): string[] => {
    const was = before === undefined ? new Set<string>() : runtimeNames(before, section);
    const says = runtimeNames(sent, section);
    return kept.map((decl) => decl.name).filter((name) => { const own = owner(name); return own !== undefined && own !== from ? was.has(name) : says.has(name); });
  };
  const ownerOf = <D extends { name: string }>(list: readonly D[], owner: (decl: D) => InstanceName | undefined) => (name: string) => { const decl = list.find((d) => d.name === name); return decl === undefined ? undefined : owner(decl); };
  const runtime = { ...sent.runtime, types: runtimeIn('types', types, ownerOf(types, typeOwner)), fns: runtimeIn('fns', fns, ownerOf(fns, fnOwner)) };
  return { ...sent, types, fns, runtime };
}

/** Running numbers for a fn that has never run. */

/** `@system/name` references in context text. */
const MENTION = /@([a-z][a-z0-9-]*\/[A-Za-z_](?:[\w.-]*\w)?)/g;

/** The hash of a JSON value, so equal content gives equal versions. */
async function hashOf(value: unknown): Promise<string> {
  return sha256(canonicalJson(Json.parse(value)));
}

/**
 * The hash of a manifest as the hub stores it: its body (everything but `hash`), so a hash names exactly one content.
 * The hub never keeps the hash a system sends: a review approves this one, and the same content always hashes the same.
 */
export async function manifestHashOf(manifest: Omit<Manifest, 'hash'> & { hash?: string }): Promise<string> {
  const { hash: _sent, ...body } = manifest;
  // a spread can leave a key present but undefined; JSON drops it, as the system's own hash does
  const plain: unknown = JSON.parse(JSON.stringify(body));
  return hashOf(plain);
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
}

/** The catalog, kept in the hub store. */
export class StoreCatalog implements Catalog {
  readonly #scopes: GinScopes;
  readonly #serial = new Serial();
  readonly #types = new Map<string, TypeRecord>();
  readonly #manifests = new Map<string, Manifest>();
  readonly #signatures = new Map<string, { version: string; signature: FnSignature }>();
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

  async fns(filter: FnFilter): Promise<FnRecord[]> {
    if (filter.names !== undefined) { return (await this.#records(filter.names)).filter((row) => fnMatches(row, filter)); }
    const out: FnRecord[] = [];
    for await (const row of this.eachFn(filter)) { out.push(row); }
    return out;
  }

  async *eachFn(filter: Omit<FnFilter, 'names'>): AsyncGenerator<FnRecord> {
    const where = filter.system !== undefined ? { system: filter.system } : filter.systems !== undefined ? { system: { in: [...filter.systems] } } : undefined;
    for await (const row of rows(this.options.store.table('fns'), where === undefined ? {} : { where })) {
      if (fnMatches(row, filter)) { yield row; }
    }
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
    // a context item is served by its record's system: the hub for what it made itself (`memory/…`, `resource/…`)
    const context = await this.context(name);
    const system = context?.system ?? systemOf(name);
    if (system === undefined) { return unavailable('system-disconnected', `${name} names no valid system`); }
    // a context item has its own switch; any other part (a hook, mention, action, embedder, sectioner, …) is off by an
    // admin's `itemSwitches` row, and every item that waits in a pending review is off until it is approved
    const among = (section: string): boolean => (context === undefined ? section !== 'fns' : section === 'context');
    const pending = (await this.options.store.table('systemReviews').get(system))?.pending;
    if (pending?.changes.some((change) => among(change.section) && change.name === name && change.change !== 'removed') === true) {
      return unavailable('disabled', `${name} changed and waits for an admin to approve it`);
    }
    if (context === undefined && (await this.options.store.table('itemSwitches').find({ where: { system, name }, limit: 1 })).items.length > 0) {
      return unavailable('disabled', `${name} is switched off`);
    }
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
      // the top-level lists (providers, registries, contributions) are short, so a patch replaces each whole
      // what a patch adds is the running system's own, not its contract's: its records say `runtime`, as the system's next whole manifest will
      const runtimeLists: { [S in ManifestSection]?: string[] } = {};
      for (const section of MANIFEST_SECTION_NAMES) {
        const removed = new Set(patch.remove[section] ?? []);
        const names = new Set([...runtimeNames(previous, section)].filter((name) => !removed.has(name)));
        for (const decl of upsert[section] ?? []) { names.add(decl.name); }
        if (names.size > 0) { runtimeLists[section] = [...names].sort(); }
      }
      // the patch's own hash is not kept: the import hashes what it stores
      const next: Manifest = { ...previous, ...sections, ...patch.lists, runtime: runtimeLists };
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
      const record = await this.#fnRecord(system, stored, existing, 'runtime', by);
      const manifest = this.#manifests.get(system);
      const systemRow = await this.options.store.table('systems').get(system);
      const apiChanged = await this.options.store.tx(async (tx) => {
        await tx.table('fns').put(record);
        await this.#writeIndexes(tx, record, work.describedTypes.get(decl.name));
        // the version is the declaration as the person saved it; an unchanged save writes none
        if (existing === undefined || existing.version !== record.version) {
          await writeItemVersions(tx, system, [{ section: 'fns', name, change: existing === undefined ? 'added' : 'changed', decl: Json.parse(decl), declaredBy: 'runtime' }], this.options.clock(), by);
        }
        // a saved fn is listed in its system's API index with the rest of its group
        const off = systemRow?.enabled.context === false || systemRow?.stage === 'installed';
        return this.#writeApiIndex(tx, system, manifest?.context ?? [], manifest?.groups ?? [], this.options.clock(), off);
      });
      await this.#refresh([name]);
      const saved = await this.fn(name);
      this.#announce([name], [], saved === undefined ? [] : [saved]);
      for (const changed of apiChanged) { this.options.bus.publish('context.changed', { name: changed }); }
      return { ...emptyReport(), ...(existing === undefined ? { added: [name] } : { updated: [name] }) };
    });
  }

  /**
   * Write the index rows (`fnSignatureTypes`, `fnLinks`) of every stored fn, once, on a hub whose fns were stored
   * before build 8 kept them: a migration, read page by page. Returns how many fns it indexed (none when the rows exist).
   */
  async indexStoredFns(): Promise<number> {
    const { store } = this.options;
    if ((await store.table('fnLinks').count()) > 0 || (await store.table('fnSignatureTypes').count()) > 0) { return 0; }
    await this.#load();
    let indexed = 0;
    for await (const fn of rows(store.table('fns'))) {
      await store.tx((tx) => this.#writeIndexes(tx, fn, undefined));
      indexed += 1;
    }
    if (indexed > 0) { this.options.log.info('catalog.fns.indexed', { fns: indexed }); }
    return indexed;
  }

  // ─── Availability ─────────────────────────────────────────────────────────

  async refreshAvailability(system: SystemName): Promise<void> {
    await this.#serial.run(async () => {
      const redescribed = await this.#redescribeKindsOf(system);
      const changed = new Map([...redescribed, ...await this.#refresh(await this.#touchedBy(system))].map((r) => [r.name, r]));
      if (changed.size > 0) { this.options.bus.publish('catalog.changed', { added: [], removed: [], fns: [...changed.values()] }); }
      this.options.bus.publish('capabilities.changed', {});
    });
  }

  /**
   * The fns whose availability a change to a system can change on their own: its fns, the fns of its kinds (the kinds
   * it has, and any it just removed), and fns it just removed (so the fns that depend on them follow). All read through
   * the database's indexes.
   */
  async #touchedBy(system: SystemName, removed: { readonly fns: readonly QualifiedName[]; readonly kinds: readonly QualifiedName[] } = { fns: [], kinds: [] }): Promise<QualifiedName[]> {
    const { store } = this.options;
    const [own, kinds] = await Promise.all([allRows(store.table('fns'), { where: { system } }), allRows(store.table('kinds'), { where: { system } })]);
    const kindNames = [...new Set([...kinds.map((k) => k.name), ...removed.kinds])];
    const ofKinds = kindNames.length === 0 ? [] : await allRows(store.table('fnLinks'), { where: { to: { in: kindNames }, link: 'kind' } });
    return [...own.map((fn) => fn.name), ...ofKinds.map((row) => row.fn), ...removed.fns];
  }

  /**
   * Recompute the availability of some fns and of every fn that depends on them, at any depth (found through the
   * `fnLinks` index); write and return the ones that changed. The fns they depend on that nothing here reaches keep the
   * availability stored for them, which this change cannot move.
   */
  async #refresh(seeds: readonly QualifiedName[]): Promise<FnRecord[]> {
    const { store } = this.options;
    const records = await this.#records([...await this.#dependents(seeds)]);
    const fns = new Map(records.map((r) => [r.name, r]));
    const outside = qualifiedOnly(new Set(records.flatMap((r) => r.decl.deps).filter((dep) => !fns.has(dep))));
    const kindNames = qualifiedOnly(new Set(records.flatMap((r) => (r.decl.kind === 'native' ? [] : [r.decl.kind]))));
    const kinds = (await Promise.all(kindNames.map((name) => store.table('kinds').get(name)))).filter((kind) => kind !== undefined);
    const ownSystems = new Set<SystemName>(records.map((r) => r.system));
    const systemNames = new Set<SystemName>([...ownSystems, ...kinds.flatMap((kind) => { const owner = systemOf(kind.name); return owner === undefined ? [] : [owner]; })]);
    const [settled, systems, reviews, kindsOff] = await Promise.all([
      this.#records(outside),
      Promise.all([...systemNames].map((name) => store.table('systems').get(name))),
      Promise.all([...ownSystems].map((name) => store.table('systemReviews').get(name))),
      kindNames.length === 0 ? Promise.resolve([]) : allRows(store.table('itemSwitches'), { where: { section: 'kinds', name: { in: kindNames } } }),
    ]);
    const rules = new AvailabilityRules({
      systems: new Map(systems.filter((r) => r !== undefined).map((r) => [r.name, r])),
      kinds: new Map(kinds.map((r) => [r.name, r])),
      fns,
      settled: new Map(settled.map((r) => [r.name, r.available])),
      held: heldFns(reviews.filter((r) => r !== undefined)),
      kindsOff: new Set(kindsOff.map((r) => r.name)),
    });
    const changed: FnRecord[] = [];
    for (const fn of records) {
      const available = rules.fn(fn.name);
      if (sameAvailability(available, fn.available)) { continue; }
      changed.push(await store.table('fns').update(fn.name, { available, updatedAt: this.options.clock() }));
    }
    return changed;
  }

  /** Some fns and every fn that depends on them, at any depth, through the `fnLinks` index. */
  async #dependents(seeds: readonly QualifiedName[]): Promise<Set<QualifiedName>> {
    const found = new Set<QualifiedName>(seeds);
    for (let frontier = [...found]; frontier.length > 0;) {
      const links = await allRows(this.options.store.table('fnLinks'), { where: { to: { in: frontier }, link: 'dep' } });
      frontier = [...new Set(links.map((row) => row.fn))].filter((name) => !found.has(name));
      for (const name of frontier) { found.add(name); }
    }
    return found;
  }

  /** Ask a connected kind system to describe its kinds' fns again, so a fn declared while it was away gets its signature. */
  async #redescribeKindsOf(system: SystemName): Promise<FnRecord[]> {
    const { store } = this.options;
    if (systemAvailability(system, await store.table('systems').get(system), { staged: false }) !== true) { return []; }
    const kindNames = (await allRows(store.table('kinds'), { where: { system } })).map((k) => k.name);
    if (kindNames.length === 0) { return []; }
    // the fns of its kinds, from the links the fns' transactions keep
    const names = (await allRows(store.table('fnLinks'), { where: { to: { in: kindNames.flatMap((k) => qualifiedOnly([k])) }, link: 'kind' } })).map((row) => row.fn);
    return this.#redescribe(await this.#records(names));
  }

  /** A fn's `fnLinks` rows: one per fn it depends on, and one to its kind. */
  async #writeLinks(store: HubStore, fn: FnRecord, fresh: boolean): Promise<void> {
    const table = store.table('fnLinks');
    const links: FnLink[] = [
      ...qualifiedOnly(fn.decl.deps).map((to): FnLink => ({ fn: fn.name, to, link: 'dep', system: fn.system })),
      ...(fn.decl.kind === 'native' ? [] : qualifiedOnly([fn.decl.kind]).map((to): FnLink => ({ fn: fn.name, to, link: 'kind', system: fn.system }))),
    ];
    const keep = new Set(links.map((l) => `${l.link}:${l.to}`));
    for (const row of fresh ? [] : await allRows(table, { where: { fn: fn.name } })) {
      if (!keep.has(`${row.link}:${row.to}`)) { await table.remove({ fn: row.fn, to: row.to, link: row.link }); }
    }
    await table.putAll(links);
  }

  /** Remove a fn's index rows with it. */
  async #removeIndexes(store: HubStore, name: QualifiedName): Promise<void> {
    for (const row of await allRows(store.table('fnSignatureTypes'), { where: { fn: name } })) { await store.table('fnSignatureTypes').remove({ fn: row.fn, type: row.type }); }
    for (const row of await allRows(store.table('fnLinks'), { where: { fn: name } })) { await store.table('fnLinks').remove({ fn: row.fn, to: row.to, link: row.link }); }
  }

  /** The fn records of some names, leaving out any gone. */
  async #records(names: readonly QualifiedName[]): Promise<FnRecord[]> {
    const fns = this.options.store.table('fns');
    return (await Promise.all([...new Set(names)].map((name) => fns.get(name)))).filter((fn) => fn !== undefined);
  }

  /**
   * Keep a fn's index rows, in the fn's transaction: the named types its signature mentions (its args and result as
   * written, and the types its kind said its payload references) in `fnSignatureTypes`, and the fns it depends on and its
   * kind in `fnLinks`. A kind fn not described this time keeps the types its last description gave.
   */
  async #writeIndexes(store: HubStore, fn: FnRecord, described: readonly string[] | undefined, fresh = false): Promise<void> {
    // a fn stored for the first time has no rows to replace
    await this.#writeLinks(store, fn, fresh);
    const table = store.table('fnSignatureTypes');
    const before = fresh ? [] : await allRows(table, { where: { fn: fn.name } });
    const kept = fn.decl.kind !== 'native' && described === undefined ? before.map((row) => row.type) : [];
    const named = new Set<string>([...kept, ...(described ?? []), ...[fn.decl.args, fn.decl.returns].flatMap((def) => this.#scopes.mentions(def))]);
    const types = qualifiedOnly(named);
    for (const row of before) { if (!types.includes(row.type)) { await table.remove({ fn: row.fn, type: row.type }); } }
    await table.putAll(types.map((type) => ({ fn: fn.name, type, kind: fn.decl.kind, system: fn.system })));
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
      const described = work.described.get(declared.name);
      const types = work.describedTypes.get(declared.name);
      if (described === undefined || sameDecl(described, fn.decl)) {
        if (types !== undefined) { await this.#writeIndexes(store, fn, types); }
        continue;
      }
      const record = await this.#fnRecord(fn.system, described, fn, fn.origin, fn.addedBy);
      written.push(await store.tx(async (tx) => {
        const put = await tx.table('fns').put(record);
        await this.#writeIndexes(tx, put, types);
        return put;
      }));
    }
    return written;
  }

  /** Kind fns whose signature or described payload names one of `types`, leaving out `skip` (just imported). */
  async #referencing(types: ReadonlySet<string>, skip: ReadonlySet<string>): Promise<FnRecord[]> {
    const named = qualifiedOnly(types);
    if (named.length === 0) { return []; }
    const rows = await allRows(this.options.store.table('fnSignatureTypes'), { where: { type: { in: named } } });
    return this.#records(rows.filter((row) => row.kind !== 'native' && !skip.has(row.fn)).map((row) => row.fn));
  }

  // ─── The import itself ────────────────────────────────────────────────────

  async #import(next: Manifest, force: boolean): Promise<ImportReport> {
    await this.#load();
    const { store, log, clock } = this.options;
    const system = next.name;
    const previous = this.#manifests.get(system);
    // what the running system added (`Manifest.runtime`, kept across patches) is its own, not its contract's
    const declaredBy = (section: ManifestSection, local: string): DeclaredBy => (runtimeNames(next, section).has(local) ? 'runtime' : 'contract');
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
    const body: Manifest = { ...next, ...accepted };
    const stored: Manifest = { ...body, hash: await manifestHashOf(body) };
    const now = clock();

    const fnWrites: FnRecord[] = [];
    const apiChanged: QualifiedName[] = [];
    const systemRow = await store.table('systems').get(system);
    // an installed system's context stays off with the rest of it until it goes live
    const contextSwitchedOff = systemRow?.enabled.context === false || systemRow?.stage === 'installed';
    await store.tx(async (tx) => {
      for (const decl of accepted.types) {
        const name = qualify(system, decl.name);
        if (changedNames.has(name) || force || this.#types.get(name)?.declaredBy !== declaredBy('types', decl.name)) {
          await tx.table('types').put(this.#typeRecord(system, decl, now, declaredBy('types', decl.name), await hashOf(decl)));
        }
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
        const origin: FnRecord['origin'] = declaredBy('fns', decl.name);
        if (existing !== undefined && existing.origin === origin && sameDecl(existing.decl, described)) { continue; }
        const record = await this.#fnRecord(system, described, existing, origin, undefined);
        fnWrites.push(await tx.table('fns').put(record));
        await this.#writeIndexes(tx, record, work.describedTypes.get(decl.name), existing === undefined);
        if (!changedNames.has(name)) { report.updated.push(name); changedNames.add(name); }
      }
      for (const decl of accepted.context) {
        const name = qualify(system, decl.name);
        const existing = await tx.table('context').get(name);
        const by = declaredBy('context', decl.name);
        if (changedNames.has(name) || force || existing?.declaredBy !== by) {
          // a new declaration keeps what people set on the item: switched off, by itself or with its system's context
          const kept: Partial<ContextRecord> = {
            ...(existing?.origin === undefined ? {} : { origin: existing.origin }),
            ...(existing?.disabled === undefined ? {} : { disabled: existing.disabled }),
            // a new item of a system whose context is switched off starts off with it
            ...(existing?.systemOff === undefined ? (contextSwitchedOff ? { systemOff: true } : {}) : { systemOff: existing.systemOff }),
          };
          const record = await tx.table('context').put({ ...await this.#contextRecord(tx, system, decl, accepted.context, now), ...kept, declaredBy: by, version: await hashOf(decl) });
          // the context graph's declared and mentioned edges are rewritten in the same transaction, so they never drift
          await writeDerivedLinks(tx, record, now);
        }
      }
      for (const name of removedFrom.get('fns') ?? []) {
        // a fn a person saved (`addedBy`) is never in a manifest, so only the system's own go
        const gone = await tx.table('fns').get(name);
        if (gone !== undefined && (gone.origin === 'contract' || gone.addedBy === undefined)) {
          await tx.table('fns').remove(name);
          await this.#removeIndexes(tx, name);
        }
      }
      // the API index items list the system's fns as this import leaves them, saved ones too
      apiChanged.push(...await this.#writeApiIndex(tx, system, accepted.context, next.groups ?? [], now, contextSwitchedOff));
      for (const name of removedFrom.get('types') ?? []) { await tx.table('types').remove(name); }
      for (const name of removedFrom.get('kinds') ?? []) { await tx.table('kinds').remove(name); }
      for (const name of removedFrom.get('context') ?? []) { await tx.table('context').remove(name); await removeLinksFrom(tx, name); }
      await tx.table('manifests').put({ system, manifest: stored, importedAt: now });
      // every item that changed gets a version (a type's keeps its meta: a table's schema hash at that version)
      await writeItemVersions(tx, system, itemChanges(previous, stored), now);
    });

    this.#manifests.set(system, stored);
    for (const name of removedFrom.get('types') ?? []) { this.#types.delete(name); }
    for (const decl of accepted.types) {
      const name = qualify(system, decl.name);
      this.#types.set(name, this.#typeRecord(system, decl, now, declaredBy('types', decl.name), await hashOf(decl)));
    }
    const changedTypes = new Set<string>([
      ...accepted.types.map((t) => qualify(system, t.name)).filter((name) => changedNames.has(name)), ...(removedFrom.get('types') ?? []),
    ]);
    // a signature is parsed in the scope of the named types it uses, so any type change can change it
    if (changedTypes.size > 0) { this.#signatures.clear(); }
    const redescribed = await this.#redescribe(await this.#referencing(changedTypes, changedNames));
    const availabilityChanged = await this.#refresh(await this.#touchedBy(system, { fns: removedFrom.get('fns') ?? [], kinds: removedFrom.get('kinds') ?? [] }));
    const fns = new Map<string, FnRecord>([...fnWrites, ...redescribed, ...availabilityChanged].map((r) => [r.name, r]));
    this.#announce([...report.added, ...report.updated], report.removed, [...fns.values()]);
    for (const name of apiChanged) { this.options.bus.publish('context.changed', { name }); }
    log.info('catalog.imported', { system, added: report.added.length, updated: report.updated.length, removed: report.removed.length, refused: report.refused.length });
    return report;
  }

  /**
   * Write a system's API index items (`api-index.ts`) from a query of the system's stored fns (its contract's and those
   * saved at runtime, as a widget or a form): changed ones rewritten, a group that no longer has fns removed (found from
   * the index item's own choices). An item the system declares itself (`context`) under the same name is left to it.
   * Returns the names written or removed.
   */
  async #writeApiIndex(tx: HubStore, system: SystemName, context: readonly ContextDecl[], groups: readonly ApiGroupDecl[], now: number, off: boolean): Promise<QualifiedName[]> {
    const own = new Set<string>(context.map((decl) => qualify(system, decl.name)));
    const fns = (await allRows(tx.table('fns'), { where: { system } })).map((fn) => fn.decl);
    const decls = apiIndexDecls(system, fns, groups).filter((decl) => !own.has(qualify(system, decl.name)));
    const table = tx.table('context');
    const previous = await table.get(apiContextName(system));
    const wanted = new Set<string>(decls.map((decl) => qualify(system, decl.name)));
    const changed: QualifiedName[] = [];
    const before: QualifiedName[] = previous === undefined || own.has(previous.name) ? [] : [previous.name, ...(previous.decl.choices ?? []).map((choice) => choice.to)];
    for (const name of before) {
      if (wanted.has(name) || own.has(name) || !isApiIndexName(system, name)) { continue; }
      await table.remove(name);
      await removeLinksFrom(tx, name);
      changed.push(name);
    }
    for (const decl of decls) {
      const name = qualify(system, decl.name);
      const existing = name === previous?.name ? previous : await table.get(name);
      if (existing !== undefined && sameDecl(existing.decl, decl)) { continue; }
      const record = await table.put({
        ...await this.#contextRecord(tx, system, decl, decls, now), origin: { type: 'system' }, declaredBy: 'runtime', version: await hashOf(decl),
        ...(existing?.disabled === undefined ? {} : { disabled: existing.disabled }),
        ...(existing?.systemOff === undefined ? (off ? { systemOff: true } : {}) : { systemOff: existing.systemOff }),
      });
      await writeDerivedLinks(tx, record, now);
      changed.push(name);
    }
    return changed;
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
    const [type] = qualifiedOnly([name]);
    if (type === undefined) { return false; }
    // the fns whose signature names it, from the index the fns' transactions keep
    return (await allRows(this.options.store.table('fnSignatureTypes'), { where: { type } })).some((row) => row.system !== work.system);
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
    // other systems' fns that depend on it, from the links the fns' transactions keep
    const dependents = (await allRows(this.options.store.table('fnLinks'), { where: { to: name, link: 'dep' } })).filter((row) => row.system !== work.system).map((row) => row.fn);
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

  #typeRecord(system: SystemName, decl: TypeDecl, now: number, by: DeclaredBy, version: string): TypeRecord {
    return {
      name: qualify(system, decl.name), system, description: decl.description, def: decl.def, display: decl.display,
      references: this.#scopes.references(decl.def), declaredBy: by, version, updatedAt: now,
      // a fleet's type keeps the instance that owns it (a database's table types)
      ...(decl.instance === undefined ? {} : { instance: decl.instance }),
      // and who may see it, when that is narrower than its system
      ...(decl.audience === undefined ? {} : { audience: decl.audience }),
      // and what its system keeps about it (build 6), read back through `types` and `ctx.types`
      ...(decl.meta === undefined ? {} : { meta: decl.meta }),
      // and, for a stored type, how the hub keeps its records (build 8, the data system)
      ...(decl.records === undefined ? {} : { records: decl.records }),
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

/** The names that are qualified names (a gin mention of a built-in type is not). */
function qualifiedOnly(names: Iterable<string>): QualifiedName[] {
  return [...names].flatMap((name) => { const parsed = QualifiedName.safeParse(name); return parsed.success ? [parsed.data] : []; });
}

/** Whether a fn passes a filter's system, systems and availability. */
function fnMatches(row: FnRecord, filter: Omit<FnFilter, 'names'>): boolean {
  return (filter.system === undefined || row.system === filter.system) && (filter.systems === undefined || filter.systems.includes(row.system))
    && (filter.available === undefined || (row.available === true) === filter.available);
}

/** Whether a type is gin's `any` (an author who gave no args type). */
function isAny(type: Type): boolean {
  return type.name === 'any';
}
