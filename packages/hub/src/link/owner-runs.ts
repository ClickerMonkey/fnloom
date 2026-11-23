/**
 * Runs a system starts by itself, as the owners of its kinds' fns, and the notices it sends people (`runs` grant;
 * `ctx.runs` and `ctx.notify` in the SDK). Nothing here names a system: any system with a kind may use it.
 *
 * - `kindFns`: the saved fns of one of the asking system's kinds, with owner, title, version and payload, a page at a
 *   time, optionally only those changed (or removed) since a time.
 * - `startRun`: a run of one of those fns as its owner, outside any chat, in a sessionless turn of the owner's (limits
 *   resolved for its priority, `background` by default, lowered by `maxSpend`), with the system's actor as its caller,
 *   so policies, approvals, budgets and the ledger apply as at any call. Refused unless the fn is of the system's own
 *   kind, the system is live and its owner can still use the hub. The same `key` is the same run: a retried or doubled
 *   start returns the first one's run (the runs are looked up by key, and starts of one key wait for each other).
 * - `notifyOwner`: an inbox item and push to the owner of one of those fns, never anyone else.
 * - `notify`: the same to the person a run of the system is for (`ctx.notify`); the run and the runs above it are
 *   then marked as having notified, which the settled run event says (`notified`).
 *
 * A notice's links lead to a run of the person's or to one of the system's own declared pages; its body is clamped to
 * `NOTIFICATION_BODY`, and its key is kept per system, so two systems' keys never replace each other's notices.
 */
import { reject as refuse, spec } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { plugin } from '@ayepi/plugin';
import {
  clamp, fnLabel, hubLinkSpec, instanceLabel, isSettled, mintId, NOTIFICATION_BODY, QualifiedName, UserView,
  type ActorId, type FnRecord, type KindFnsPage, type KindFnsQuery, type KindFnWire, type LinkSession, type Notification, type NotificationLink, type Run,
  type RunId, type StartAsOwner, type StartedRun, type SystemName, type SystemNotice, type Turn,
} from '@harness/core';
import type { AccessService } from '../access/index.ts';
import { userInfo } from '../api/web/access.ts';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { itemVersionCount } from '../catalog/versions.ts';
import type { NotificationInput, NotificationService } from '../chat/index.ts';
import type { LimitResolver, RunService } from '../execution/index.ts';
import { runIsOf, type LinkHandler } from '../execution/link-handlers.ts';
import { timeInfo } from '../execution/time.ts';
import type { HubStore } from '../store/index.ts';

const endpoints = hubLinkSpec.endpoints;

/** The slice of the hub link this module answers. */
export const OWNER_RUNS_SPEC = spec({
  endpoints: { kindFns: endpoints.kindFns, startRun: endpoints.startRun, notifyOwner: endpoints.notifyOwner, notify: endpoints.notify },
});

/** An endpoint this module answers. */
export type OwnerRunsEndpoint = keyof (typeof OWNER_RUNS_SPEC)['endpoints'];

/** The key prefix of a run a system started as a fn's owner (`startRun`), apart from every other run's key. */
export const STARTED_KEY = 'start:';

/** How many fns `kindFns` gives when the asker names no limit. */
const KIND_FNS_DEFAULT = 50;

/** How many removed fns one `changedSince` page looks back over. */
const REMOVED_WINDOW = 200;

/** How many runs up a tree a notice marks as having notified. */
const MAX_DEPTH = 32;

/** What the module reads and does, each looked up when a call arrives. */
export interface OwnerRunDeps {
  readonly store: () => HubStore;
  readonly catalog: () => Pick<Catalog, 'fn' | 'kind'>;
  readonly runs: () => Pick<RunService, 'start' | 'get'>;
  readonly limits: () => Pick<LimitResolver, 'resolve'>;
  readonly notifications: () => Pick<NotificationService, 'notify'>;
  /** Who owns each saved fn. */
  readonly sharing: () => Pick<AccessService, 'sharing'>;
  readonly bus: () => Pick<EventBus, 'publish'>;
  readonly clock: () => number;
  readonly log: Logger;
}

/** Runs and notices a system starts by itself. */
export class OwnerRuns {
  readonly #deps: OwnerRunDeps;
  /** Starts in progress by key, so a doubled start waits for the first and gets its run. */
  readonly #starting = new Map<string, Promise<StartedRun>>();

  constructor(deps: OwnerRunDeps) {
    this.#deps = deps;
  }

