<script setup lang="ts">
/**
 * One fn's page (`/admin/systems/:name/fns/:fn`): its overview (the same as the chat's fn modal: what it does to data,
 * its signature, facts and examples), its metrics over a period
 * in the URL (`?days=7|30|90`) as a strip (runs, retried input apart from failures, typical and p95 time, waiting,
 * cost, tokens), its runs and its typical time per day, and its latest runs (each opens in the runs browser, with a
 * link to all of them), and for a fn of a kind (a database's saved query) what it runs. A saved widget shows its latest
 * run drawn as the widget, with Open in chat to run it there with its chips, pager and actions. Live: a settled run updates it.
 * A fn routed to one fleet instance leads back to that instance.
 */
import AccessControl from '../../components/access/AccessControl.vue';
import ItemHistory from '../../components/versions/ItemHistory.vue';
import { QualifiedName, WIDGET_KIND } from '@harness/core';
import { computed, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { z } from 'zod';
import AppPage from '../../app/AppPage.vue';
import { links, ROUTES } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import { useStores } from '../../state/stores.ts';
import FnOverview from '../../fns/components/FnOverview.vue';
import FnRuns from '../../fns/components/FnRuns.vue';
import { frameOf } from '../../components/widgets/widget-source.ts';
import WidgetView from '../../components/widgets/WidgetView.vue';
import { useWidgetOpener } from '../../data/state/open-widget.ts';
import { UiBadge, UiButton, UiCard, UiCodeBlock, UiEmpty, UiIcon, UiSegmented, UiSwitch, type SegmentOption } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import FnStats from '../components/FnStats.vue';
import LoadState from '../components/LoadState.vue';
import { FN_PERIODS, type FnPeriod } from '../state/fn.ts';

const { admin, fns, toasts } = useStores();
const store = admin.fn;
const route = useRoute();
const router = useRouter();
const query = useRouteQuery(ROUTES.fn);
const Period = z.enum(['7', '30', '90']);
const days = query.choice('days', Period, '7');
const period = computed<FnPeriod>({
  get: () => FN_PERIODS.find((d) => String(d) === days.value) ?? 7,
  set: (value) => { days.value = Period.parse(String(value)); },
});

const name = computed(() => {
  const parsed = QualifiedName.safeParse(`${String(route.params['name'])}/${String(route.params['fn'])}`);
  return parsed.success ? parsed.data : undefined;
});
const record = computed(() => store.record.value.value);
const now = useNow(30_000);
const recent = computed(() => store.recent.value.value ?? []);
const back = computed(() => {
  const r = record.value;
  if (r === undefined) { return undefined; }
  return r.decl.routing?.to === 'instance' ? links.instance(r.system, r.decl.routing.instance, 'fns') : links.system(r.system, 'fns');
});
const payload = computed(() => (record.value?.decl.payload === undefined ? '' : JSON.stringify(record.value.decl.payload, null, 2)));
/** The payload as its kind writes it for people (a query's SQL), with the stored JSON one switch away (`?form=stored`). */
const readable = computed(() => record.value?.decl.readable);
const PayloadForm = z.enum(['readable', 'stored']);
const form = query.choice('form', PayloadForm, 'readable');
const FORMS = computed<readonly SegmentOption<z.infer<typeof PayloadForm>>[]>(() => [{ value: 'readable', label: readable.value?.language.toUpperCase() ?? 'Readable' }, { value: 'stored', label: 'Stored form' }]);
const shownPayload = computed(() => (readable.value !== undefined && form.value === 'readable' ? { code: readable.value.code, language: readable.value.language } : { code: payload.value, language: 'json' }));
/** A saved widget: its latest finished run drawn as the widget (the runs are newest first). */
const isWidget = computed(() => record.value?.decl.kind === WIDGET_KIND);
const shownRun = computed(() => (isWidget.value ? recent.value.find((run) => run.outcome?.status === 'done') : undefined));
const widgetFrame = computed(() => {
  const run = shownRun.value;
  return run?.outcome?.status === 'done' && name.value !== undefined ? frameOf(run.outcome.result, fnLabel(name.value)) : undefined;
});
const { opening, open: openWidget } = useWidgetOpener();

async function switchOn(on: boolean): Promise<void> {
  if (!await store.switchOn(on)) { toasts.error(store.switching.problem.value); }
}

watch([name, period], ([fn, d]) => { if (fn !== undefined) { void store.open(fn, d); } }, { immediate: true });
watch(name, (fn) => { if (fn !== undefined) { void fns.open(fn); } }, { immediate: true });
onBeforeUnmount(() => { store.close(); fns.close(); });
</script>

<template>
  <AppPage :title="name ? fnLabel(name) : 'Fn'" :description="record?.decl.description ?? ''" keep-title>
    <template #crumb>
      <RouterLink v-if="record && back" :to="back" class="crumb" data-testid="back-to-system">
        <UiIcon name="chevron-left" :size="14" />{{ record.decl.routing?.to === 'instance' ? `${record.system}@${record.decl.routing.instance}` : record.system }}
      </RouterLink>
    </template>
    <LoadState :loading="store.record.loading.value" :problem="store.record.problem.value" :ready="record !== undefined" :empty="false" :lines="6" @retry="name && store.open(name, period)">
      <template v-if="record && name">
        <UiCard v-if="isWidget" title="The widget" data-testid="fn-widget">
          <template #actions>
            <UiButton size="sm" icon="play" :loading="opening === name" data-testid="fn-widget-open" @click="openWidget(name)">Open in chat</UiButton>
          </template>
          <WidgetView v-if="widgetFrame && shownRun" :key="shownRun.id" :frame="widgetFrame" :args="shownRun.args" :view-key="`fn:${shownRun.id}`" :show-title="false" />
          <UiEmpty v-else icon="grid" title="Not run yet" body="Open it in a chat to run it; its latest run shows here." />
        </UiCard>
        <FnOverview
          :name="name" :about="fns.about.value.value" :facts="fns.facts.value.value" :loading="fns.facts.loading.value" :problem="fns.facts.problem.value" :describe="false"
          :examples="fns.examples.value" :examples-total="fns.examplesTotal.value" :more-examples="fns.examplesNext.value !== undefined" :examples-loading="fns.examplesLoading.value"
          :examples-problem="fns.examplesProblem.value" @fn="router.push(links.fn($event))" @more="fns.moreExamples()" @retry="fns.open(name)"
        >
          <template #badges>
            <UiSwitch :model-value="!record.disabled" label="In use" :disabled="store.switching.busy.value" data-testid="fn-on" @update:model-value="switchOn" />
            <UiBadge v-if="record.paused">Paused</UiBadge>
            <UiBadge v-for="tag in record.decl.tags" :key="tag">{{ tag }}</UiBadge>
          </template>
        </FnOverview>
        <FnStats
          v-model:days="period" :metrics="store.metrics.value.value" :daily="store.daily.value.value ?? []" :loading="store.metrics.loading.value"
          :problem="store.metrics.problem.value || store.daily.problem.value" :now="now" @retry="store.open(name, period)"
        />
        <UiCard v-if="payload !== ''" title="What it runs" data-testid="fn-payload">
          <template v-if="readable" #actions><UiSegmented v-model="form" :options="FORMS" label="Show it as" data-testid="fn-payload-form" /></template>
          <UiCodeBlock :code="shownPayload.code" :language="shownPayload.language" wrap :max-height="360" />
        </UiCard>
        <AccessControl :target="{ kind: 'fn', fn: name }" />
        <ItemHistory :item="{ system: record.system, section: 'fns', name }" />
        <FnRuns
          :runs="recent" :now="now" title="Latest runs" :loading="store.recent.loading.value" :problem="store.recent.problem.value" @open="router.push(links.runs({ run: $event }))"
        >
          <template #actions><UiButton size="sm" variant="ghost" icon="arrow-right" data-testid="fn-runs" @click="router.push(links.fnRuns(name))">All its runs</UiButton></template>
        </FnRuns>
      </template>
    </LoadState>
  </AppPage>
</template>

<style scoped>
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); }
</style>
