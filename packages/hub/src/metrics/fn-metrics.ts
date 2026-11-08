/**
 * Fn metrics in the hub store (`FnMetricsService`): each settled run is folded once into its fn's day (table
 * `fnMetrics`, keyed by fn and UTC day) and into the fn's running numbers (`FnRecord.stats`), in one transaction, and
 * the new numbers are announced (`fn.stats`) so admin views update live. A run is folded at most once: its id is
 * marked in the store's key/value port inside the same transaction.
 */
import type { Logger } from '@ayepi/log';
import type { FnMetrics, FnMetricsDay, FnMetricsQuery, QualifiedName, Run, SystemName } from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { HubStore, Where } from '../store/index.ts';
import type { FnMetricsService } from './index.ts';
import { addSample, dayOf, emptyDurations, firstDay, foldDay, mergeDurations, percentile, rollup, sampleOf } from './rollup.ts';

/** The period a query covers when it doesn't say, in days. */
export const DEFAULT_DAYS = 7;
/** How long a run stays marked as folded: longer than any run's settle can be delivered again. */
const FOLDED_TTL = 30 * 86_400_000;
/** How many rows a read takes at once. */
const PAGE = 200;

/** What the service uses. */
export interface FnMetricsDeps {
  readonly store: HubStore;
  readonly bus: EventBus;
  readonly clock: () => number;
  readonly log: Logger;
}

/** Fn metrics on the hub store. */
export class StoreFnMetrics implements FnMetricsService {
  readonly #deps: FnMetricsDeps;

  constructor(deps: FnMetricsDeps) {
    this.#deps = deps;
  }

  async settled(run: Run): Promise<void> {
    const { store, clock } = this.#deps;
    const updated = await store.tx(async (tx) => {
      const modelCalls = await tx.table('modelCalls').count({ run: run.id });
      const sample = sampleOf(run, modelCalls);
      if (sample === undefined) return undefined;
      if (!(await tx.ports.work.store.setIfNotExists(`fn-metrics:${run.id}`, '1', FOLDED_TTL))) return undefined;
      const now = clock();
      const key = { fn: run.fn, day: dayOf(sample.at) };
      const day = foldDay(await tx.table('fnMetrics').get(key), sample, now);
      await tx.table('fnMetrics').put(day);
      const fn = await tx.table('fns').get(run.fn);
      if (fn === undefined) return undefined;
      const week = await this.#days(tx, run.fn, firstDay(sample.at, DEFAULT_DAYS));
      const p95 = percentile(week.reduce((all, d) => mergeDurations(all, d.ran), emptyDurations()), 0.95);
      return tx.table('fns').update(fn.name, { stats: addSample(fn.stats, sample, p95) });
    });
    if (updated !== undefined) this.#deps.bus.publish('fn.stats', { fn: updated.name, system: updated.system, stats: updated.stats });
  }

  async metrics(query: FnMetricsQuery): Promise<FnMetrics[]> {
    const { store, clock } = this.#deps;
    const days = query.days ?? DEFAULT_DAYS;
    const now = clock();
    const period = { from: firstDay(now, days), to: dayOf(now) };
    const rows = await this.#read(store, {
      day: { gte: period.from }, ...(query.fn === undefined ? {} : { fn: query.fn }), ...(query.system === undefined ? {} : { system: query.system }),
    });
    const byFn = new Map<QualifiedName, { system: SystemName; days: FnMetricsDay[] }>();
    for (const row of rows) {
      const known = byFn.get(row.fn);
      if (known === undefined) byFn.set(row.fn, { system: row.system, days: [row] });
      else known.days.push(row);
    }
    return Promise.all([...byFn.entries()].map(async ([fn, { system, days: list }]) => {
      const record = await store.table('fns').get(fn);
      return rollup(fn, system, list, period, record?.stats.lastRunAt);
    })).then((all) => all.sort((a, b) => b.runs - a.runs || a.fn.localeCompare(b.fn)));
  }

  async days(fn: QualifiedName, days: number): Promise<FnMetricsDay[]> {
    return this.#days(this.#deps.store, fn, firstDay(this.#deps.clock(), days));
  }

  /** A fn's days from `from` on, oldest first. */
  #days(store: HubStore, fn: QualifiedName, from: string): Promise<FnMetricsDay[]> {
    return this.#read(store, { fn, day: { gte: from } });
  }

  /** Every day row matching, oldest first. */
  async #read(store: HubStore, where: Where<FnMetricsDay>): Promise<FnMetricsDay[]> {
    const out: FnMetricsDay[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.table('fnMetrics').find({ where, order: [['day', 'asc']], limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
      out.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return out;
  }
}
