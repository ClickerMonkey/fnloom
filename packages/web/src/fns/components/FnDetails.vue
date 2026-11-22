<script setup lang="ts">
/**
 * Everything an admin sees about one fn, the same on its page and in the fn modal (build 9: "fn modal and page should
 * share same stuff"): a saved widget's latest run drawn as the widget (with Open in chat), its overview (what it does,
 * its signature, facts, the fns it uses and its examples) with its on/off switch, paused mark and tags, its numbers over
 * a period (`v-model:days`), what a kind fn runs (`v-model:form`), who may use it, its version history and its latest
 * runs. It loads the fn itself (its record, numbers and runs from the admin fn store, its overview from the fn info
 * store) and lets them go when it goes. A fn it uses opens in the app's fn modal (a `FnPill`); where it sits decides
 * where the rest opens: a run (`run`), all its runs (`runs`); `switched` says it was turned on or off. The `runs` slot adds the opener's own runs of it
 * (the chat's) under the overview. `compact` (a modal) stacks the charts and keeps the code short. An agent (a `hub/llm`
 * fn) has two tabs (`v-model:tab`, URL-bound by the page or the modal): About (all of the above) and Injected (what is
 * injected into its system prompt, each item with its per-agent switch and order, `InjectedList`).
 */
import { WIDGET_KIND, type InjectionView, type QualifiedName, type RunId } from '@harness/core';
import { computed, onBeforeUnmount, watch } from 'vue';
import InjectedList from '../../admin/components/InjectedList.vue';
import LoadState from '../../admin/components/LoadState.vue';
import { AGENT_KIND, fnTabs, type FnTab } from '../../admin/logic/injected.ts';
import FnStats from '../../admin/components/FnStats.vue';
import type { FnPeriod } from '../../admin/state/fn.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import AccessControl from '../../components/access/AccessControl.vue';
import ItemHistory from '../../components/versions/ItemHistory.vue';
import { frameOf } from '../../components/widgets/widget-source.ts';
import WidgetView from '../../components/widgets/WidgetView.vue';
import { useWidgetOpener } from '../../data/state/open-widget.ts';
import { useStores } from '../../state/stores.ts';
import { UiBadge, UiButton, UiCard, UiEmpty, UiSwitch, UiTabs } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import type { PayloadForm } from '../logic/facts.ts';
import FnOverview from './FnOverview.vue';
import FnPayload from './FnPayload.vue';
import FnRuns from './FnRuns.vue';

const props = withDefaults(defineProps<{
  name: QualifiedName;
  /** Show its description (off where the page's header already does). */
  describe?: boolean;
  /** A narrow place (a modal): charts one under the other, shorter code. */
  compact?: boolean;
}>(), { describe: true, compact: false });
const days = defineModel<FnPeriod>('days', { required: true });
const form = defineModel<PayloadForm>('form', { default: 'readable' });
const tab = defineModel<FnTab>('tab', { default: 'about' });
const emit = defineEmits<{ run: [run: RunId]; runs: [fn: QualifiedName]; switched: [fn: QualifiedName, on: boolean] }>();
const slots = defineSlots<{ runs?: () => unknown }>();

const { admin, fns, toasts } = useStores();
const store = admin.fn;
const now = useNow(30_000);
/** The fn's record once it is this fn's (a fn opened in place of another shows a skeleton until its own arrives). */
const record = computed(() => {
  const loaded = store.record.value.value;
  return loaded?.name === props.name ? loaded : undefined;
});
const recent = computed(() => store.recent.value.value ?? []);
/** A saved widget: its latest finished run drawn as the widget (the runs are newest first). */
const isWidget = computed(() => record.value?.decl.kind === WIDGET_KIND);
const shownRun = computed(() => (isWidget.value ? recent.value.find((run) => run.outcome?.status === 'done') : undefined));
const widgetFrame = computed(() => {
  const run = shownRun.value;
  return run?.outcome?.status === 'done' ? frameOf(run.outcome.result, fnLabel(props.name)) : undefined;
});
const { opening, open: openWidget } = useWidgetOpener();

/** An agent: its Injected tab lists what goes into its system prompt. */
const isAgent = computed(() => record.value?.decl.kind === AGENT_KIND);
const injected = admin.injected;
const injectedViews = computed(() => injected.page.value.value?.injections ?? []);
const tabs = computed(() => fnTabs(isAgent.value, injected.page.value.value === undefined ? undefined : injectedViews.value.length));
const shownTab = computed<FnTab>(() => (isAgent.value ? tab.value : 'about'));

