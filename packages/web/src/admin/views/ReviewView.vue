<script setup lang="ts">
/**
 * A system's review (build 7), its tab in the URL: everything it declares (its fns with their instructions, signature,
 * examples, facts and effects, each with a test call; its context, types and other parts), each with its own switch;
 * its grants; its config (its own config component too, when it has one); its install checks; the changes waiting
 * since it went live, as diffs; and the calls the hub refused. An installed system goes live from here with what was
 * reviewed; a live one's pending changes are approved or rejected here.
 */
import { MAIN_INSTANCE, SystemName, type ItemRef, type Json, type QualifiedName, type RefusalRule, type ResourceRoot, type RunId, type SystemPartSection } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { links, ROUTES } from '../../app/routes.ts';
import { useParamChoice, useRouteQuery } from '../../app/url.ts';
import { useStores } from '../../state/stores.ts';
import { UiBanner, UiButton, UiEmpty, UiIcon, UiTabs, type TabItem } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import ChangeList from '../components/ChangeList.vue';
import ChecksView from '../components/ChecksView.vue';
import ConfigWithCustom from '../components/ConfigWithCustom.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DeclaredList from '../components/DeclaredList.vue';
import GrantsView from '../components/GrantsView.vue';
import LoadState from '../components/LoadState.vue';
import PartsByKind from '../components/PartsByKind.vue';
import SystemGraph from '../../graph/components/SystemGraph.vue';
import RefusalList from '../components/RefusalList.vue';
import ReviewFnList from '../components/ReviewFnList.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TestCallDialog from '../components/TestCallDialog.vue';
import { secretFields } from '../logic/instances.ts';
import { checksLine, checksWarn, declaredItems, fnReviews, STAGE_ABOUT, STAGE_LOOK, type DeclaredItem, type FnReview } from '../logic/review.ts';
import { partGroups } from '../logic/systems.ts';
import { PartTab, ReviewTab } from '../sections.ts';
import { configComponentsOf, configTarget } from '../state/config-component.ts';

const { admin, chat, toasts } = useStores();
const store = admin.review;
const parts = admin.systemParts;
const system = admin.system;
const route = useRoute();
const now = useNow();
const tab = useParamChoice('tab', ReviewTab, 'fns');
const part = useRouteQuery(ROUTES.review).choice('part', PartTab, 'roots');
const name = computed(() => { const parsed = SystemName.safeParse(route.params['name']); return parsed.success ? parsed.data : undefined; });
const review = computed(() => store.review.value.value);
const fns = computed(() => (review.value === undefined ? [] : fnReviews(review.value)));
const context = computed(() => (review.value === undefined ? [] : declaredItems(review.value, 'context')));
const types = computed(() => (review.value === undefined ? [] : declaredItems(review.value, 'types')));
const others = computed(() => parts.others.value.value);
const groups = computed(() => (others.value === undefined ? [] : partGroups(others.value)));
const roots = computed(() => parts.roots.value.value ?? []);
const changes = computed(() => review.value?.pending?.changes ?? []);
const rule = ref<RefusalRule | 'all'>('all');
const loader = configComponentsOf(chat);
const target = computed(() => (review.value === undefined ? undefined : configTarget(review.value.manifest)));
const view = computed(() => system.view.value.value);
const problems = ref<readonly string[]>([]);
const confirming = ref(false);

const tabs = computed<readonly TabItem<ReviewTab>[]>(() => [
  { value: 'fns', label: 'Fns', count: fns.value.length },
  { value: 'context', label: 'Context', count: context.value.length },
  { value: 'types', label: 'Types', count: types.value.length },
  { value: 'parts', label: 'Other parts' },
  { value: 'graph', label: 'Graph' },
  { value: 'grants', label: 'Grants' },
  { value: 'config', label: 'Config' },
  { value: 'checks', label: 'Checks', ...(checksWarn(review.value?.checks) ? { icon: 'warning' as const } : {}) },
  { value: 'pending', label: 'Pending', count: changes.value.length },
  { value: 'refusals', label: 'Refusals', count: review.value?.refusals.total ?? 0 },
]);

