/**
 * Visibility on the hub store: the `access` rows (kept in memory, they are few and read on every request), the people
 * and groups they name, and the per-person connections' own sharing (a connection's `share`, not an `access` row).
 */
import { reject } from '@ayepi/core';
import {
  accessKey, isUnsettled, qualify, type AccessInfo, type AccessRecord, type AccessTarget, type AccessView, type ActorId, type FnShare, type FnUsable, type Sharing, type ShareRule, type SystemName, type UserConnection,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { allRows } from '../catalog/rows.ts';
import type { HubStore } from '../store/index.ts';
import type { AccessScope, AccessService, ConnectionGate } from './index.ts';
import { ActorScope, letsIn } from './scope.ts';

/** What the access service reads. */
export interface AccessDeps {
  readonly store: HubStore;
  readonly bus: Pick<EventBus, 'publish'>;
  readonly clock: () => number;
  readonly catalog: Pick<Catalog, 'fn' | 'context'>;
  /** The owner of things nobody added by hand (systems, roots, declared context). */
  readonly hubActor: ActorId;
  /** How a person's per-person fns stand (the connections module). */
  readonly gate: (actor: ActorId, groups: ReadonlySet<ActorId>) => Promise<ConnectionGate>;
  /** The system serving a resource URI, when one does. */
  readonly systemOf: (uri: string) => string | undefined;
}

/** Visibility over the store. */
export class StoreAccessService implements AccessService {
  readonly #deps: AccessDeps;
  #rows: Promise<Map<string, AccessRecord>> | undefined;

  constructor(deps: AccessDeps) {
    this.#deps = deps;
  }

  async info(): Promise<AccessInfo> {
    return { multiUser: (await this.#deps.store.table('actors').count({ kind: 'user', disabled: false })) > 1 };
  }

  async scope(actor: ActorId): Promise<AccessScope> {
    const [person, groups, rows] = await Promise.all([this.#deps.store.table('actors').get(actor), this.#groups(actor), this.#load()]);
    const admin = person?.kind === 'user' && person.role === 'admin';
    return new ActorScope({ actor, admin, groups, rows, gate: await this.#deps.gate(actor, groups), systemOf: this.#deps.systemOf });
  }

  async sharing(target: AccessTarget): Promise<Sharing> {
    if (target.kind === 'connection') {
      const connection = await this.#connection(target);
      return { owner: connection.owner, ...connection.share };
    }
    const row = (await this.#load()).get(accessKey(target));
    return row?.sharing ?? { owner: await this.#ownerOf(target), visibility: 'public', with: [] };
  }

  async views(asker: ActorId, targets: readonly AccessTarget[]): Promise<AccessView[]> {
    const scope = await this.scope(asker);
    const views: AccessView[] = [];
    for (const target of targets) {
      if (target.kind === 'connection') {
        const connection = await this.#store().connections.get(target.connection);
        if (connection === undefined || !(scope.admin || letsIn({ owner: connection.owner, ...connection.share }, asker, await this.#groups(asker)))) continue;
        views.push({ target, sharing: { owner: connection.owner, ...connection.share }, editable: scope.admin || connection.owner === asker });
        continue;
      }
      if (!scope.sees(target)) continue;
      const sharing = await this.sharing(target);
      views.push({ target, sharing, editable: scope.admin || sharing.owner === asker });
    }
    return views;
  }

  async set(asker: ActorId, target: AccessTarget, rule: ShareRule): Promise<AccessView> {
    const scope = await this.scope(asker);
    const current = await this.sharing(target);
    if (!scope.admin && current.owner !== asker) { throw reject(403, 'NOT_OWNER', 'only its owner or an admin can change who sees this'); }
    await this.#exists(target);
    return this.#write(target, current.owner, rule, asker);
  }

  async give(system: SystemName, share: FnShare): Promise<AccessView> {
    const run = await this.#runOf(system, share.run);
    const target: AccessTarget = { kind: 'fn', fn: qualify(system, share.fn) };
    await this.#exists(target);
    const current = (await this.#load()).get(accessKey(target));
    if (current !== undefined && current.sharing.owner !== run.actor) { throw reject(403, 'NOT_OWNER', `${target.fn} belongs to someone else`); }
    return this.#write(target, run.actor, share.share, run.actor);
  }

  async own(target: AccessTarget, owner: ActorId, rule: ShareRule): Promise<AccessView> {
    const current = (await this.#load()).get(accessKey(target));
    const same = current?.sharing.owner === owner && current.sharing.visibility === rule.visibility && current.sharing.with.join() === rule.with.join();
    if (current !== undefined && same) return { target, sharing: current.sharing, editable: true };
    return this.#write(target, owner, rule, this.#deps.hubActor);
  }

  async usable(system: SystemName, query: FnUsable): Promise<string[]> {
    const run = await this.#runOf(system, query.run);
    const scope = await this.scope(run.actor);
    return query.fns.filter((fn) => scope.mayUse({ name: qualify(system, fn), system }));
  }

  /** A run of `system` that is still going; refused otherwise. */
  async #runOf(system: SystemName, id: FnShare['run']): Promise<{ readonly actor: ActorId }> {
    const run = await this.#deps.store.table('runs').get(id);
    if (run?.system !== system || !isUnsettled(run.status)) { throw reject(403, 'NOT_YOUR_RUN', `run ${id} is not a running fn of ${system}`); }
    return run;
  }

  /** Refuse a fn or context target that doesn't exist (a row for a name nobody uses would wait for one that might). */
  async #exists(target: AccessTarget): Promise<void> {
    const found = target.kind === 'fn' ? await this.#deps.catalog.fn(target.fn) : target.kind === 'context' ? await this.#deps.catalog.context(target.context) : true;
    if (found === undefined) { throw reject(404, 'NOT_FOUND', `nothing is named ${target.kind === 'fn' ? target.fn : target.kind === 'context' ? target.context : ''}`); }
  }

  async #write(target: AccessTarget, owner: ActorId, rule: ShareRule, by: ActorId): Promise<AccessView> {
    const shared: ShareRule = { visibility: rule.visibility, with: rule.visibility === 'shared' ? [...new Set(rule.with)] : [] };
    if (target.kind === 'connection') {
      await this.#store().connections.update(target.connection, { share: shared, updatedAt: this.#deps.clock() });
    } else {
      const record: AccessRecord = { key: accessKey(target), target, sharing: { owner, ...shared }, setBy: by, updatedAt: this.#deps.clock() };
      await this.#store().access.put(record);
      (await this.#load()).set(record.key, record);
    }
    // what each person may see changed: browsers fetch their composer's options again
    this.#deps.bus.publish('capabilities.changed', {});
    return { target, sharing: { owner, ...shared }, editable: true };
  }

  #store() {
    return { access: this.#deps.store.table('access'), connections: this.#deps.store.table('connections') };
  }

  #load(): Promise<Map<string, AccessRecord>> {
    this.#rows ??= allRows(this.#deps.store.table('access')).then((rows) => new Map(rows.map((row) => [row.key, row])));
    return this.#rows;
  }

  async #groups(actor: ActorId): Promise<ReadonlySet<ActorId>> {
    return new Set((await allRows(this.#deps.store.table('memberships'), { user: actor })).map((m) => m.group));
  }

  async #connection(target: Extract<AccessTarget, { kind: 'connection' }>): Promise<UserConnection> {
    const connection = await this.#store().connections.get(target.connection);
    if (connection === undefined) { throw reject(404, 'NOT_FOUND', `no connection ${target.connection}`); }
    return connection;
  }

  /** Who added a thing that has no row: a fn's or a memory's author, else the hub. */
  async #ownerOf(target: Exclude<AccessTarget, { kind: 'connection' }>): Promise<ActorId> {
    switch (target.kind) {
      case 'fn': return (await this.#deps.catalog.fn(target.fn))?.addedBy ?? this.#deps.hubActor;
      case 'context': {
        const origin = (await this.#deps.catalog.context(target.context))?.origin;
        return origin?.type === 'memory' ? origin.author : this.#deps.hubActor;
      }
      case 'system': case 'root': return this.#deps.hubActor;
    }
  }
}
