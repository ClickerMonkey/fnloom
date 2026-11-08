/**
 * One fn's admin page: its record (from its system's fns), its rollup over a period (runs, outcomes, p50 and p95,
 * queue wait, cost, tokens, retries) and its daily rollups for the charts. A settled run of the fn (the user channel's
 * `fn` event) updates its running numbers at once and reads the rollups again quietly.
 */
import { splitName, SystemName, type FnMetrics, type FnMetricsDay, type FnRecord, type QualifiedName, type UserEvent } from '@harness/core';
import { ref } from 'vue';
import type { UserEvents } from '../../api/notifications.ts';
import { Loaded } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';

type FnApi = Pick<AdminApi, 'systemFns' | 'fnMetrics' | 'fnMetricsDays'>;

/** The periods the page offers, in days. */
export const FN_PERIODS = [7, 30, 90] as const;
export type FnPeriod = (typeof FN_PERIODS)[number];

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

  close(): void {
    this.#stop?.();
    this.#stop = undefined;
    this.name.value = undefined;
    this.record.reset();
    this.metrics.reset();
    this.daily.reset();
  }

  async #loadRecord(fn: QualifiedName, quiet: boolean): Promise<void> {
    const system = SystemName.parse(splitName(fn).system);
    await this.record.load(async () => {
      const found = (await this.#api.systemFns.call({ system })).find((f) => f.name === fn);
      if (found === undefined) { throw new Error(`${system} has no fn ${fn}.`); }
      return found;
    }, "Couldn't load this fn.", quiet);
  }

  async #loadMetrics(fn: QualifiedName, days: FnPeriod, quiet: boolean): Promise<void> {
    await Promise.all([
      this.metrics.load(async () => (await this.#api.fnMetrics.call({ fn, days })).find((m) => m.fn === fn), "Couldn't load this fn's metrics.", quiet),
      this.daily.load(() => this.#api.fnMetricsDays.call({ fn, days }), "Couldn't load this fn's days.", quiet),
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
