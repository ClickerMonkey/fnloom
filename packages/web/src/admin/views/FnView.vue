<script setup lang="ts">
/**
 * One fn's page (`/admin/systems/:name/fns/:fn`): what it is and whether it can be used now, its metrics over a period
 * in the URL (`?days=7|30|90`) as a strip (runs, retried input apart from failures, typical and p95 time, waiting,
 * cost, tokens), its runs and its typical time per day, and its latest runs (each opens in the runs browser, with a
 * link to all of them). Live: a settled run updates it.
 */
import { QualifiedName } from '@harness/core';
import { computed, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { z } from 'zod';
import AppPage from '../../app/AppPage.vue';
import { links, ROUTES } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import { formatCost, formatDuration } from '../../chat/logic/format.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import { argSummary, runElapsed, STATUS_LOOK } from '../../chat/logic/runs.ts';
import RunDot from '../../chat/components/RunDot.vue';
import { useStores } from '../../state/stores.ts';
import { UiBadge, UiButton, UiCard, UiEmpty, UiIcon, UiSegmented, type SegmentOption } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import BrowserRow from '../components/BrowserRow.vue';
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
const now = useNow(30_000);
const recent = computed(() => store.recent.value.value ?? []);
const dayWindow = computed(() => ({ period: period.value, now: now.value }));
const runBars = computed(() => dayBars(store.daily.value.value ?? [], 'runs', dayWindow.value));
const timeBars = computed(() => dayBars(store.daily.value.value ?? [], 'time', dayWindow.value));

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
        <UiCard class="runs" title="Latest runs" flush compact data-testid="fn-recent">
          <template #actions><UiButton size="sm" variant="ghost" icon="arrow-right" data-testid="fn-runs" @click="router.push(links.fnRuns(name))">All its runs</UiButton></template>
          <p v-if="store.recent.problem.value !== ''" class="problem" role="alert">{{ store.recent.problem.value }}</p>
          <p v-else-if="recent.length === 0" class="none">{{ store.recent.loading.value ? 'Loading…' : 'No runs yet.' }}</p>
          <ul v-else class="list">
            <BrowserRow
              v-for="run in recent" :key="run.id" :title="argSummary(run.args) || fnLabel(run.fn)" :at="run.createdAt" :now="now" :testid="`fn-run-${run.id}`"
              @open="router.push(links.runs({ run: run.id }))"
            >
              <template #mark><RunDot :status="run.status" :size="10" /></template>
              <template #badges>
                <UiBadge v-if="run.status === 'failed' || run.status === 'awaiting-approval'" :tone="STATUS_LOOK[run.status].tone">{{ STATUS_LOOK[run.status].word }}</UiBadge>
                <UiBadge v-if="run.attempt > 1" tone="warn">Try {{ run.attempt }}</UiBadge>
              </template>
              <template #figures>
                <span>{{ formatCost(run.totalCost) }}</span>
                <span v-if="runElapsed(run, now) !== undefined">{{ formatDuration(runElapsed(run, now) ?? 0) }}</span>
              </template>
            </BrowserRow>
          </ul>
        </UiCard>
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
.list { margin: 0; padding: 0; list-style: none; }
.none, .problem { margin: 0; padding: var(--space-3) var(--space-4); color: var(--text-faint); font-size: var(--text-sm); }
.problem { color: var(--danger); }
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); }
</style>
