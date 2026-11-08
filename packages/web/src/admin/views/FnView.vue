<script setup lang="ts">
/**
 * One fn's page (`/admin/systems/:name/fns/:fn`): what it is and whether it can be used now, its metrics over a period
 * in the URL (`?days=7|30|90`) as a strip (runs, retried input apart from failures, typical and p95 time, waiting,
 * cost, tokens), its runs and its typical time per day, and a link to its runs. Live: a settled run updates it.
 */
import { QualifiedName } from '@harness/core';
import { computed, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { z } from 'zod';
import AppPage from '../../app/AppPage.vue';
import { links, ROUTES } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import { formatDuration } from '../../chat/logic/format.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import { useStores } from '../../state/stores.ts';
import { UiBadge, UiButton, UiCard, UiEmpty, UiIcon, UiSegmented, type SegmentOption } from '../../ui/index.ts';
import DayBars from '../components/DayBars.vue';
import LoadState from '../components/LoadState.vue';
import { dayBars, figures } from '../logic/metrics.ts';
import { availabilityText } from '../logic/systems.ts';
import { FN_PERIODS, type FnPeriod } from '../state/fn.ts';

const { admin } = useStores();
const store = admin.fn;
const route = useRoute();
const router = useRouter();
const query = useRouteQuery(ROUTES.fn);
const Period = z.enum(['7', '30', '90']);
const days = query.choice('days', Period, '7');
const period = computed<FnPeriod>(() => FN_PERIODS.find((d) => String(d) === days.value) ?? 7);
const PERIODS: readonly SegmentOption<z.infer<typeof Period>>[] = Period.options.map((value) => ({ value, label: `${value} days` }));

const name = computed(() => {
  const parsed = QualifiedName.safeParse(`${String(route.params['name'])}/${String(route.params['fn'])}`);
  return parsed.success ? parsed.data : undefined;
});
const record = computed(() => store.record.value.value);
const metrics = computed(() => store.metrics.value.value);
const strip = computed(() => (metrics.value === undefined ? [] : figures(metrics.value)));
const runBars = computed(() => dayBars(store.daily.value.value ?? [], 'runs'));
const timeBars = computed(() => dayBars(store.daily.value.value ?? [], 'time'));

watch([name, period], ([fn, d]) => { if (fn !== undefined) { void store.open(fn, d); } }, { immediate: true });
onBeforeUnmount(() => { store.close(); });
</script>

<template>
  <AppPage :title="name ? fnLabel(name) : 'Fn'" :description="record?.decl.description ?? ''" keep-title>
    <template #crumb>
      <RouterLink v-if="record" :to="links.system(record.system, 'fns')" class="crumb" data-testid="back-to-system">
        <UiIcon name="chevron-left" :size="14" />{{ record.system }}
      </RouterLink>
    </template>
    <LoadState :loading="store.record.loading.value" :problem="store.record.problem.value" :ready="record !== undefined" :empty="false" :lines="6" @retry="name && store.open(name, period)">
      <template v-if="record && name">
        <div class="head">
          <code class="qualified">{{ name }}</code>
          <UiBadge v-if="record.available !== true" tone="warn" :title="record.available.detail">{{ availabilityText(record.available) }}</UiBadge>
          <UiBadge v-if="record.paused">Paused</UiBadge>
          <UiBadge v-for="tag in record.decl.tags" :key="tag">{{ tag }}</UiBadge>
          <span class="grow" />
          <UiSegmented v-model="days" :options="PERIODS" label="Period" data-testid="fn-period" />
        </div>
        <LoadState
          :loading="store.metrics.loading.value" :problem="store.metrics.problem.value || store.daily.problem.value" :ready="store.metrics.value.value !== undefined || !store.metrics.loading.value"
          :empty="false" @retry="store.open(name, period)"
        >
          <ul v-if="metrics" class="strip" data-testid="fn-metrics">
            <li v-for="figure in strip" :key="figure.key" class="figure" :data-figure="figure.key">
              <span class="label">{{ figure.label }}</span>
              <span class="value">{{ figure.value }}</span>
              <span v-if="figure.detail" class="detail">{{ figure.detail }}</span>
            </li>
          </ul>
          <UiEmpty v-else icon="fn" title="No runs in this period" body="Its numbers show here once it runs." />
          <div v-if="runBars.length > 0" class="charts">
            <UiCard><DayBars title="Runs per day" :bars="runBars" :format="(v) => v.toLocaleString()" testid="fn-runs-chart" /></UiCard>
            <UiCard><DayBars title="Typical time per day" :bars="timeBars" :format="formatDuration" testid="fn-time-chart" /></UiCard>
          </div>
        </LoadState>
        <div class="actions">
          <UiButton icon="fn" variant="secondary" data-testid="fn-runs" @click="router.push(links.runs({ fn: name }))">Its runs</UiButton>
        </div>
      </template>
    </LoadState>
  </AppPage>
</template>

<style scoped>
.head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.qualified { color: var(--text-dim); font-size: var(--text-sm); }
.grow { flex: 1; }
.strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 128px), 1fr)); gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
.figure { display: grid; align-content: start; gap: 2px; padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.label { color: var(--text-dim); font-size: var(--text-xs); }
.value { font-size: var(--text-lg); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; }
.detail { color: var(--text-faint); font-size: var(--text-xs); }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: var(--space-4); }
.actions { display: flex; gap: var(--space-2); }
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); }
</style>