watch(name, (current) => { if (current !== undefined) { void store.open(current); void system.open(current); } }, { immediate: true });
watch([tab, name, rule], ([current, open, picked]) => {
  if (open === undefined) { return; }
  if (current === 'parts') { void parts.loadOthers(open); }
  if (current === 'refusals') { void store.loadRefusals(open, picked === 'all' ? undefined : picked); }
}, { immediate: true });
onBeforeUnmount(() => { store.close(); parts.close(); system.close(); });

const isOn = (item: ItemRef): boolean => store.isOn(item);

async function switchItem(item: ItemRef, on: boolean): Promise<void> {
  if (!await store.switch(item, on)) { toasts.error(store.switching.problem.value); }
}
const switchDeclared = (item: DeclaredItem, on: boolean): Promise<void> => switchItem({ section: item.section, name: item.name }, on);

/** The fn being test-called, and the run its last test started. */
const testing = ref<FnReview | undefined>(undefined);
const testRun = ref<RunId | undefined>(undefined);
function startTest(fn: FnReview): void { testing.value = fn; testRun.value = undefined; store.testing.problem.value = ''; }
async function testCall(args: Json): Promise<void> {
  const fn = testing.value;
  if (fn === undefined) { return; }
  const result = await store.testCall(fn.name, args);
  if (result.ok) { testRun.value = result.value; toasts.ok('Test started', `${fn.name} is running as you.`); }
}
const runPage = (run: RunId): RouteLocationRaw => links.runs({ run });
const rootPage = (root: ResourceRoot): RouteLocationRaw => (name.value === undefined ? links.systems() : links.explore(name.value, MAIN_INSTANCE, [root.name]));
const ownerPage = (section: SystemPartSection, owner: QualifiedName): RouteLocationRaw => (section === 'examples' ? links.fn(owner) : links.contextItem(owner));

const offCount = computed(() => review.value?.off.length ?? 0);
const goLiveBody = computed(() => `Its ${fns.value.length} fns, ${context.value.length} context items and the rest of what it declares become available${offCount.value > 0 ? `, except the ${offCount.value} switched off` : ''}. Changes after this wait for review.`);

async function goLive(): Promise<void> {
  const result = await store.goLive();
  confirming.value = false;
  if (result.ok) { toasts.ok(`${name.value ?? 'The system'} is live`); } else { toasts.error(result.problem); }
}
async function approve(): Promise<void> {
  const result = await store.approve();
  if (result.ok) { toasts.ok('Changes approved'); } else { toasts.error(result.problem); }
}
async function reject(): Promise<void> {
  const result = await store.reject();
  if (result.ok) { toasts.ok('Changes rejected', 'The live version stays; the changes stay off.'); } else { toasts.error(result.problem); }
}
async function save(config: Json): Promise<void> {
  const result = await system.configure(config);
  problems.value = result.ok ? [] : result.problems;
  if (result.ok) { toasts.ok('Config saved', `Version ${result.version}`); }
}
</script>