async function switchInjected(view: InjectionView, on: boolean): Promise<void> {
  if (!(await injected.switchOn(view, on))) { toasts.error(injected.saving.problem.value); }
}

async function reorderInjected(view: InjectionView, order: number | null): Promise<void> {
  if (!(await injected.reorder(view, order))) { toasts.error(injected.saving.problem.value); }
}

async function switchOn(on: boolean): Promise<void> {
  const name = record.value?.name;
  if (name === undefined) { return; }
  if (await store.switchOn(on)) { emit('switched', name, on); } else { toasts.error(store.switching.problem.value); }
}

watch(() => [props.name, days.value] as const, ([fn, d]) => { void store.open(fn, d); }, { immediate: true });
watch(() => props.name, (fn) => { void fns.open(fn); }, { immediate: true });
// an agent's injections load with it, so its tab shows how many reach it
watch(() => [props.name, isAgent.value] as const, ([fn, agent]) => { if (agent) { void injected.open({ agent: fn }); } else { injected.close(); } }, { immediate: true });
onBeforeUnmount(() => { store.close(); fns.close(); injected.close(); });
</script>

<template>
  <LoadState
    class="fn-details" :loading="store.record.loading.value" :problem="store.record.problem.value" :ready="record !== undefined" :empty="false" :lines="6"
    data-testid="fn-details" @retry="store.open(name, days)"
  >
    <template v-if="record">
      <UiTabs v-if="isAgent" v-model="tab" :tabs="tabs" label="Fn" data-testid="fn-tabs" />
      <InjectedList
        v-if="shownTab === 'injected'" per="agent" :views="injectedViews" :loading="injected.page.loading.value" :problem="injected.page.problem.value"
        :busy="injected.busyKey.value" :now="now" data-testid="fn-injected" @switch="switchInjected" @reorder="reorderInjected" @retry="injected.refresh()"
      />
      <template v-else>
      <UiCard v-if="isWidget" title="The widget" data-testid="fn-widget">
        <template #actions>
          <UiButton size="sm" icon="play" :loading="opening === name" data-testid="fn-widget-open" @click="openWidget(name)">Open in chat</UiButton>
        </template>
        <WidgetView v-if="widgetFrame && shownRun" :key="shownRun.id" :frame="widgetFrame" :args="shownRun.args" :view-key="`fn:${shownRun.id}`" :show-title="false" />
        <UiEmpty v-else icon="grid" title="Not run yet" body="Open it in a chat to run it; its latest run shows here." />
      </UiCard>
      <FnOverview
        :name="name" :about="fns.about.value.value" :facts="fns.facts.value.value" :loading="fns.facts.loading.value" :problem="fns.facts.problem.value" :describe="describe"
        :examples="fns.examples.value" :examples-total="fns.examplesTotal.value" :more-examples="fns.examplesNext.value !== undefined" :examples-loading="fns.examplesLoading.value"
        :examples-problem="fns.examplesProblem.value" @more="fns.moreExamples()" @retry="fns.open(name)"
      >
        <template #badges>
          <UiSwitch :model-value="!record.disabled" label="In use" :disabled="store.switching.busy.value" data-testid="fn-on" @update:model-value="switchOn" />
          <UiBadge v-if="record.paused">Paused</UiBadge>
          <UiBadge v-for="tag in record.decl.tags" :key="tag">{{ tag }}</UiBadge>
        </template>
        <template v-if="slots.runs" #runs><slot name="runs" /></template>
      </FnOverview>
      <FnStats
        v-model:days="days" :metrics="store.metrics.value.value" :daily="store.daily.value.value ?? []" :loading="store.metrics.loading.value"
        :problem="store.metrics.problem.value || store.daily.problem.value" :now="now" :compact="compact" @retry="store.open(name, days)"
      />
      <FnPayload v-model:form="form" :payload="record.decl.payload" :readable="record.decl.readable" :max-height="compact ? 240 : 360" />
      <AccessControl :target="{ kind: 'fn', fn: name }" />
      <ItemHistory :item="{ system: record.system, section: 'fns', name }" />
      <FnRuns
        :runs="recent" :now="now" title="Latest runs" :loading="store.recent.loading.value" :problem="store.recent.problem.value" @open="emit('run', $event)"
      >
        <template #actions><UiButton size="sm" variant="ghost" icon="arrow-right" data-testid="fn-runs" @click="emit('runs', name)">All its runs</UiButton></template>
      </FnRuns>
      </template>
    </template>
  </LoadState>
</template>
