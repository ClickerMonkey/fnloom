<script setup lang="ts">
/**
 * A fn's numbers over a period (`v-model:days`: 7, 30 or 90): a strip of figures (runs, retried input apart from
 * failures, typical and p95 time, waiting, cost, tokens) and its runs and typical time per day. The fn page and the
 * fn modal both show it.
 */
import type { FnMetrics, FnMetricsDay } from '@harness/core';
import { computed } from 'vue';
import { formatDuration } from '../../chat/logic/format.ts';
import { UiCard, UiEmpty, UiSegmented, type SegmentOption } from '../../ui/index.ts';
import { dayBars, figures } from '../logic/metrics.ts';
import { FN_PERIODS, type FnPeriod } from '../state/fn.ts';
import DayBars from './DayBars.vue';
import LoadState from './LoadState.vue';

const props = defineProps<{
  metrics: FnMetrics | undefined;
  daily: readonly FnMetricsDay[];
  loading: boolean;
  problem: string;
  now: number;
  /** Narrow places (a modal) put the two charts one under the other. */
  compact?: boolean;
}>();
const days = defineModel<FnPeriod>('days', { required: true });
const emit = defineEmits<{ retry: [] }>();

const PERIODS: readonly SegmentOption<string>[] = FN_PERIODS.map((value) => ({ value: String(value), label: `${String(value)} days` }));
const period = computed({
  get: () => String(days.value),
  set: (value: string) => { days.value = FN_PERIODS.find((d) => String(d) === value) ?? 7; },
});
const strip = computed(() => (props.metrics === undefined ? [] : figures(props.metrics)));
const dayWindow = computed(() => ({ period: days.value, now: props.now }));
const runBars = computed(() => dayBars(props.daily, 'runs', dayWindow.value));
const timeBars = computed(() => dayBars(props.daily, 'time', dayWindow.value));
</script>

<template>
  <section class="stats" data-testid="fn-stats">
    <div class="period">
      <h2 class="period-title">Over the last {{ days }} days</h2>
      <UiSegmented v-model="period" :options="PERIODS" label="Period" data-testid="fn-period" />
    </div>
    <LoadState :loading="loading" :problem="problem" :ready="metrics !== undefined || !loading" :empty="false" @retry="emit('retry')">
      <ul v-if="metrics" class="strip" data-testid="fn-metrics">
        <li v-for="figure in strip" :key="figure.key" class="figure" :data-figure="figure.key">
          <span class="label">{{ figure.label }}</span>
          <span class="value">{{ figure.value }}</span>
          <span v-if="figure.detail" class="detail">{{ figure.detail }}</span>
        </li>
      </ul>
      <UiEmpty v-else icon="fn" title="No runs in this period" body="Its numbers show here once it runs." />
      <div v-if="runBars.length > 0" class="charts" :class="{ compact }">
        <UiCard><DayBars title="Runs per day" :bars="runBars" :format="(v) => v.toLocaleString()" testid="fn-runs-chart" /></UiCard>
        <UiCard><DayBars title="Typical time per day" :bars="timeBars" :format="formatDuration" testid="fn-time-chart" /></UiCard>
      </div>
    </LoadState>
  </section>
</template>

<style scoped>
.stats { display: grid; gap: var(--space-3); min-width: 0; }
.period { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.period-title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 128px), 1fr)); gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
.figure { display: grid; align-content: start; gap: 2px; padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.label { color: var(--text-dim); font-size: var(--text-xs); }
.value { font-size: var(--text-lg); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; }
.detail { color: var(--text-faint); font-size: var(--text-xs); }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: var(--space-4); }
.charts.compact { grid-template-columns: minmax(0, 1fr); }
</style>
