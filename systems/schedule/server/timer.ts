/**
 * The schedule system's timer (docs/plans/schedule-system.md, "Durability across restarts", "When a firing happens",
 * "What the owner is told"). It keeps each schedule's next firing on an `@ayepi/work` queue on SQLite in the
 * instance's data folder (one delayed `due` item per schedule, at the planned instant) and, when one is due, starts the
 * schedule fn as its owner with `ctx.runs.start` (key `schedule:<fn>@<instant>`, so a doubled start is the same run).
 *
 * - **Reconcile** at start and on `fns` events: every schedule fn from `ctx.runs.kindFns`, each one's next firing
 *   queued from the last instant it handled (so firings that fell due while the system was down come due at once).
 * - **Catching up** when a firing is due: every firing since the last one handled is due now; the latest runs (late)
 *   when it is on time, or within the grace window with `missed: 'latest'`; the rest are recorded as missed, and told
 *   as one notice (folded into the latest's when it runs).
 * - **Overlap**: a firing due while the last still runs is skipped (default), queued (at most one waits) or replaces it.
 * - **Approvals**: a firing whose target waits for approval waits until its next firing or `SCHEDULE_APPROVAL_WAIT`
 *   (then `expired`), or is refused at once when the admin's `approvals` says so.
 * - **Limits**: schedules per person and firings per person per day are refused with the reason; the gap between times
 *   is the kind's check.
 * - **Records and notices**: each firing is a `schedule/Firing` record of its owner's with its one-line summary; the
 *   owner is told by the rules in `summary.ts`, after the record is written, keyed per schedule.
 *
 * The kind's run (`runFiring`) is part of the timer too: it runs in this process, so it hands the timer the result,
 * the waits for approval and a way to cancel its target, with no round trip.
 */
import { ApiError, DISCONNECTED_STATUS } from '@ayepi/core';
import { sqliteBackend } from '@ayepi/sqlite';
import { createWork, defineWork, WorkDelayError } from '@ayepi/work';
import { splitName, type Json, type QualifiedName, type RunId, type RunStatus, type SystemEvent } from '@harness/core';
import type { KindFn, SystemImpl } from '@harness/sdk';
import { kindRunLookups } from '@harness/sdk/program';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { limitsOf, schedule, type Limits, type ScheduleContract } from '../shared/index.ts';
import { FiringShape, SchedulePayload, type Fire, type FiringStatus, type PreviousFiring } from '../shared/types.ts';
import { clockWords, dayWords, firingsBetween, fromOccurrenceKey, nextFirings, occurrenceKey, type Occurrence } from '../shared/when.ts';
import { localNow, localString, zonedTime } from '../shared/zoned.ts';
import { ArgsFailed, evaluateArgs } from './args.ts';
import type { ScheduleSettings } from './env.ts';
import { TimerStore, type EndReason, type FiringRow, type ScheduleRow } from './store.ts';
import { spanWords, summaryLine, tells, titleOf, toneOf } from './summary.ts';

type Impl = SystemImpl<ScheduleContract['defs']>;
/** The system context the timer acts in (lifecycle, events). */
export type ScheduleCtx = Parameters<NonNullable<NonNullable<Impl['lifecycle']>['started']>>[0];
/** A schedule fn's run context. */
export type ScheduleRunCtx = Parameters<Impl['kinds']['schedule']['run']>[2];
/** A schedule fn as `kindFns` lists it. */
export type ScheduleFn = KindFn<typeof schedule.kinds.schedule>;
/** What the kind's run returns. */
type RunOutcome = Awaited<ReturnType<Impl['kinds']['schedule']['run']>>;

/** The timer's queue: its work system and the two kinds of item on it. */
type TimerQueue = ReturnType<Timer['createQueue']>;

/** Where the time comes from: the wall clock, or a test's. */
export interface Clock {
  now(): number;
}

/** The wall clock. */
export const systemClock: Clock = { now: () => Date.now() };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** How far back the per-day firing limit counts. */
const PER_DAY = DAY;
/** Local firing rows are forgotten this long after they settled and were told (their records stay in the hub). */
const KEEP_ROWS = 3 * DAY;
/** How often a schedule's old firing records are pruned at most. */
const PRUNE_EVERY = DAY;
/** How far back `fns` events look for changed schedules (clocks of the hub and this system may differ a little). */
const SYNC_MARGIN = MINUTE;
/** A start of a firing that did not answer in time. */
class StartTimedOut extends Error {}

/** A firing's run's way to stop its target, in this process. */
interface Handle {
  cancel(reason: EndReason): Promise<void>;
}

/** What the timer is built from. */
export interface TimerDeps {
  readonly settings: ScheduleSettings;
  readonly clock?: Clock;
}

/** Schedule fns' payloads, read by the zod shapes (with their defaults and brands), once per listed fn. */
const payloads = new WeakMap<ScheduleFn, SchedulePayload>();

/** A schedule fn's payload as the zod shapes read it. */
function payloadOf(fn: ScheduleFn): SchedulePayload;
function payloadOf(fn: ScheduleFn | undefined): SchedulePayload | undefined;
function payloadOf(fn: ScheduleFn | undefined): SchedulePayload | undefined {
  if (fn === undefined) { return undefined; }
  let payload = payloads.get(fn);
  if (payload === undefined) {
    payload = SchedulePayload.parse(fn.payload);
    payloads.set(fn, payload);
  }
  return payload;
}

/** The id of a planned firing's row (and its start key's tail). */
const plannedId = (fn: string, at: number): string => `${fn}@${String(at)}`;

/** The local name of a schedule fn, for its page's path. */
const localOf = (fn: QualifiedName): string => splitName(fn).local;