  /** The saved fns of one of the asking system's kinds, a page at a time. */
  async kindFns(link: LinkSession, query: KindFnsQuery): Promise<KindFnsPage> {
    await this.#ownKind(link, query.kind);
    const store = this.#deps.store();
    const page = await store.table('fnLinks').find({ where: { to: query.kind, link: 'kind' }, limit: query.limit ?? KIND_FNS_DEFAULT, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) });
    const items: KindFnWire[] = [];
    for (const row of page.items) {
      const fn = await this.#deps.catalog().fn(row.fn);
      // only saved fns have an owner to run as; a contract's own fns of the kind are its system's
      if (fn?.origin !== 'runtime') continue;
      if (query.changedSince !== undefined && fn.updatedAt < query.changedSince) continue;
      items.push(await this.#wire(fn));
    }
    // the first page of a "what changed" read also says which were removed since
    const removed = query.changedSince === undefined || query.cursor !== undefined ? [] : await this.#removedSince(link.system, query.kind, query.changedSince);
    return { items: [...removed, ...items], ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
  }

  /** Start a run of a fn of the asking system's kind as its owner; the same key gives the same run. */
  async start(link: LinkSession, input: StartAsOwner): Promise<StartedRun> {
    const fn = await this.#ownFn(link, input.fn);
    const key = `${STARTED_KEY}${link.system}:${input.key}`;
    const lock = `${fn.name}\u0000${key}`;
    const going = this.#starting.get(lock);
    if (going !== undefined) return going;
    const started = this.#start(link, fn, key, input).finally(() => { this.#starting.delete(lock); });
    this.#starting.set(lock, started);
    return started;
  }

  /** Tell the owner of a fn of the asking system's kind something, and no one else. */
  async notifyOwner(link: LinkSession, name: QualifiedName, notice: SystemNotice): Promise<void> {
    const fn = await this.#ownFn(link, name);
    const owner = await this.#activeOwner(fn);
    await this.#send(link, owner, notice, { system: link.system });
  }

  /** Tell the person a run of the asking system is for something, and mark the run tree as having notified. */
  async notify(link: LinkSession, id: RunId, notice: SystemNotice): Promise<void> {
    const store = this.#deps.store();
    const run = await store.table('runs').get(id);
    if (run === undefined || !runIsOf(run, link)) throw refuse(403, 'NOT_YOUR_RUN', `run ${id} is not ${instanceLabel(link)}'s`);
    if (isSettled(run.status)) throw refuse(403, 'RUN_SETTLED', `run ${id} has settled`);
    const person = (await store.table('turns').get(run.turn))?.user.id ?? run.actor;
    // from a run, a notice with no link leads to that run
    await this.#send(link, person, notice, { run: run.id });
    this.#deps.bus().publish('run.notified', { runs: await this.#above(run) });
  }

  async #start(link: LinkSession, fn: FnRecord, key: string, input: StartAsOwner): Promise<StartedRun> {
    const { store, log } = this.#deps;
    const before = await this.#startedBefore(fn.name, key);
    if (before !== undefined) return { run: before.id, turn: before.turn, status: before.status };
    await this.#live(link.system);
    const owner = await this.#activeOwner(fn);
    const systemActor = (await store().table('systems').get(link.system))?.actor;
    if (systemActor === undefined) throw refuse(403, 'NO_SYSTEM_ACTOR', `${link.system} has no actor to start runs as`);
    const turn = await this.#turn(owner, input);
    let started: { run: RunId; settled: Promise<unknown> };
    try {
      started = await this.#deps.runs().start({
        fn: fn.name, args: input.args, turn: turn.id, key, actor: owner, caller: systemActor, priority: turn.limits.priority, background: false, handlers: [],
      });
    } catch (error) {
      await this.#end(turn, 'failed');
      log.info('runs.start.refused', { system: link.system, fn: fn.name, reason: messageOf(error) });
      throw refuse(409, 'START_REFUSED', messageOf(error));
    }
    await store().table('turns').update(turn.id, { root: started.run });
    // the turn ends with its run
    void started.settled.then(
      async () => { const run = await this.#deps.runs().get(started.run); await this.#end(turn, run?.status === 'done' ? 'done' : run?.status === 'cancelled' ? 'cancelled' : 'failed'); },
      async () => { await this.#end(turn, 'failed'); },
    ).catch((error: unknown) => { log.warn('runs.turn.end.failed', { turn: turn.id, error: messageOf(error) }); });
    log.info('runs.started', { system: link.system, fn: fn.name, run: started.run, owner });
    const run = await this.#deps.runs().get(started.run);
    return { run: started.run, turn: turn.id, status: run?.status ?? 'queued' };
  }

  /** A sessionless turn for the owner, with their limits for the priority asked, lowered by the cap. */
  async #turn(owner: ActorId, input: StartAsOwner): Promise<Turn> {
    const store = this.#deps.store();
    const actor = await store.table('actors').get(owner);
    if (actor?.kind !== 'user' || actor.disabled) throw refuse(409, 'OWNER_GONE', 'the fn\'s owner can no longer use the hub');
    const user = await userInfo({ store }, UserView.parse(actor));
    const limits = await this.#deps.limits().resolve({ user, requested: input.priority ?? 'background' });
    const turnLimits = input.maxSpend === undefined ? limits : { ...limits, turn: { ...limits.turn, cost: Math.min(limits.turn.cost, input.maxSpend) } };
    const now = this.#deps.clock();
    return store.table('turns').insert({
      id: mintId('turn'), actor: owner, user, time: timeInfo(now, user.timeZone), status: 'running', limits: turnLimits, cost: 0, errors: { max: 1 }, createdAt: now,
    });
  }

  async #end(turn: Turn, status: 'done' | 'failed' | 'cancelled'): Promise<void> {
    await this.#deps.store().table('turns').update(turn.id, { status, endedAt: this.#deps.clock() });
  }

  /** The run a start of this key already made, if one did (settled or not: the same key is the same run for good). */
  async #startedBefore(fn: QualifiedName, key: string): Promise<Run | undefined> {
    const page = await this.#deps.store().table('runs').find({ where: { fn, key }, limit: 10 });
    return page.items.find((run) => run.parent === undefined);
  }

  /** Refused unless the system's fns are live: reviewed and switched on. */
  async #live(system: SystemName): Promise<void> {
    const row = await this.#deps.store().table('systems').get(system);
    if (row === undefined || row.stage === 'installed' || !row.enabled.functions) throw refuse(409, 'NOT_LIVE', `${system} is not live, so it can't start runs`);
  }

  /** A fn's owner, refused when they can no longer use the hub. */
  async #activeOwner(fn: FnRecord): Promise<ActorId> {
    const { owner } = await this.#deps.sharing().sharing({ kind: 'fn', fn: fn.name });
    const actor = await this.#deps.store().table('actors').get(owner);
    if (actor?.kind !== 'user' || actor.disabled) throw refuse(409, 'OWNER_GONE', `${fn.name}'s owner can no longer use the hub`);
    return owner;
  }

  /** A kind of the asking system's own, or a refusal. */
  async #ownKind(link: LinkSession, kind: QualifiedName): Promise<void> {
    const record = await this.#deps.catalog().kind(kind);
    if (record === undefined) throw refuse(404, 'NO_KIND', `there is no kind ${kind}`);
    if (record.system !== link.system) throw refuse(403, 'NOT_YOUR_KIND', `${kind} is ${record.system}'s kind, not ${link.system}'s`);
  }

  /** A saved fn of one of the asking system's kinds, or a refusal. */
  async #ownFn(link: LinkSession, name: QualifiedName): Promise<FnRecord> {
    const fn = await this.#deps.catalog().fn(name);
    if (fn === undefined) throw refuse(404, 'NO_FN', `there is no fn ${name}`);
    if (fn.decl.kind === 'native') throw refuse(403, 'NOT_YOUR_KIND', `${name} is not of one of ${link.system}'s kinds`);
    await this.#ownKind(link, fn.decl.kind);
    if (fn.origin !== 'runtime') throw refuse(403, 'NOT_SAVED', `${name} is not a saved fn, so it has no owner to run as`);
    return fn;
  }

  /** A fn as `kindFns` lists it. */
  async #wire(fn: FnRecord): Promise<KindFnWire> {
    const { owner } = await this.#deps.sharing().sharing({ kind: 'fn', fn: fn.name });
    const version = Math.max(1, await itemVersionCount(this.#deps.store(), fn.system, 'fns', fn.name));
    return { fn: fn.name, kind: fnKind(fn), owner, title: fnLabel(fn.name), version, payload: fn.decl.payload ?? null, removed: false, updatedAt: fn.updatedAt };
  }

  /** The fns of a kind removed since a time, each with the payload it last had. */
  async #removedSince(system: SystemName, kind: QualifiedName, since: number): Promise<KindFnWire[]> {
    const store = this.#deps.store();
    const page = await store.table('itemVersions').find({ where: { system, section: 'fns', change: 'removed', savedAt: { gte: since } }, limit: REMOVED_WINDOW });
    const out: KindFnWire[] = [];
    for (const version of page.items) {
      const decl = version.decl;
      const name = QualifiedName.safeParse(version.name);
      if (!name.success || typeof decl !== 'object' || decl === null || Array.isArray(decl) || decl['kind'] !== kind) continue;
      // removed and saved again since: it is listed as it is now, not as removed
      if (await this.#deps.catalog().fn(name.data) !== undefined) continue;
      const { owner } = await this.#deps.sharing().sharing({ kind: 'fn', fn: name.data });
      out.push({ fn: name.data, kind, owner, title: fnLabel(name.data), version: version.number, payload: decl['payload'] ?? null, removed: true, updatedAt: version.savedAt });
    }
    return out;
  }

  /** Send one notice to one person, its links checked and its key kept per system. */
  async #send(link: LinkSession, user: ActorId, notice: SystemNotice, fallback: NotificationLink): Promise<Notification> {
    const main = notice.link ?? fallback;
    await this.#checkLink(link, user, main);
    if (notice.also !== undefined) await this.#checkLink(link, user, notice.also.link);
    const input: NotificationInput = {
      user, reason: 'system-message', title: notice.title, body: clamp(notice.body, NOTIFICATION_BODY), link: main,
      ...(notice.tone === undefined ? {} : { tone: notice.tone }),
      ...(notice.also === undefined ? {} : { also: notice.also }),
      ...(notice.key === undefined ? {} : { key: `${link.system}:${notice.key}` }),
    };
    return this.#deps.notifications().notify(input);
  }

  /** A notice leads only to a run of its person's, to the system's own page, or to one of its declared pages. */
  async #checkLink(link: LinkSession, user: ActorId, target: NotificationLink): Promise<void> {
    if ('run' in target) {
      const run = await this.#deps.store().table('runs').get(target.run);
      const person = run === undefined ? undefined : (await this.#deps.store().table('turns').get(run.turn))?.user.id ?? run.actor;
      if (person !== user) throw refuse(403, 'NOT_THEIR_RUN', `run ${target.run} is not the notified person's`);
      return;
    }
    if ('system' in target) {
      if (target.system !== link.system) throw refuse(403, 'NOT_YOUR_PAGE', `a notice from ${link.system} may lead to its own page, not ${target.system}'s`);
      return;
    }
    if ('page' in target) {
      if (target.page.system !== link.system) throw refuse(403, 'NOT_YOUR_PAGE', `a notice from ${link.system} may lead to its own pages, not ${target.page.system}'s`);
      const pages = (await this.#deps.store().table('manifests').get(link.system))?.manifest.pages ?? [];
      if (!pages.some((page) => page.segment === target.page.segment)) throw refuse(422, 'NO_PAGE', `${link.system} declares no page ${target.page.segment}`);
      return;
    }
    throw refuse(422, 'BAD_LINK', 'a notice leads to a run, to the system\'s page or to one of its pages');
  }

  /** A run and the runs above it, nearest first. */
  async #above(run: Run): Promise<RunId[]> {
    const ids: RunId[] = [];
    let at: Run | undefined = run;
    for (let depth = 0; at !== undefined && depth < MAX_DEPTH; depth++) {
      ids.push(at.id);
      at = at.parent === undefined ? undefined : await this.#deps.store().table('runs').get(at.parent);
    }
    return ids;
  }
}

/** A kind fn's kind (never `native` here: only kind fns are listed). */
function fnKind(fn: FnRecord): QualifiedName {
  return QualifiedName.parse(fn.decl.kind);
}

/** An error's message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The handlers: each endpoint's body handed to its `OwnerRuns` method. */
export function ownerRunHandlers(runs: OwnerRuns): { [K in OwnerRunsEndpoint]: LinkHandler<K> } {
  return {
    kindFns: ({ data, link }) => runs.kindFns(link, data),
    startRun: ({ data, link }) => runs.start(link, data),
    notifyOwner: ({ data, link }) => runs.notifyOwner(link, data.fn, data.notice),
    notify: ({ data, link }) => runs.notify(link, data.run, data.notice),
  };
}

/** The module as a link plugin. */
export function ownerRunsPlugin(deps: OwnerRunDeps) {
  const runs = new OwnerRuns(deps);
  return plugin({ name: 'link.owner-runs', spec: OWNER_RUNS_SPEC }).handlers(() => ownerRunHandlers(runs));
}
