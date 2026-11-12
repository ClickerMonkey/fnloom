/**
 * Build 7: installed vs live. A newly paired system is `installed`: the hub knows its contract but offers nothing
 * (`systemAvailability` refuses its contributions) until an admin reviews it and goes live, which saves the reviewed
 * contract's hash and grants (`LiveContract`). After that, every manifest or patch is compared with the one before it:
 * runtime additions its fns declared (`FnEffects.registry`) are approved at once, anything else waits as a
 * `PendingReview` with its changes, which stay off (`held`) while the live version keeps serving. Items an admin
 * switches off one by one are `itemSwitches` rows (fns and context keep their own `disabled`).
 */
import { reject as refuse } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { canonicalJson } from '@harness/sdk';
import {
  effectCovered, FnDecl, FnKindName, Json, MANIFEST_SECTION_NAMES, qualify, QualifiedName, runtimeNames,
  type ActorId, type ContractChange, type DeclaredBy, type GoLiveRequest, type ItemRef, type ItemSection, type LiveContract, type Manifest, type PendingReview,
  type RegistryEffect, type RegistryThing, type SwitchPart, type SystemName, type SystemReviewRecord, type SystemStage,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { allRows } from '../catalog/rows.ts';
import { Serial } from '../catalog/serial.ts';
import type { HubStore } from '../store/index.ts';
import type { ReviewEnv } from './env.ts';
import type { ResourceRouter } from './index.ts';

/** What the lifecycle needs. */
export interface LifecycleOptions {
  readonly store: HubStore;
  readonly catalog: Catalog;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly clock: () => number;
  readonly settings: Pick<ReviewEnv, 'HARNESS_REVIEW_SYSTEMS'>;
  /** Asks a system for its resource roots again, so a system going live (or a root switched on) is indexed. */
  readonly resources?: () => Pick<ResourceRouter, 'refresh'>;
}

/** One item of a manifest as the review compares it. */
interface ManifestItem {
  readonly section: ContractChange['section'];
  readonly name: string;
  readonly origin: DeclaredBy;
  readonly decl: Json;
  /** The registry change adding or changing it at runtime would be, for the sections a fn can declare. */
  readonly effect?: { readonly thing: RegistryThing; readonly kind?: string };
}

/** The key of an item (or a change to one) within a system: its section and its listed name. */
export const itemKey = (item: Pick<ContractChange, 'section' | 'name'>): string => `${item.section}\u0000${item.name}`;

/** The registry thing each manifest section's runtime additions are, where a fn can declare them. */
const SECTION_THINGS: Partial<Record<ContractChange['section'], RegistryThing>> = { fns: 'fns', types: 'types', context: 'context', kinds: 'kinds', components: 'components' };

/** The name its client build is listed by among a system's components: the code the web loads for its renderers and config component. */
export const clientItemName = (system: SystemName): string => `${system}: client build`;

/**
 * Every item of a manifest, keyed by section and listed name (qualified, a `/command`, `<registry>: <label>`). Besides
 * its sections, the parts a review must see change: its client build and config component (as components, so a
 * changed build is held off until approved), and, as whole-system items like its config type, its per-person connect
 * page, the hub events it gets and whether it serves resources. Node permissions are not here: they are the package's
 * (`system.json`), which only an admin installs.
 */
export function manifestItems(manifest: Manifest): Map<string, ManifestItem> {
  const out = new Map<string, ManifestItem>();
  const add = (item: ManifestItem): void => { out.set(itemKey(item), item); };
  for (const section of MANIFEST_SECTION_NAMES) {
    const runtime = runtimeNames(manifest, section);
    for (const decl of manifest[section]) {
      const thing = SECTION_THINGS[section];
      const kind = section === 'fns' && 'kind' in decl && typeof decl.kind === 'string' ? decl.kind : undefined;
      add({
        section, name: qualify(manifest.name, decl.name), origin: runtime.has(decl.name) ? 'runtime' : 'contract', decl: Json.parse(decl),
        ...(thing === undefined ? {} : { effect: { thing, ...(kind === undefined ? {} : { kind }) } }),
      });
      if (section === 'context' && 'command' in decl && decl.command !== undefined) {
        add({ section: 'commands', name: `/${decl.command.name}`, origin: runtime.has(decl.name) ? 'runtime' : 'contract', decl: Json.parse(decl.command) });
      }
    }
  }
  for (const decl of manifest.providers ?? []) { add({ section: 'providers', name: qualify(manifest.name, decl.name), origin: 'contract', decl: Json.parse(decl) }); }
  for (const decl of manifest.registries ?? []) { add({ section: 'registries', name: qualify(manifest.name, decl.name), origin: 'contract', decl: Json.parse(decl) }); }
  for (const decl of manifest.contributes ?? []) { add({ section: 'components', name: `${decl.registry}: ${decl.label}`, origin: 'contract', decl: Json.parse(decl), effect: { thing: 'components' } }); }
  add({ section: 'grants', name: manifest.name, origin: 'contract', decl: Json.parse(manifest.grants ?? { hub: [] }) });
  add({ section: 'config', name: manifest.name, origin: 'contract', decl: Json.parse(manifest.config) });
  if (manifest.client !== undefined) { add({ section: 'components', name: clientItemName(manifest.name), origin: 'contract', decl: Json.parse(manifest.client) }); }
  if (manifest.configComponent !== undefined) { add({ section: 'components', name: `${manifest.name}: config component`, origin: 'contract', decl: Json.parse(manifest.configComponent) }); }
  if (manifest.connect !== undefined) { add({ section: 'config', name: `${manifest.name} connect`, origin: 'contract', decl: Json.parse(manifest.connect) }); }
  add({ section: 'config', name: `${manifest.name} events`, origin: 'contract', decl: [...manifest.events].sort() });
  add({ section: 'config', name: `${manifest.name} resources`, origin: 'contract', decl: manifest.resources });
  return out;
}

/** What changed from one manifest to the next, item by item. */
export function contractChanges(before: Manifest | undefined, after: Manifest): ContractChange[] {
  const was = before === undefined ? new Map<string, ManifestItem>() : manifestItems(before);
  const now = manifestItems(after);
  const changes: ContractChange[] = [];
  for (const [key, item] of now) {
    const old = was.get(key);
    if (old === undefined) { changes.push({ section: item.section, name: item.name, change: 'added', origin: item.origin, after: item.decl }); continue; }
    if (canonicalJson(old.decl) !== canonicalJson(item.decl)) { changes.push({ section: item.section, name: item.name, change: 'changed', origin: item.origin, before: old.decl, after: item.decl }); }
  }
  for (const [key, item] of was) {
    if (!now.has(key)) { changes.push({ section: item.section, name: item.name, change: 'removed', origin: item.origin, before: item.decl }); }
  }
  return changes;
}

/** Fold newer changes onto ones already waiting, so a pending review always reads from the live version. */
export function mergeChanges(waiting: readonly ContractChange[], newer: readonly ContractChange[]): ContractChange[] {
  const out = new Map(waiting.map((change) => [itemKey(change), change]));
  for (const change of newer) {
    const old = out.get(itemKey(change));
    if (old === undefined) { out.set(itemKey(change), change); continue; }
    const before = old.change === 'added' ? undefined : old.before;
    const after = change.change === 'removed' ? undefined : change.after;
    out.delete(itemKey(change));
    if (before === undefined && after === undefined) { continue; }
    if (before !== undefined && after !== undefined && canonicalJson(before) === canonicalJson(after)) { continue; }
    const kind: ContractChange['change'] = before === undefined ? 'added' : after === undefined ? 'removed' : 'changed';
    out.set(itemKey(change), { ...change, change: kind, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
  }
  return [...out.values()];
}

/** The item a change is about, when it is one the switches cover (not the grants or config as a whole). */
function itemOf(change: ContractChange): ItemRef | undefined {
  return change.section === 'grants' || change.section === 'config' ? undefined : { section: change.section, name: change.name };
}

/**
 * Fold changes that went live onto a live contract's runtime items: an added or changed one is listed once, a removed
 * one is dropped. Only runtime changes count, as `LiveContract.runtime` lists what was added at runtime.
 */
export function foldRuntime(runtime: readonly ItemRef[], changes: readonly ContractChange[]): ItemRef[] {
  const out = new Map(runtime.map((item) => [itemKey(item), item]));
  for (const change of changes) {
    const item = change.origin === 'runtime' ? itemOf(change) : undefined;
    if (item === undefined) { continue; }
    if (change.change === 'removed') { out.delete(itemKey(item)); } else { out.set(itemKey(item), item); }
  }
  return [...out.values()];
}

/**
 * What the reviewed contract's fns declared they create, update or remove in the hub: the fns of `before` as an admin
 * approved them. A fn waiting for review counts as its live version (none when it is new), and a runtime addition that
 * went live without an admin (`LiveContract.runtime`) counts not at all, so nothing a system sends covers itself.
 */
export function reviewedEffects(before: Manifest, review: Pick<SystemReviewRecord, 'live' | 'pending'> | undefined): RegistryEffect[] {
  const waiting = new Map((review?.pending?.changes ?? []).filter((change) => change.section === 'fns').map((change) => [change.name, change]));
  const unreviewed = new Set((review?.live?.runtime ?? []).filter((item) => item.section === 'fns').map((item) => item.name));
  return before.fns.flatMap((decl) => {
    const name = qualify(before.name, decl.name);
    if (unreviewed.has(name)) { return []; }
    const change = waiting.get(name);
    const live = change === undefined ? decl : FnDecl.safeParse(change.before).data;
    return live?.effects?.registry ?? [];
  });
}

/** Installed vs live, reviews and per-item switches, on the hub's store. */
export class SystemLifecycle {
  readonly #options: LifecycleOptions;
  /** Every read-modify-write of a review row, one at a time, so two manifests or an approve at once lose nothing. */
  readonly #reviews = new Serial();

  constructor(options: LifecycleOptions) {
    this.#options = options;
  }

  /** The stage a newly paired system starts at. */
  get firstStage(): SystemStage {
    return this.#options.settings.HARNESS_REVIEW_SYSTEMS ? 'installed' : 'live';
  }

  /** A system's stage; rows from before build 7 have none and are live. */
  async stage(system: SystemName): Promise<SystemStage> {
    return (await this.#options.store.table('systems').get(system))?.stage ?? 'live';
  }

  /** The review row of a system. */
  review(system: SystemName): Promise<SystemReviewRecord | undefined> {
    return this.#options.store.table('systemReviews').get(system);
  }

  /** The fns, context items and parts held off by pending reviews, by section, across every system. */
  async held(section?: ItemSection): Promise<Set<string>> {
    const out = new Set<string>();
    for (const row of await allRows(this.#options.store.table('systemReviews'))) {
      for (const change of row.pending?.changes ?? []) {
        if (change.change !== 'removed' && change.section !== 'grants' && change.section !== 'config' && (section === undefined || change.section === section)) { out.add(change.name); }
      }
    }
    return out;
  }

  /**
   * The items switched off (`itemSwitches`) in one section, across every system or for one: what the hub leaves out
   * wherever it offers that section. Pending items are added unless `switchedOnly`.
   */
  async off(section: ItemSection, options: { system?: SystemName; switchedOnly?: boolean } = {}): Promise<Set<string>> {
    const rows = await allRows(this.#options.store.table('itemSwitches'), { section, ...(options.system === undefined ? {} : { system: options.system }) });
    const out = new Set(rows.map((row) => row.name));
    if (options.switchedOnly !== true) { for (const name of await this.held(section)) { out.add(name); } }
    return out;
  }

  /** Every item of a system that is off: its own switches, its fns and context switched off, and what waits for review. */
  async offItems(system: SystemName): Promise<ItemRef[]> {
    const { store } = this.#options;
    const [switches, fns, context, review] = await Promise.all([
      allRows(store.table('itemSwitches'), { system }), allRows(store.table('fns'), { system }), allRows(store.table('context'), { system }), this.review(system),
    ]);
    const out = new Map<string, ItemRef>();
    const add = (item: ItemRef): void => { out.set(itemKey(item), item); };
    for (const row of switches) { add({ section: row.section, name: row.name }); }
    for (const fn of fns) { if (fn.disabled) { add({ section: 'fns', name: fn.name }); } }
    for (const item of context) { if (item.disabled === true) { add({ section: 'context', name: item.name }); } }
    for (const change of review?.pending?.changes ?? []) {
      const item = change.change === 'removed' ? undefined : itemOf(change);
      if (item !== undefined) { add(item); }
    }
    return [...out.values()];
  }

  /** Switch one item (not a fn or context item, which have their own flag) on or off. */
  async switchPart(part: SwitchPart, by: ActorId): Promise<{ on: boolean }> {
    const { store, log, clock, catalog, bus } = this.#options;
    if (await store.table('systems').get(part.system) === undefined) { throw refuse(404, 'NO_SYSTEM', `no system ${part.system}`); }
    const table = store.table('itemSwitches');
    if (part.on) { await table.remove({ system: part.system, section: part.section, name: part.name }); }
    else { await table.put({ system: part.system, section: part.section, name: part.name, by, at: clock() }); }
    // a kind switched off takes its fns with it
    if (part.section === 'kinds') { await catalog.refreshAvailability(part.system); }
    // a root switched back on is crawled again
    if (part.section === 'roots' && part.on) { await this.#refreshResources(part.system); }
    bus.publish('capabilities.changed', {});
    log.info('system.part.switched', { system: part.system, section: part.section, name: part.name, on: part.on, by });
    return { on: part.on };
  }

  /** Put the given items off, and every other item of the system that is off by an admin switch back on. */
  async #applyOff(system: SystemName, off: readonly ItemRef[], by: ActorId, among?: ReadonlySet<string>): Promise<void> {
    const { store, clock } = this.#options;
    const wanted = new Set(off.map(itemKey));
    const touched = (item: ItemRef): boolean => among === undefined || among.has(itemKey(item));
    await store.tx(async (tx) => {
      for (const fn of await allRows(tx.table('fns'), { system })) {
        const item: ItemRef = { section: 'fns', name: fn.name };
        if (touched(item) && fn.disabled !== wanted.has(itemKey(item))) { await tx.table('fns').update(fn.name, { disabled: wanted.has(itemKey(item)) }); }
      }
      for (const row of await allRows(tx.table('context'), { system })) {
        const item: ItemRef = { section: 'context', name: row.name };
        if (touched(item) && (row.disabled === true) !== wanted.has(itemKey(item))) { await tx.table('context').update(row.name, { disabled: wanted.has(itemKey(item)) }); }
      }
      for (const row of await allRows(tx.table('itemSwitches'), { system })) {
        if (touched(row) && !wanted.has(itemKey(row))) { await tx.table('itemSwitches').remove({ system, section: row.section, name: row.name }); }
      }
      for (const item of off) {
        if (item.section !== 'fns' && item.section !== 'context') { await tx.table('itemSwitches').put({ system, section: item.section, name: item.name, by, at: clock() }); }
      }
    });
  }

  /** The stored manifest, refused when its hash is no longer the one the admin reviewed. */
  async #reviewed(system: SystemName, hash: string): Promise<Manifest> {
    const manifest = await this.#options.catalog.manifest(system);
    if (manifest === undefined) { throw refuse(404, 'NO_CONTRACT', `${system} hasn't sent its contract yet`); }
    if (manifest.hash !== hash) { throw refuse(409, 'CONTRACT_MOVED', `${system}'s contract changed since you reviewed it: review it again`); }
    return manifest;
  }

  /** Go live: save the reviewed contract and the items kept off, then offer everything else. */
  goLive(request: GoLiveRequest, by: ActorId): Promise<{ stage: SystemStage; hash: string }> {
    return this.#reviews.run(() => this.#goLive(request, by));
  }

  async #goLive(request: GoLiveRequest, by: ActorId): Promise<{ stage: SystemStage; hash: string }> {
    const { store, catalog, clock, log, bus } = this.#options;
    const record = await store.table('systems').get(request.system);
    if (record === undefined) { throw refuse(404, 'NO_SYSTEM', `no system ${request.system}`); }
    if ((record.stage ?? 'live') === 'live' && (await this.review(request.system))?.live !== undefined) { throw refuse(409, 'ALREADY_LIVE', `${request.system} is live already`); }
    const manifest = await this.#reviewed(request.system, request.hash);
    await this.#applyOff(request.system, request.off, by);
    const live: LiveContract = { version: manifest.version, hash: manifest.hash, grants: manifest.grants ?? { hub: [] }, runtime: [], by, at: clock() };
    const existing = await this.review(request.system);
    await store.table('systemReviews').put({ ...(existing ?? {}), system: request.system, live, updatedAt: clock() });
    await store.table('systems').update(request.system, { stage: 'live' });
    // its context was off while installed; it follows the system's context switch from now on
    await store.tx(async (tx) => {
      for (const item of await allRows(tx.table('context'), { system: request.system })) { await tx.table('context').update(item.name, { systemOff: record.enabled.context === false }); }
    });
    await catalog.refreshAvailability(request.system);
    await this.#refreshResources(request.system);
    bus.publish('capabilities.changed', {});
    log.info('system.live', { system: request.system, hash: manifest.hash, off: request.off.length, by });
    return { stage: 'live', hash: manifest.hash };
  }

  /** Approve a pending review: what waited becomes live, except the items kept off. */
  approve(request: GoLiveRequest, by: ActorId): Promise<{ hash: string }> {
    return this.#reviews.run(() => this.#approve(request, by));
  }

  async #approve(request: GoLiveRequest, by: ActorId): Promise<{ hash: string }> {
    const { store, catalog, clock, log, bus } = this.#options;
    const review = await this.review(request.system);
    if (review?.pending === undefined) { throw refuse(409, 'NOTHING_PENDING', `${request.system} has no changes waiting`); }
    if (review.pending.hash !== request.hash) { throw refuse(409, 'CONTRACT_MOVED', `${request.system}'s changes moved since you reviewed them: review them again`); }
    const manifest = await this.#reviewed(request.system, request.hash);
    const among = new Set(review.pending.changes.flatMap((change) => { const item = itemOf(change); return item === undefined ? [] : [itemKey(item)]; }));
    await this.#applyOff(request.system, request.off, by, among);
    const live: LiveContract = {
      version: manifest.version, hash: manifest.hash, grants: manifest.grants ?? { hub: [] }, runtime: foldRuntime(review.live?.runtime ?? [], review.pending.changes), by, at: clock(),
    };
    const { pending: _approved, ...rest } = review;
    await store.table('systemReviews').put({ ...rest, live, updatedAt: clock() });
    await catalog.refreshAvailability(request.system);
    bus.publish('capabilities.changed', {});
    log.info('system.review.approved', { system: request.system, hash: manifest.hash, changes: review.pending.changes.length, by });
    return { hash: manifest.hash };
  }

  /** Drop a pending review: the live version stays, and what waited stays off (switched off by the admin). */
  reject(system: SystemName, hash: string, by: ActorId): Promise<{ ok: boolean }> {
    return this.#reviews.run(() => this.#reject(system, hash, by));
  }

  async #reject(system: SystemName, hash: string, by: ActorId): Promise<{ ok: boolean }> {
    const { store, catalog, clock, log, bus } = this.#options;
    const review = await this.review(system);
    if (review?.pending === undefined) { throw refuse(409, 'NOTHING_PENDING', `${system} has no changes waiting`); }
    if (review.pending.hash !== hash) { throw refuse(409, 'CONTRACT_MOVED', `${system}'s changes moved since you reviewed them: review them again`); }
    const off = review.pending.changes.filter((change) => change.change !== 'removed').flatMap((change) => { const item = itemOf(change); return item === undefined ? [] : [item]; });
    const kept = await this.offItems(system);
    const { pending: _dropped, ...rest } = review;
    await store.table('systemReviews').put({ ...rest, ...(review.live === undefined ? {} : { live: { ...review.live, hash: review.pending.hash } }), updatedAt: clock() });
    await this.#applyOff(system, [...kept, ...off], by);
    await catalog.refreshAvailability(system);
    bus.publish('capabilities.changed', {});
    log.info('system.review.rejected', { system, hash, changes: review.pending.changes.length, by });
    return { ok: true };
  }

  /**
   * A live system's contract moved from `before` to `after` (a manifest or patch was imported). Runtime additions its
   * fns declared are approved at once; everything else waits in its pending review, held off until approved.
   */
  contractChanged(system: SystemName, before: Manifest | undefined, after: Manifest | undefined): Promise<void> {
    return this.#reviews.run(() => this.#contractChanged(system, before, after));
  }

  async #contractChanged(system: SystemName, before: Manifest | undefined, after: Manifest | undefined): Promise<void> {
    const { store, catalog, clock, log, settings, bus } = this.#options;
    if (after === undefined || before?.hash === after.hash) { return; }
    const record = await store.table('systems').get(system);
    if (record === undefined || (record.stage ?? 'live') === 'installed') { return; }
    const review = await this.review(system);
    // a system live from before build 7 adopts what it had as its reviewed baseline
    const live: LiveContract = review?.live ?? {
      version: before?.version ?? after.version, hash: before?.hash ?? after.hash, grants: before?.grants ?? after.grants ?? { hub: [] }, runtime: [], by: record.actor, at: clock(),
    };
    if (before === undefined || !settings.HARNESS_REVIEW_SYSTEMS) {
      await store.table('systemReviews').put({ ...(review ?? {}), system, live: { ...live, hash: after.hash, version: after.version, grants: after.grants ?? live.grants }, updatedAt: clock() });
      return;
    }
    const declared = reviewedEffects(before, review);
    const changes = contractChanges(before, after);
    const covered = changes.filter((change) => this.#covered(change, declared));
    const waiting = mergeChanges(review?.pending?.changes ?? [], changes.filter((change) => !covered.includes(change)));
    const nextLive: LiveContract = { ...live, runtime: foldRuntime(live.runtime, covered), ...(waiting.length === 0 ? { hash: after.hash, version: after.version } : {}) };
    const pending: PendingReview | undefined = waiting.length === 0 ? undefined : {
      version: after.version, hash: after.hash, by: waiting.every((change) => change.origin === 'runtime') ? 'runtime' : 'contract', changes: waiting, since: review?.pending?.since ?? clock(),
    };
    const { pending: _old, ...rest } = review ?? { system, updatedAt: clock() };
    await store.table('systemReviews').put({ ...rest, system, live: nextLive, ...(pending === undefined ? {} : { pending }), updatedAt: clock() });
    // context waiting for approval is off by itself until then (approving puts back what the admin keeps on)
    for (const change of waiting) {
      if (change.section !== 'context' || change.change === 'removed') { continue; }
      const name = QualifiedName.parse(change.name);
      if (await store.table('context').get(name) !== undefined) { await store.table('context').update(name, { disabled: true }); }
    }
    if (pending !== undefined || review?.pending !== undefined) {
      await catalog.refreshAvailability(system);
      bus.publish('capabilities.changed', {});
    }
    if (pending !== undefined) { log.info('system.review.pending', { system, hash: after.hash, changes: waiting.length }); }
  }

  /** Ask the system for its roots again (when it is away, its next connect does). */
  async #refreshResources(system: SystemName): Promise<void> {
    try { await this.#options.resources?.().refresh(system); } catch (error) {
      this.#options.log.warn('system.resources.refresh-failed', { system, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Copy the install checks from the install run's approval onto the system's review. */
  setChecks(system: SystemName, checks: NonNullable<SystemReviewRecord['checks']>): Promise<void> {
    const { store, clock } = this.#options;
    return this.#reviews.run(async () => {
      const review = await this.review(system);
      await store.table('systemReviews').put({ ...(review ?? {}), system, checks, updatedAt: clock() });
    });
  }

  /** Whether a change is a runtime addition one of the system's fns declared. */
  #covered(change: ContractChange, declared: readonly RegistryEffect[]): boolean {
    if (change.origin !== 'runtime') { return false; }
    const thing = SECTION_THINGS[change.section];
    if (thing === undefined) { return false; }
    const after = change.after;
    const kind = change.section === 'fns' && typeof after === 'object' && after !== null && !Array.isArray(after) ? FnKindName.safeParse(after['kind']).data : undefined;
    const action = change.change === 'added' ? 'create' : change.change === 'changed' ? 'update' : 'remove';
    return effectCovered(declared, { thing, action, ...(kind === undefined ? {} : { kind }) });
  }
}