/** A firing's day and time as people read them: "Mon, Nov 30 9:00 am". */
function whenWords(key: string): string {
  const { day, time } = fromOccurrenceKey(key);
  return time === undefined ? dayWords(day) : `${dayWords(day)} ${clockWords(time)}`;
}

/** Whether a hub error refuses (it won't start, whatever is retried), and why; `undefined` for an unreachable hub. */
function refusalOf(error: unknown): { message: string; code: string } | undefined {
  if (error instanceof ApiError && error.status !== DISCONNECTED_STATUS && error.status >= 400 && error.status < 500) {
    return { message: error.message, code: error.code };
  }
  return undefined;
}

/** A run's settled status as a firing's. */
function firingStatusOf(status: RunStatus): FiringStatus | undefined {
  switch (status) {
    case 'done': return 'ran';
    case 'failed': case 'invalid-input': return 'failed';
    case 'cancelled': case 'undone': return 'cancelled';
    case 'awaiting-approval': case 'queued': case 'running': case 'waiting': case 'paused': return undefined;
  }
}

/** The timer: its store, its queue, the schedules it knows, and the firings running in this process. */
export class Timer {
  readonly #settings: ScheduleSettings;
  readonly #clock: Clock;
  #store: TimerStore | undefined;
  #work: TimerQueue | undefined;
  #ctx: ScheduleCtx | undefined;
  #limits: Limits = limitsOf({});
  /** The schedule fns, as `kindFns` last listed them. */
  readonly #fns = new Map<string, ScheduleFn>();
  /** Running firings' handles, by firing id. */
  readonly #handles = new Map<string, Handle>();
  /** One chain of work per schedule, so its firings, settles and changes never interleave. */
  readonly #chains = new Map<string, Promise<void>>();
  /** When `kindFns` was last read whole or since. */
  #syncedAt: number | undefined;

  constructor(deps: TimerDeps) {
    this.#settings = deps.settings;
    this.#clock = deps.clock ?? systemClock;
  }

  /** The limits now in force (the config with its defaults). */
  get limits(): Limits {
    return this.#limits;
  }