<template>
  <AppPage :title="name === undefined ? 'Review' : `Review ${name}`" :description="review?.manifest.description ?? ''" keep-title>
    <template #crumb>
      <RouterLink :to="name === undefined ? links.systems() : links.system(name)" class="crumb" data-testid="back-to-system"><UiIcon name="chevron-left" :size="14" />{{ name ?? 'Systems' }}</RouterLink>
    </template>
    <template v-if="review" #actions>
      <StatusBadge :look="STAGE_LOOK[review.stage]" />
      <UiButton v-if="review.stage === 'installed'" variant="primary" icon="play" :loading="store.deciding.busy.value" data-testid="go-live" @click="confirming = true">Go live</UiButton>
      <template v-else-if="review.pending">
        <UiButton variant="ghost" :disabled="store.deciding.busy.value" data-testid="reject-review" @click="reject">Reject</UiButton>
        <UiButton variant="primary" icon="check" :loading="store.deciding.busy.value" data-testid="approve-review" @click="approve">Approve changes</UiButton>
      </template>
    </template>
    <LoadState :loading="store.review.loading.value" :problem="store.review.problem.value" :ready="review !== undefined" :empty="false" :lines="8" @retry="name && store.open(name)">
      <template v-if="review">
        <UiBanner v-if="review.pending" tone="warn" data-testid="review-pending">
          {{ changes.length }} {{ changes.length === 1 ? 'change waits' : 'changes wait' }} ({{ review.pending.by === 'contract' ? `version ${review.pending.version}` : 'added while running' }}). The live version keeps working; the changes stay off until approved.
        </UiBanner>
        <p v-else class="dim" data-testid="review-stage">{{ STAGE_ABOUT[review.stage] }} <span class="checks">{{ checksLine(review.checks) }}.</span></p>
        <UiTabs v-model="tab" :tabs="tabs" label="Review" />
        <ReviewFnList v-if="tab === 'fns'" :fns="fns" :busy="store.switching.busy.value" :page-of="links.fn" @switch="(fn, on) => switchItem({ section: 'fns', name: fn }, on)" @test="startTest" />
        <template v-else-if="tab === 'context' || tab === 'types'">
          <UiEmpty v-if="(tab === 'context' ? context : types).length === 0" icon="layers" :title="tab === 'context' ? 'No context' : 'No types'" :body="`It declares no ${tab === 'context' ? 'context' : 'named types'}.`" />
          <DeclaredList v-else :items="tab === 'context' ? context : types" :busy="store.switching.busy.value" :page-of="tab === 'context' ? links.contextItem : undefined" @switch="switchDeclared" />
        </template>
        <LoadState
          v-else-if="tab === 'parts'" :loading="parts.others.loading.value" :problem="parts.others.problem.value || parts.roots.problem.value" :ready="others !== undefined"
          :empty="groups.length === 0 && roots.length === 0" empty-icon="layers" empty-title="Nothing else" empty-body="It adds only fns, context and types." @retry="name && parts.loadOthers(name)"
        >
          <PartsByKind v-model:part="part" :groups="groups" :roots="roots" :root-page="rootPage" :owner-page="ownerPage" :is-on="isOn" :busy="store.switching.busy.value" @switch="switchItem" />
        </LoadState>
        <SystemGraph v-else-if="tab === 'graph'" :system="review.system" />
        <GrantsView v-else-if="tab === 'grants'" :grants="review.manifest.grants" />
        <LoadState v-else-if="tab === 'config'" :loading="system.view.loading.value" :problem="system.view.problem.value" :ready="view !== undefined" :empty="false" @retry="name && system.open(name)">
          <ConfigWithCustom
            v-if="view" :type="view.configType" :value="view.config?.value" :version="view.config?.version" :set-at="view.config?.setAt" :needs-config="view.needsConfig" :now="now"
            :busy="system.config.busy.value" :problems="problems" :secrets="secretFields(view.configSecrets, view.config?.value)" :target="target" :loader="loader" @save="save"
          />
        </LoadState>
        <ChecksView v-else-if="tab === 'checks'" :checks="review.checks" />
        <template v-else-if="tab === 'pending'">
          <UiEmpty v-if="changes.length === 0" icon="check" title="Nothing waits" :body="review.stage === 'installed' ? 'It isn’t live yet: everything is under review.' : 'What is live is what was reviewed.'" />
          <ChangeList v-else :changes="changes" />
        </template>
        <LoadState
          v-else :loading="store.refusals.loading.value" :problem="store.refusals.problem.value" :ready="store.refusals.loaded.value" :empty="false" @retry="store.refusals.load()"
        >
          <RefusalList v-model:rule="rule" :refusals="store.refusals.items.value" :now="now" :run-page="runPage" />
          <UiEmpty v-if="store.refusals.items.value.length === 0" icon="shield" title="No refusals" body="The hub hasn't refused anything it tried." />
          <UiButton v-if="store.refusals.hasMore.value" class="more" variant="ghost" size="sm" :loading="store.refusals.loadingMore.value" @click="store.refusals.more()">Show more</UiButton>
        </LoadState>
      </template>
    </LoadState>
    <TestCallDialog
      :fn="testing?.decl" :title="testing?.name ?? ''" :busy="store.testing.busy.value" :problem="store.testing.problem.value" :run="testRun" :run-page="runPage"
      @call="testCall" @close="testing = undefined"
    />
    <ConfirmDialog v-model:open="confirming" :title="`Make ${name ?? 'it'} live?`" :body="goLiveBody" confirm="Go live" :danger="false" :busy="store.deciding.busy.value" @confirm="goLive" />
  </AppPage>
</template>

<style scoped>
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.checks { color: var(--text-faint); }
.more { justify-self: start; margin-top: var(--space-2); }
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); text-decoration: none; }
.crumb:focus-visible { border-radius: var(--radius-sm); outline: none; box-shadow: var(--ring); }
</style>
