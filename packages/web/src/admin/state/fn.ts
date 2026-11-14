/**
 * One fn's admin page: its record (from its system's fns), its rollup over a period (runs, outcomes, p50 and p95,
 * queue wait, cost, tokens, retries), its daily rollups for the charts and its latest runs. A settled run of the fn (the user channel's
 * `fn` event) updates its running numbers at once and reads the rollups again quietly.
 */
import { splitName, SystemName, type FnMetrics, type FnMetricsDay, type FnRecord, type QualifiedName, type Run, type UserEvent } from '@harness/core';
import { ref } from 'vue';
import type { UserEvents } from '../../api/notifications.ts';
import { Loaded, Task } from '../../state/loaded.ts';
import { Problem } from '../../state/problems.ts';
import type { AdminApi } from '../api.ts';

type FnApi = Pick<AdminApi, 'systemFns' | 'fnMetrics' | 'fnMetricsDays' | 'runs' | 'switchItem'>;

/** How many of its latest runs the page lists; the rest are a link away. */
export const FN_RECENT_RUNS = 8;

/** The periods the page offers, in days. */
export const FN_PERIODS = [7, 30, 90] as const;
export type FnPeriod = (typeof FN_PERIODS)[number];

/**
 * Why a fn can't be shown when its system's fns don't hold it: the system has none on this hub (not installed, or
 * not connected yet), or the fn is gone (removed or renamed since a run of it).
 */
export function missingFn(fn: QualifiedName, listed: number): string {
  const { system, local } = splitName(fn);
  return listed === 0
    ? `${system} has no fns on this hub now (it may be uninstalled or not connected yet), so ${fn} can't be shown.`
    : `${system} has no fn named ${local} now. It may have been removed or renamed since it ran.`;
}

/** One fn's page. */
export class FnStore {
  readonly #api: FnApi;
  readonly #events: UserEvents;
  #stop: (() => void) | undefined;
  readonly name = ref<QualifiedName | undefined>(undefined);
  readonly days = ref<FnPeriod>(7);
  readonly record = new Loaded<FnRecord>();
  readonly metrics = new Loaded<FnMetrics | undefined>();
  readonly daily = new Loaded<readonly FnMetricsDay[]>();
  /** Its latest runs, newest first. */
  readonly recent = new Loaded<readonly Run[]>();
  /** Turning it on or off. */
  readonly switching = new Task();

  constructor(api: FnApi, events: UserEvents) {
    this.#api = api;
    this.#events = events;
  }

  /** Show a fn over the last `days` days, and follow its runs. */
  async open(fn: QualifiedName, days: FnPeriod): Promise<void> {
    const same = this.name.value === fn;
    if (!same) { this.close(); }
    this.name.value = fn;
    this.days.value = days;
    this.#stop ??= this.#events((event) => { this.#onEvent(event); });
    await Promise.all([this.#loadRecord(fn, same), this.#loadMetrics(fn, days, same && this.metrics.value.value !== undefined)]);
  }

  /** Turn the fn shown on or off (shown at once, put back if the hub refuses); whether it worked. */
  async switchOn(on: boolean): Promise<boolean> {
    const record = this.record.value.value;
    if (record === undefined) { return false; }
    this.record.set({ ...record, disabled: !on });
    const result = await this.switching.run(() => this.#api.switchItem.call({ section: 'fns', name: record.name, on }), "Couldn't switch that.");
    if (!result.ok) { this.record.set(record); return false; }
    return true;
  }

  close(): void {
    this.#stop?.();
    this.#stop = undefined;
    this.name.value = undefined;
    this.record.reset();
    this.metrics.reset();
    this.daily.reset();
    this.recent.reset();
  }

  async #loadRecord(fn: QualifiedName, quiet: boolean): Promise<void> {
    const system = SystemName.parse(splitName(fn).system);
    await this.record.load(async () => {
      const listed = await this.#api.systemFns.call({ system });
      const found = listed.find((f) => f.name === fn);
      if (found === undefined) { throw new Problem(missingFn(fn, listed.length)); }
      return found;
    }, "Couldn't load this fn.", quiet);
  }

  async #loadMetrics(fn: QualifiedName, days: FnPeriod, quiet: boolean): Promise<void> {
    await Promise.all([
      this.metrics.load(async () => (await this.#api.fnMetrics.call({ fn, days })).find((m) => m.fn === fn), "Couldn't load this fn's metrics.", quiet),
      this.daily.load(() => this.#api.fnMetricsDays.call({ fn, days }), "Couldn't load this fn's days.", quiet),
      this.recent.load(async () => (await this.#api.runs.call({ query: { filters: [{ field: 'fn', op: 'is', value: fn }], limit: FN_RECENT_RUNS } })).items, "Couldn't load this fn's runs.", quiet),
    ]);
  }

  #onEvent(event: UserEvent): void {
    const fn = this.name.value;
    if (event.type !== 'fn' || fn === undefined || event.fn !== fn) { return; }
    const record = this.record.value.value;
    if (record !== undefined) { this.record.set({ ...record, stats: event.stats }); }
    void this.#loadMetrics(fn, this.days.value, true);
  }
}