  /** The store, once started. */
  get store(): TimerStore {
    if (this.#store === undefined) { throw new Error('The schedule timer has not started.'); }
    return this.#store;
  }

  /** The schedule fns the timer knows, by name. */
  known(fn: string): ScheduleFn | undefined {
    return this.#fns.get(fn);
  }

  /** Every schedule fn the timer knows (as `kindFns` last listed them), removed ones left out, by name. */
  schedules(): ScheduleFn[] {
    return [...this.#fns.values()].filter((fn) => !fn.removed).sort((a, b) => a.fn.localeCompare(b.fn));
  }

  /** What the timer keeps of a schedule (its last firing that ran, for `previous`; how many ran), once started. */
  row(fn: string): ScheduleRow | undefined {
    return this.#store?.schedule(fn);
  }

  /** The config changed (or was first given): the limits follow it. */
  configure(ctx: ScheduleCtx): void {
    this.#ctx = ctx;
    this.#limits = limitsOf(ctx.config);
  }

  // ─── life ───────────────────────────────────────────────────────────────────

  /** The queue on the store's SQLite file: `due` firings and `expire` waits for approval. */
  createQueue(store: TimerStore) {
    const due = defineWork('due', async (input: { fn: string; at: number }, ctx) => {
      await this.#safely('due', () => this.#due(input.fn, input.at));
      return ctx.void();
    }, { retry: { attempts: 1 } });
    const expire = defineWork('expire', async (input: { id: string }, ctx) => {
      await this.#safely('expire', () => this.#expire(input.id));
      return ctx.void();
    }, { retry: { attempts: 1 } });
    const backend = sqliteBackend(store.db, { prefix: 'work_', now: () => this.#clock.now() });
    const work = createWork({
      work: [due, expire] as const,
      queue: backend.queue, store: backend.store, pubsub: backend.pubsub,
      now: () => this.#clock.now(),
      pollInterval: this.#settings.SCHEDULE_POLL,
      autoStart: false,
      onError: (error, phase) => { this.#ctx?.log.warn('schedule.work', { phase, error: error instanceof Error ? error.message : String(error) }); },
    });
    return { work, due, expire };
  }

  /** Open the store and queue (once), reconcile every schedule, and start the queue. Every (re)connect calls it. */
  async start(ctx: ScheduleCtx): Promise<void> {
    this.configure(ctx);
    if (this.#store === undefined) {
      mkdirSync(ctx.dataDir, { recursive: true });
      this.#store = new TimerStore(resolve(ctx.dataDir, this.#settings.SCHEDULE_DB));
      this.#work = this.createQueue(this.#store);
    }
    await this.reconcile(ctx);
    this.#work?.work.start();
  }

  /** Checkpoint the store's write-ahead log, so a copy of the data folder is whole. */
  checkpoint(): void {
    this.#store?.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /** Stop the queue and close the store. */
  async stop(): Promise<void> {
    await this.#work?.work.stop();
    this.#work = undefined;
    this.#store?.close();
    this.#store = undefined;
  }

  /** Every schedule fn read again, each one's next firing queued, and what the system missed while it was down. */
  async reconcile(ctx: ScheduleCtx): Promise<void> {
    this.configure(ctx);
    const store = this.store;
    const now = this.#clock.now();
    const listed = await this.#list(ctx);
    this.#fns.clear();
    for (const fn of listed) { this.#fns.set(fn.fn, fn); }
    this.#syncedAt = now;
    for (const fn of listed) {
      await this.#chain(fn.fn, () => this.#adopt(fn, ctx, false));
    }
    for (const row of store.schedules()) {
      if (!this.#fns.has(row.fn)) { store.removeSchedule(row.fn); }
    }
    // firings still marked going with no run of theirs here: the hub may still restart them; past a while they're lost
    for (const row of store.allActive()) {
      if (!this.#handles.has(row.id) && now - row.created > this.#settings.SCHEDULE_LOST_AFTER) {
        await this.#chain(row.fn, () => this.#settle(row.id, { status: 'failed', reason: 'It was lost when the schedule system restarted.' }));
      }
    }
    // settled firings whose telling wasn't decided (the system stopped between the record and the notice)
    for (const row of store.untold()) {
      await this.#chain(row.fn, () => this.#tell(row.id, false));
    }
    store.forgetBefore(now - KEEP_ROWS);
  }

  /** Fns came, went or changed: the schedules among them are read again and planned again. */
  async fnsChanged(event: Extract<SystemEvent, { type: 'fns' }>, ctx: ScheduleCtx): Promise<void> {
    this.configure(ctx);
    if (this.#store === undefined) { return; }
    for (const name of event.removed) {
      if (this.#fns.has(name)) { await this.#chain(name, () => { this.#forget(name); return Promise.resolve(); }); }
    }
    const since = this.#syncedAt === undefined ? undefined : this.#syncedAt - SYNC_MARGIN;
    const now = this.#clock.now();
    const listed = await this.#list(ctx, since);
    this.#syncedAt = now;
    for (const fn of listed) {
      if (fn.removed) {
        await this.#chain(fn.fn, () => { this.#forget(fn.fn); return Promise.resolve(); });
        continue;
      }
      const before = this.#fns.get(fn.fn);
      this.#fns.set(fn.fn, fn);
      await this.#chain(fn.fn, () => this.#adopt(fn, ctx, before !== undefined && before.version !== fn.version));
    }
  }

  /** Every schedule fn, a page at a time (only those changed or removed since a time, when given). */
  async #list(ctx: ScheduleCtx, changedSince?: number): Promise<ScheduleFn[]> {
    const out: ScheduleFn[] = [];
    let cursor: string | undefined;
    do {
      const page = await ctx.runs.kindFns(schedule.kinds.schedule, {
        ...(changedSince === undefined ? {} : { changedSince }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      out.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return out;
  }

  /**
   * A schedule fn the timer reads: its row made or brought up to date, and its next firing queued. A new one starts
   * from now (or from its last firing record, when this data folder lost its row); a changed one from now, so firings
   * its new times put in the past are not "missed".
   */
  async #adopt(fn: ScheduleFn, ctx: ScheduleCtx, changedLive: boolean): Promise<void> {
    const store = this.store;
    const now = this.#clock.now();
    let row = store.schedule(fn.fn);
    if (row === undefined) {
      const last = await this.#lastRecorded(fn, ctx);
      row = store.putSchedule({ fn: fn.fn, owner: fn.owner, version: fn.version, lastAt: last?.at ?? now, count: last?.count ?? 0 });
    } else if (row.version !== fn.version || row.owner !== fn.owner) {
      row = store.putSchedule({ ...row, owner: fn.owner, version: fn.version, lastAt: changedLive ? Math.max(row.lastAt, now) : row.lastAt });
    }
    this.#plan(fn, row);
  }

  /** The latest firing record of a schedule, when the timer has no row for it (a lost data folder). */
  async #lastRecorded(fn: ScheduleFn, ctx: ScheduleCtx): Promise<{ at: number; count: number } | undefined> {
    try {
      const page = await ctx.data.find(schedule.types.Firing, { query: { filters: [{ field: 'schedule', op: 'is', value: fn.fn }], sort: [{ field: 'at', dir: 'desc' }], limit: 1 } });
      const last = page.items[0];
      return last === undefined ? undefined : { at: last.value.at, count: 0 };
    } catch (error) {
      ctx.log.warn('schedule.history.unread', { fn: fn.fn, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  /** A schedule removed: its queued firing dropped (the queue item finds no row) and its row forgotten; its firings stay. */
  #forget(fn: string): void {
    this.#fns.delete(fn);
    this.store.removeSchedule(fn);
  }

  /**
   * Queue the schedule's next firing after the last instant it handled (or after its pause ends): one `due` item at
   * that instant, unless that one is queued already. A paused schedule with no end day queues nothing.
   */
  #plan(fn: ScheduleFn, row: ScheduleRow): void {
    const payload = payloadOf(fn);
    const paused = payload.paused;
    let from = row.lastAt + 1;
    if (paused !== undefined) {
      if (paused.until === undefined) { this.store.putSchedule({ ...row, plannedAt: undefined }); return; }
      from = Math.max(from, zonedTime(paused.until, 0, payload.zone));
    }
    const next = nextFirings(payload.when, payload.zone, from, 1)[0];
    if (next === undefined) { this.store.putSchedule({ ...row, plannedAt: undefined }); return; }
    if (row.plannedAt === next.at) { return; }
    this.store.putSchedule({ ...row, plannedAt: next.at });
    const work = this.#work;
    if (work !== undefined) { work.work.enqueue(work.due({ fn: fn.fn, at: next.at }), { runAt: next.at }); }
  }

  // ─── firings ────────────────────────────────────────────────────────────────

  /** A queued firing is due: unless it is stale (the schedule changed or went), catch up on it. */
  async #due(fn: string, at: number): Promise<void> {
    await this.#chain(fn, async () => {
      const row = this.#store?.schedule(fn);
      const kindFn = this.#fns.get(fn);
      if (row === undefined || kindFn === undefined || row.plannedAt !== at) { return; }
      await this.#catchUp(kindFn, row);
    });
  }

  /**
   * Every firing from the last one handled up to now: the latest starts when it is on time (or within the grace
   * window, with `missed: 'latest'`), the rest are recorded as missed. While the hub can't be reached the item waits
   * and tries again (`WorkDelayError`), until the grace window passes.
   */
  async #catchUp(fn: ScheduleFn, row: ScheduleRow): Promise<void> {
    const ctx = this.#ctxOrDelay();
    const payload = payloadOf(fn);
    const now = this.#clock.now();
    const pausedUntil = payload.paused === undefined ? undefined : payload.paused.until === undefined ? Number.POSITIVE_INFINITY : zonedTime(payload.paused.until, 0, payload.zone);
    const due = firingsBetween(payload.when, payload.zone, row.lastAt + 1, now + 1, 10_000)
      .filter((firing) => pausedUntil === undefined || firing.at >= pausedUntil);
    const latest = due.at(-1);
    if (latest === undefined) { this.#plan(fn, this.store.schedule(fn.fn) ?? row); return; }
    const earlier = due.slice(0, -1);
    const late = now - latest.at;
    const runs = late <= this.#settings.SCHEDULE_ON_TIME || (payload.missed === 'latest' && late <= this.#limits.grace);
    const missed = runs ? earlier : due;
    const missedReason = (occurrence: Occurrence): string => payload.missed === 'latest'
      ? `It couldn't start within ${spanWords(this.#limits.grace)} of ${whenWords(occurrence.key)}, so it was missed.`
      : `It couldn't start on time (${whenWords(occurrence.key)}), and missed runs don't run late.`;
    for (const occurrence of missed) {
      await this.#recordNoRun(fn, occurrence, 'missed', missedReason(occurrence), ctx);
    }
    if (missed.length > 0) {
      // handled up to the last missed one, so a retry of the latest doesn't record them again
      this.store.updateSchedule(fn.fn, (current) => ({ ...current, lastAt: Math.max(current.lastAt, missed.at(-1)?.at ?? current.lastAt) }));
    }
    if (runs) {
      const started = await this.#fire(fn, latest, ctx, { missedBefore: earlier.length });
      if (started === 'retry') {
        throw new WorkDelayError({ delay: this.#settings.SCHEDULE_RETRY });
      }
    } else if (missed.length > 0) {
      await this.#tellMissed(fn, missed, ctx);
    }
    const current = this.store.updateSchedule(fn.fn, (r) => ({ ...r, lastAt: Math.max(r.lastAt, latest.at) }));
    if (current !== undefined) { this.#plan(fn, current); }
  }

  /** The timer's context, or a wait: nothing can start before the system is connected. */
  #ctxOrDelay(): ScheduleCtx {
    if (this.#ctx === undefined) { throw new WorkDelayError({ delay: this.#settings.SCHEDULE_RETRY }); }
    return this.#ctx;
  }

  /**
   * Start one firing as the schedule's owner, after its limits and the overlap rule. `retry` when the hub couldn't be
   * reached; the firing is then not recorded yet.
   */
  async #fire(fn: ScheduleFn, occurrence: Occurrence, ctx: ScheduleCtx, options: { missedBefore: number }): Promise<'started' | 'retry' | 'held'> {
    const store = this.store;
    const payload = payloadOf(fn);
    const now = this.#clock.now();
    const limit = this.#limitProblem(fn, now);
    if (limit !== undefined) {
      await this.#recordNoRun(fn, occurrence, 'refused', limit, ctx);
      return 'held';
    }
    const active = store.active(fn.fn);
    if (active !== undefined && !(await this.#expiredNow(active, now))) {
      if (payload.overlap === 'skip') {
        await this.#recordNoRun(fn, occurrence, 'skipped', `The run before it (${whenWords(active.value.key)}) was still going.`, ctx, active.run);
        return 'held';
      }
      if (payload.overlap === 'queue') {
        const row = store.schedule(fn.fn);
        const waiting = row?.queued;
        if (waiting !== undefined) {
          await this.#recordNoRun(fn, { at: waiting.at, key: waiting.key, ...fromOccurrenceKey(waiting.key) }, 'skipped', `A later run took its place in the queue behind ${whenWords(active.value.key)}.`, ctx, active.run);
        }
        store.updateSchedule(fn.fn, (r) => ({ ...r, queued: { at: occurrence.at, key: occurrence.key } }));
        return 'held';
      }
      // replace: the running one is cancelled, and this one starts
      await this.#handles.get(active.id)?.cancel('replaced');
    }
    const id = plannedId(fn.fn, occurrence.at);
    const existing = store.firing(id);
    if (existing === undefined || existing.run === undefined) {
      store.putFiring({
        id, fn: fn.fn, owner: fn.owner, at: occurrence.at, status: 'running', missed: options.missedBefore, byPerson: false, told: false, created: now,
        value: { schedule: fn.fn, version: fn.version, at: occurrence.at, key: occurrence.key, manual: false, status: 'running', notified: false },
        ...(existing?.record === undefined ? {} : { record: existing.record }),
      });
    }
    try {
      const started = await this.#withTimeout(ctx.runs.start(fn, {
        args: { at: occurrence.at }, key: `schedule:${id}`, priority: 'background',
        ...(payload.maxSpend === undefined ? {} : { maxSpend: payload.maxSpend }),
      }));
      store.updateFiring(id, (row) => ({ ...row, run: row.run ?? started.run }));
      ctx.log.info('schedule.started', { fn: fn.fn, at: occurrence.at, run: started.run });
      return 'started';
    } catch (error) {
      const refused = refusalOf(error);
      if (refused === undefined) {
        // the hub couldn't be reached (or didn't answer): the same key is the same run, so trying again is safe
        if (store.firing(id)?.record === undefined) { store.removeFiring(id); }
        ctx.log.warn('schedule.start.unreachable', { fn: fn.fn, at: occurrence.at, error: error instanceof Error ? error.message : String(error) });
        return 'retry';
      }
      store.removeFiring(id);
      await this.#recordNoRun(fn, occurrence, 'refused', `The hub refused to start it: ${refused.message}`, ctx, undefined, refused.code);
      return 'held';
    }
  }

  /** A firing's start, or `StartTimedOut` when the hub doesn't answer in time. */
  async #withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new StartTimedOut('The hub did not answer in time.')); }, this.#settings.SCHEDULE_START_TIMEOUT);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Why a firing can't start under the limits: its owner has too many schedules, or too many firings today. */
  #limitProblem(fn: ScheduleFn, now: number): string | undefined {
    const limits = this.#limits;
    const theirs = [...this.#fns.values()].filter((other) => other.owner === fn.owner && !other.removed).sort((a, b) => a.updatedAt - b.updatedAt || a.fn.localeCompare(b.fn));
    if (theirs.length > limits.perPerson && theirs.findIndex((other) => other.fn === fn.fn) >= limits.perPerson) {
      return `Its owner has ${String(theirs.length)} schedules, more than the ${String(limits.perPerson)} one person may have, so the newest don't run.`;
    }
    if (this.store.startedSince(fn.owner, now - PER_DAY) >= limits.firingsPerDay) {
      return `Its owner's schedules ran ${String(limits.firingsPerDay)} times in the last day, the most one person's may.`;
    }
    return undefined;
  }

  /** A firing waiting for approval past its time gives up now (and stops blocking the next one). */
  async #expiredNow(active: FiringRow, now: number): Promise<boolean> {
    if (active.status !== 'waiting' || active.until === undefined || active.until > now) { return false; }
    const handle = this.#handles.get(active.id);
    if (handle !== undefined) { await handle.cancel('expired'); }
    return true;
  }

  /** A firing that never became a run (missed, skipped, refused): recorded, and told by the rules. */
  async #recordNoRun(fn: ScheduleFn, occurrence: Occurrence, status: 'missed' | 'skipped' | 'refused', reason: string, ctx: ScheduleCtx, waitedOn?: RunId, code?: string): Promise<void> {
    const store = this.store;
    const id = `${fn.fn}@${String(occurrence.at)}:${status}`;
    const summary = summaryLine({ status, target: payloadOf(fn).fn, reason });
    const row = store.putFiring({
      id, fn: fn.fn, owner: fn.owner, at: occurrence.at, status, missed: 0, byPerson: false, told: false, created: this.#clock.now(),
      value: { schedule: fn.fn, version: fn.version, at: occurrence.at, key: occurrence.key, manual: false, status, summary, notified: false, ...(waitedOn === undefined ? {} : { run: waitedOn }) },
    });
    await this.#saveRecord(row, ctx);
    if (status === 'refused') {
      await this.#tell(id, false);
      if (code === 'OWNER_GONE') { await this.#tellAdminsOnce(fn, reason, ctx); }
    } else if (status === 'skipped') {
      store.updateFiring(id, (r) => ({ ...r, told: true }));
    }
    // missed ones are told together by the caller (or folded into the latest's notice)
  }

  /** The admins hear once that a schedule's owner is gone (its firings are refused). */
  async #tellAdminsOnce(fn: ScheduleFn, reason: string, ctx: ScheduleCtx): Promise<void> {
    const key = `admins:${reason}`;
    const row = this.store.schedule(fn.fn);
    if (row?.refused === key) { return; }
    await ctx.notifyAdmins({ title: `${fn.title} can't run`, body: `${fn.fn} runs as its owner, who can no longer use the hub. ${reason}` });
    this.store.updateSchedule(fn.fn, (r) => ({ ...r, refused: key }));
  }

  /** Missed firings found together: one notice ("… missed 3 runs"), unless the schedule says never. */
  async #tellMissed(fn: ScheduleFn, missed: readonly Occurrence[], ctx: ScheduleCtx): Promise<void> {
    const store = this.store;
    const ids = missed.map((occurrence) => `${fn.fn}@${String(occurrence.at)}:missed`);
    const last = missed.at(-1);
    if (last === undefined) { return; }
    if (tells({ notify: payloadOf(fn).notify, status: 'missed', manual: false })) {
      const body = missed.length === 1
        ? `It couldn't start in time for ${whenWords(last.key)}.`
        : `It couldn't start in time for ${String(missed.length)} runs, the last on ${whenWords(last.key)}.`;
      await this.#notify(fn, ctx, {
        title: titleOf(fn.title, 'missed', missed.length), body, tone: 'info',
        link: { page: schedule.page.item, path: [localOf(fn.fn)], query: { firing: last.key } },
      });
      for (const id of ids) {
        const row = store.updateFiring(id, (r) => ({ ...r, told: true, value: { ...r.value, notified: true } }));
        if (row !== undefined) { await this.#saveRecord(row, ctx); }
      }
      return;
    }
    for (const id of ids) { store.updateFiring(id, (r) => ({ ...r, told: true })); }
  }

  // ─── the kind's run ─────────────────────────────────────────────────────────

  /**
   * A run of a schedule fn: the timer's firing (`at` given) or "run now" (`at` absent). Works out the args from the
   * program over `fire` and `previous`, calls the target as the run's child, follows it through a wait for approval,
   * and records the firing with its summary. Only its owner runs it: a schedule runs as the person who made it.
   */
  async runFiring(payload: SchedulePayload, at: number | undefined, ctx: ScheduleRunCtx): Promise<RunOutcome> {
    const fn = ctx.run.fn;
    const kindFn = this.#fns.get(fn);
    if (kindFn !== undefined && ctx.run.user.id !== kindFn.owner) {
      return ctx.fail('caller', `${fn} runs only as its owner, who made it. To have it run as you, copy it into a schedule of your own.`);
    }
    const store = this.store;
    const now = this.#clock.now();
    const manual = at === undefined;
    const plannedAt = at ?? now;
    const id = manual ? `${fn}@run:${ctx.run.id}` : plannedId(fn, plannedAt);
    const key = store.firing(id)?.value.key ?? this.#keyAt(payload, plannedAt);
    const schedRow = store.schedule(fn);
    const late = manual ? 0 : Math.max(0, now - plannedAt);
    const base = store.firing(id);
    let row = store.putFiring({
      id, fn, owner: ctx.run.user.id, at: plannedAt, status: 'running', missed: base?.missed ?? 0, byPerson: false, told: false, created: base?.created ?? now,
      run: ctx.run.id, ...(base?.record === undefined ? {} : { record: base.record }),
      value: { schedule: fn, version: kindFn?.version ?? schedRow?.version ?? 1, at: plannedAt, key, manual, status: 'running', run: ctx.run.id, startedAt: now, notified: false },
    });
    store.updateSchedule(fn, (r) => ({ ...r, count: r.count + 1 }));
    const { day, time } = fromOccurrenceKey(key);
    const fire: Fire = { at: plannedAt, local: localString(plannedAt, payload.zone), day, ...(time === undefined ? {} : { time }), zone: payload.zone, count: schedRow?.count ?? 0, late, manual };
    // one save at a time, in order, as the run's person
    let saving: Promise<unknown> = Promise.resolve();
    const save = (change: (r: FiringRow) => FiringRow): Promise<void> => {
      const next = store.updateFiring(id, change);
      if (next === undefined) { return Promise.resolve(); }
      row = next;
      saving = saving.then(() => this.#saveRecord(next, undefined, ctx)).catch((error: unknown) => { ctx.log.warn('schedule.record.failed', { id, error: error instanceof Error ? error.message : String(error) }); });
      return saving.then(() => undefined);
    };
    const finish = async (status: FiringStatus, summary: string, extra: Partial<FiringShape> = {}): Promise<void> => {
      await save((r) => ({ ...r, status, value: { ...r.value, ...extra, status, summary, endedAt: this.#clock.now() } }));
    };

    // the args, from the program over `fire` and `previous`, checked again against the target as it is now
    let input: Json;
    try {
      const lookups = kindRunLookups(ctx);
      const target = await lookups.fn(payload.fn);
      if (target === undefined) { throw new ArgsFailed(`${payload.fn} is no longer a fn its owner can run.`); }
      input = await evaluateArgs(payload.args, target, payload.fn, lookups, { fire, previous: schedRow?.previous }, ctx.signal);
    } catch (error) {
      if (!(error instanceof ArgsFailed)) { throw error; }
      const summary = summaryLine({ status: 'failed', target: payload.fn, reason: error.message });
      await finish('failed', summary);
      return ctx.fail('caller', error.message);
    }
    await save((r) => ({ ...r, value: { ...r.value, args: input } }));

    const call = ctx.call(payload.fn, input, { key: 'target' });
    this.#handles.set(id, {
      cancel: async (reason) => {
        store.updateFiring(id, (r) => ({ ...r, reason }));
        await call.cancel();
      },
    });
    let doneText: string | undefined;
    const unwatch = call.watch((update) => {
      if (update.type !== 'status') { return; }
      if (update.status === 'done' && update.text !== undefined) { doneText = update.text.one; }
      if (update.status === 'awaiting-approval') { void this.#awaiting(id, payload, plannedAt, save, ctx); }
      if (update.status === 'running' && store.firing(id)?.status === 'waiting') {
        void save((r) => ({ ...r, status: 'running', until: undefined, value: { ...r.value, status: 'running' } }));
      }
    });
    const settled = await call.settled;
    unwatch();
    this.#handles.delete(id);
    await saving;
    const reason = store.firing(id)?.reason;
    const byPerson = ctx.signal.aborted;
    switch (settled.status) {
      case 'done': {
        await finish('ran', summaryLine({ status: 'ran', target: payload.fn, result: settled.result, doneText, late, onTime: this.#settings.SCHEDULE_ON_TIME }));
        this.#ran(fn, { at: plannedAt, status: 'ran', result: settled.result });
        return ctx.done(settled.result);
      }
      case 'failed': {
        await finish('failed', summaryLine({ status: 'failed', target: payload.fn, reason: settled.error.message, late, onTime: this.#settings.SCHEDULE_ON_TIME }));
        this.#ran(fn, { at: plannedAt, status: 'failed' });
        return ctx.fail(settled.error.class, settled.error.message, settled.error.code === undefined ? {} : { code: settled.error.code });
      }
      case 'cancelled': {
        const status: FiringStatus = reason === 'expired' ? 'expired' : reason === 'refused' ? 'refused' : 'cancelled';
        const words = this.#endWords(reason, payload, store.firing(id) ?? row);
        store.updateFiring(id, (r) => ({ ...r, byPerson }));
        await finish(status, summaryLine({ status, target: payload.fn, reason: words }));
        return ctx.cancelled();
      }
    }
  }

  /** Why a firing's run ended when the schedule's rules ended it, in words. */
  #endWords(reason: EndReason | undefined, payload: SchedulePayload, row: FiringRow): string | undefined {
    switch (reason) {
      case 'expired': return row.until !== undefined && row.until === nextFirings(payload.when, payload.zone, row.at + 1, 1)[0]?.at
        ? `It waited for approval to run ${payload.fn} until its next run was due.`
        : `It waited ${spanWords(this.#settings.SCHEDULE_APPROVAL_WAIT)} for approval to run ${payload.fn}.`;
      case 'refused': return `It needed approval to run ${payload.fn}, and scheduled runs that need approval are refused here: a policy that allows it lets it run.`;
      case 'replaced': return 'The next run replaced it.';
      case undefined: return undefined;
    }
  }

  /** A firing's target waits for approval: refused at once when the admin says so, else it waits until its next firing or the wait's end. */
  async #awaiting(id: string, payload: SchedulePayload, plannedAt: number, save: (change: (r: FiringRow) => FiringRow) => Promise<void>, ctx: ScheduleRunCtx): Promise<void> {
    if (this.#limits.approvals === 'refuse') {
      await this.#handles.get(id)?.cancel('refused');
      return;
    }
    const now = this.#clock.now();
    const next = nextFirings(payload.when, payload.zone, plannedAt + 1, 1)[0]?.at;
    const until = Math.min(next ?? Number.POSITIVE_INFINITY, now + this.#settings.SCHEDULE_APPROVAL_WAIT);
    await save((r) => ({ ...r, status: 'waiting', until, value: { ...r.value, status: 'waiting' } }));
    const work = this.#work;
    if (work !== undefined) { work.work.enqueue(work.expire({ id }), { runAt: until }); }
    ctx.log.info('schedule.waiting', { id, until });
  }

  /** A wait for approval reached its end: the firing gives up (its run is cancelled, and it is recorded as expired). */
  async #expire(id: string): Promise<void> {
    const row = this.#store?.firing(id);
    if (row?.status !== 'waiting' || row.until === undefined || row.until > this.#clock.now()) { return; }
    const handle = this.#handles.get(id);
    if (handle !== undefined) { await handle.cancel('expired'); return; }
    // its run is no longer in this process (a restart): recorded as expired, and told
    await this.#chain(row.fn, () => this.#settle(id, { status: 'expired', reason: 'It waited for approval past its time.' }));
  }

  /** The firing ran or failed: `previous` for the next one, and a refusal may be told again. */
  #ran(fn: string, previous: PreviousFiring): void {
    this.store.updateSchedule(fn, (r) => ({ ...r, previous, ...(previous.status === 'ran' ? { refused: undefined } : {}) }));
  }

  /** The key of a "run now" at an instant: its day and minute in the schedule's zone (its day alone with no times). */
  #keyAt(payload: SchedulePayload, at: number): ReturnType<typeof occurrenceKey> {
    const { day, minute } = localNow(at, payload.zone);
    const hasTimes = (payload.when.times ?? []).length > 0 || (payload.when.include ?? []).some((key) => key.length > 10);
    const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    return occurrenceKey(day, hasTimes || minute > 0 ? time : undefined);
  }

  // ─── settling and telling ───────────────────────────────────────────────────

  /** A run settled (the hub's `run` event): its firing is told by the rules, and a firing queued behind it starts. */
  async settled(event: Extract<SystemEvent, { type: 'run' }>, ctx: ScheduleCtx): Promise<void> {
    if (event.update.type !== 'status' || this.#store === undefined) { return; }
    const status = firingStatusOf(event.update.status);
    if (status === undefined) { return; }
    const row = this.#store.firingByRun(event.run);
    if (row === undefined) { return; }
    this.configure(ctx);
    const text = event.update.text?.one;
    await this.#chain(row.fn, async () => {
      const current = this.store.firing(row.id);
      if (current === undefined) { return; }
      if (current.status === 'running' || current.status === 'waiting') {
        // its run ended without this process recording it (a restart): what the hub says
        await this.#settle(current.id, { status, reason: text });
      }
      await this.#tell(current.id, event.notified ?? false);
      await this.#startQueued(row.fn, ctx);
      await this.#prune(row.fn, ctx);
    });
  }

  /** A firing whose run this process no longer follows, settled from what is known, recorded and told. */
  async #settle(id: string, outcome: { status: FiringStatus; reason?: string | undefined }): Promise<void> {
    const row = this.store.updateFiring(id, (r) => {
      const summary = summaryLine({ status: outcome.status, target: payloadOf(this.#fns.get(r.fn))?.fn ?? r.fn, reason: outcome.reason });
      return { ...r, status: outcome.status, until: undefined, value: { ...r.value, status: outcome.status, summary, endedAt: this.#clock.now() } };
    });
    if (row === undefined) { return; }
    const ctx = this.#ctx;
    if (ctx !== undefined) { await this.#saveRecord(row, ctx); }
    await this.#tell(id, false);
  }

  /** The firing queued behind the one that just settled (overlap `queue`) starts now, late. */
  async #startQueued(fn: string, ctx: ScheduleCtx): Promise<void> {
    const row = this.store.schedule(fn);
    const kindFn = this.#fns.get(fn);
    if (row?.queued === undefined || kindFn === undefined || this.store.active(fn) !== undefined) { return; }
    const queued = row.queued;
    this.store.putSchedule({ ...row, queued: undefined });
    const occurrence: Occurrence = { at: queued.at, key: queued.key, ...fromOccurrenceKey(queued.key) };
    if (await this.#fire(kindFn, occurrence, ctx, { missedBefore: 0 }) === 'retry') {
      // the hub went away meanwhile: it is queued again for when it is back
      this.store.updateSchedule(fn, (r) => ({ ...r, queued }));
    }
  }

  /**
   * Tell the owner about a settled firing, by the rules (`tells`), once: after its record is written, keyed per
   * schedule (a newer notice replaces an unread one), linking to its run (or to the schedule's page at that firing).
   */
  async #tell(id: string, notifiedByRun: boolean): Promise<void> {
    const store = this.store;
    const row = store.firing(id);
    const ctx = this.#ctx;
    if (row === undefined || row.told || ctx === undefined) { return; }
    const fn = this.#fns.get(row.fn);
    const reason = row.value.summary;
    const schedRow = store.schedule(row.fn);
    const tell = fn !== undefined && tells({
      notify: payloadOf(fn).notify, status: row.status, manual: row.value.manual, notifiedByRun, byPerson: row.byPerson,
      refusedBefore: schedRow?.refused, reason,
    });
    if (!tell) {
      store.updateFiring(id, (r) => ({ ...r, told: true }));
      return;
    }
    const missed = row.missed;
    const body = missed > 0
      ? `Missed ${String(missed)} ${missed === 1 ? 'run' : 'runs'} before this one. ${row.value.summary ?? ''}`.trim()
      : row.value.summary ?? titleOf(fn.title, row.status);
    await this.#notify(fn, ctx, {
      title: titleOf(fn.title, row.status), body, tone: toneOf(row.status),
      link: row.value.run !== undefined && row.status !== 'skipped' && row.status !== 'refused'
        ? { run: row.value.run }
        : { page: schedule.page.item, path: [localOf(fn.fn)], query: { firing: row.value.key } },
    });
    if (row.status === 'refused' && reason !== undefined) { store.updateSchedule(row.fn, (r) => ({ ...r, refused: reason })); }
    const told = store.updateFiring(id, (r) => ({ ...r, told: true, value: { ...r.value, notified: true } }));
    if (told !== undefined) { await this.#saveRecord(told, ctx); }
  }

  /** One notice to a schedule's owner, with the second link to its history and its key. */
  async #notify(fn: ScheduleFn, ctx: ScheduleCtx, notice: Pick<Parameters<ScheduleCtx['runs']['notify']>[1], 'title' | 'body' | 'tone' | 'link'>): Promise<void> {
    try {
      await ctx.runs.notify(fn, {
        ...notice,
        also: { label: 'History', link: { page: schedule.page.item, path: [localOf(fn.fn)], query: { tab: 'history' } } },
        key: `schedule:${fn.fn}`,
      });
    } catch (error) {
      ctx.log.warn('schedule.notify.failed', { fn: fn.fn, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ─── records ────────────────────────────────────────────────────────────────

  /**
   * A firing's record saved: in its run, as the run's person; outside one, as the system, naming the owner of a new
   * record (an existing one keeps its owner).
   */
  async #saveRecord(row: FiringRow, ctx: ScheduleCtx | undefined, run?: ScheduleRunCtx): Promise<void> {
    const value = FiringShape.parse(row.value);
    if (run !== undefined) {
      const saved = await run.data.save(schedule.types.Firing, value, row.record === undefined ? {} : { id: row.record });
      this.store.updateFiring(row.id, (r) => ({ ...r, record: saved.id }));
      return;
    }
    if (ctx === undefined) { return; }
    try {
      const saved = await ctx.data.save(schedule.types.Firing, value, row.record === undefined ? { owner: row.owner } : { id: row.record });
      this.store.updateFiring(row.id, (r) => ({ ...r, record: saved.id }));
    } catch (error) {
      ctx.log.warn('schedule.record.failed', { id: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** A schedule's firing records beyond the newest `keep.perSchedule`, or older than `keep.days`, removed (at most daily). */
  async #prune(fn: string, ctx: ScheduleCtx): Promise<void> {
    const row = this.store.schedule(fn);
    const now = this.#clock.now();
    if (row === undefined || (row.prunedAt !== undefined && now - row.prunedAt < PRUNE_EVERY)) { return; }
    this.store.putSchedule({ ...row, prunedAt: now });
    const { perSchedule, days } = this.#limits.keep;
    const cutoff = now - days * DAY;
    try {
      let seen = 0;
      let cursor: string | undefined;
      do {
        const page = await ctx.data.find(schedule.types.Firing, {
          query: { filters: [{ field: 'schedule', op: 'is', value: fn }], sort: [{ field: 'at', dir: 'desc' }], limit: 100, ...(cursor === undefined ? {} : { cursor }) },
        });
        for (const record of page.items) {
          seen += 1;
          if (seen > perSchedule || record.value.at < cutoff) { await ctx.data.remove(schedule.types.Firing, record.id); }
        }
        cursor = page.cursor;
      } while (cursor !== undefined);
    } catch (error) {
      ctx.log.warn('schedule.prune.failed', { fn, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ─── plumbing ───────────────────────────────────────────────────────────────

  /** Run work for one schedule after the work already chained for it. */
  #chain(fn: string, work: () => Promise<void>): Promise<void> {
    const before = this.#chains.get(fn) ?? Promise.resolve();
    const next = before.then(work, work);
    const kept = next.catch(() => undefined);
    this.#chains.set(fn, kept);
    void kept.then(() => { if (this.#chains.get(fn) === kept) { this.#chains.delete(fn); } });
    return next;
  }

  /** A queue handler's work, its failures logged (a wait is passed on to the queue). */
  async #safely(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (error instanceof WorkDelayError) { throw error; }
      this.#ctx?.log.error('schedule.work.failed', { what, error: error instanceof Error ? error.message : String(error) }, error);
    }
  }
}

