<script setup lang="ts">
/**
 * One system's page, its tab in the URL: the overview (switches, facts, process and maintenance), its instances (a
 * fleet's copies, each with its own page; another copy can be installed from a package zip), or, for a system that runs
 * one instance, that instance's data (its facts are already the overview's, and its old page sends here), its config
 * form, what it added to the hub (its fns and its context items, each switched on or off by itself and all at once
 * with a master switch, each with its own page; its named types; everything else it added: resource roots, kinds, commands, providers, components, examples, …, one kind at a
 * time and each with its own switch), the calls the hub refused, and its live output. While it is only installed (or
 * changes wait), a banner says so with the link to its review; a live system has a Review link beside its status.
 * Removing asks first.
 */
import { MAIN_INSTANCE, SystemName, type AutoPairId, type InstanceName, type ItemRef, type Json, type QualifiedName, type RefusalRule, type ResourceRoot, type RunId, type SystemEnabled, type SystemPartSection } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { links, ROUTES } from '../../app/routes.ts';
import { useParamChoice, useRouteQuery } from '../../app/url.ts';
import { useStores } from '../../state/stores.ts';
import { UiBanner, UiButton, UiEmpty, UiIcon, UiSwitch, UiTabs, type TabItem } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import AllSwitch from '../components/AllSwitch.vue';
import FnList from '../components/FnList.vue';
import InstanceData from '../components/InstanceData.vue';
import InstallDialog from '../components/InstallDialog.vue';
import AutoPairList from '../components/AutoPairList.vue';
import ContextRow from '../../context/components/ContextRow.vue';
import InstanceTypes from '../components/InstanceTypes.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import InstanceList from '../components/InstanceList.vue';
import type { PackageOptions } from '../state/packages.ts';
import LoadState from '../components/LoadState.vue';
import LogView from '../components/LogView.vue';
import StatusBadge from '../components/StatusBadge.vue';
import ConnectSetup from '../components/ConnectSetup.vue';
import ConfigWithCustom from '../components/ConfigWithCustom.vue';
import PartsByKind from '../components/PartsByKind.vue';
import SystemGraph from '../../graph/components/SystemGraph.vue';
import RefusalList from '../components/RefusalList.vue';
import SystemOverview from '../components/SystemOverview.vue';
import { partGroups, SYSTEM_STATUS_LOOK, type SystemAction } from '../logic/systems.ts';
import { contextLabel } from '../../context/logic/context.ts';
import { secretFields } from '../logic/instances.ts';
import { PartTab, SystemTab } from '../sections.ts';
import { configComponentsOf, configTarget } from '../state/config-component.ts';

const { admin, toasts, chat } = useStores();
const store = admin.system;
const parts = admin.systemParts;
const reviews = admin.review;
/** No change waits on a system's own types here; an instance's page shows those. */
const NO_CHANGES: ReadonlySet<string> = new Set();
const route = useRoute();
const router = useRouter();
const now = useNow();
const tab = useParamChoice('tab', SystemTab, 'overview');
const part = useRouteQuery(ROUTES.system).choice('part', PartTab, 'roots');
const name = computed(() => { const parsed = SystemName.safeParse(route.params['name']); return parsed.success ? parsed.data : undefined; });
const view = computed(() => store.view.value.value);
/** A system that runs one instance shows it here: no Instances tab, its `main` instance's data on a tab of its own. */
const single = computed(() => view.value?.instanceMode === 'one');
const main = computed(() => view.value?.instances.find((i) => i.instance === MAIN_INSTANCE));
const exported = ref<{ readonly url: string; readonly size: number } | undefined>(undefined);
// a tab this system doesn't have (a single instance's Instances, a fleet's Data) reads as its overview
// (keyed on the loaded mode, so a fleet opened straight at its Data tab is sent on once its view arrives)
watch([() => view.value?.instanceMode, tab, name], ([mode, current, system]) => {
  if (system === undefined || mode === undefined) { return; }
  if ((mode === 'one' && current === 'instances') || (mode === 'many' && current === 'data')) { void router.replace(links.system(system)); }
}, { immediate: true });
const problems = ref<readonly string[]>([]);
const removing = ref(false);
const installOpen = ref(false);
const autoPairs = admin.autoPairs;
const revoking = ref<AutoPairId | undefined>(undefined);
const revokeOpen = computed({ get: () => revoking.value !== undefined, set: (isOpen) => { if (!isOpen) { revoking.value = undefined; } } });
watch([tab, name], ([current, system]) => { if (current === 'instances' && system !== undefined) { void autoPairs.load(system); } }, { immediate: true });

async function revoke(): Promise<void> {
  const id = revoking.value;
  if (id === undefined) { return; }
  const result = await autoPairs.revoke(id);
  revoking.value = undefined;
  if (result.ok) { toasts.ok('Revoked', 'That instance can no longer pair by itself.'); } else { toasts.error(result.problem); }
}
/** An instance's page. */
const instancePage = (instance: InstanceName): RouteLocationRaw => (name.value === undefined ? links.systems() : links.instance(name.value, instance));

async function installZip(zip: File, options: PackageOptions): Promise<void> {
  const result = await admin.packages.installZip(zip, options);
  if (!result.ok) { return; }
  installOpen.value = false;
  toasts.ok(`Installing ${result.value.system}@${result.value.instance}`, 'It pairs and starts by itself.');
  if (name.value !== undefined) { void store.open(name.value); }
}

/** Its review: its stage, the items switched off, its own config component and its refusals (build 7). */
const review = computed(() => reviews.review.value.value);
const stage = computed(() => review.value?.stage ?? view.value?.stage ?? 'live');
const loader = configComponentsOf(chat);
const target = computed(() => (review.value === undefined ? undefined : configTarget(review.value.manifest)));
const rule = ref<RefusalRule | 'all'>('all');
watch(rule, (picked) => { if (name.value !== undefined) { void reviews.loadRefusals(name.value, picked === 'all' ? undefined : picked); } });
const runPage = (run: RunId): RouteLocationRaw => links.runs({ run });
const partOn = (item: ItemRef): boolean => reviews.isOn(item);

async function switchPart(item: ItemRef, on: boolean): Promise<void> {
  if (!await reviews.switch(item, on)) { toasts.error(reviews.switching.problem.value); return; }
  if (name.value !== undefined) { void parts.loadOthers(name.value); }
}

/** Its counts: the hub's, with the system; a tab's own once its list has read it afresh. */
const counts = computed(() => view.value?.counts);

const tabs = computed<readonly TabItem<SystemTab>[]>(() => [
  { value: 'overview', label: 'Overview' },
  ...(single.value ? [] : [{ value: 'instances' as const, label: 'Instances', count: counts.value?.instances ?? 0 }]),
  { value: 'config', label: 'Config' },
  { value: 'fns', label: 'Fns', count: store.fns.value.value?.length ?? counts.value?.fns ?? 0 },
  { value: 'context', label: 'Context', count: parts.contextCount.value ?? counts.value?.context ?? 0 },
  { value: 'types', label: 'Types', count: parts.typeCount.value ?? counts.value?.types ?? 0 },
  // its resource roots are live from its instance, so they count once read
  { value: 'parts', label: 'Other parts', count: others.value === undefined ? counts.value?.parts ?? 0 : otherCount.value },
  { value: 'graph', label: 'Graph' },
  { value: 'refusals', label: 'Refusals', count: review.value?.refusals.total ?? counts.value?.refusals ?? 0 },
  // every system's output reaches the hub (an installed one's process, a paired one's log lines), so the tab is always there
  { value: 'logs', label: 'Output' },
  ...(single.value ? [{ value: 'data' as const, label: 'Data' }] : []),
]);

/** Export its one instance's data. */
async function exportData(withSecrets: boolean): Promise<void> {
  if (name.value === undefined) { return; }
  const result = await admin.instance.exportData(withSecrets, { system: name.value, instance: MAIN_INSTANCE });
  if (result.ok) { exported.value = result.value; toasts.ok('Data exported', 'The zip is ready to download.'); } else { toasts.error(result.problem); }
}

watch(name, (system) => {
  if (system !== undefined) { void store.open(system); void reviews.open(system); void admin.actors.load(); }
}, { immediate: true });

watch([tab, name], ([current, system]) => {
  problems.value = [];
  if (current === 'fns') { void store.loadFns(); }
  if (current === 'context' && system !== undefined) { void parts.loadContext(system); }
  if (current === 'types' && system !== undefined) { void parts.loadTypes(system); }
  if (system !== undefined && (current === 'parts' || parts.others.value.value === undefined)) { void parts.loadOthers(system); }
  if (current === 'refusals' && system !== undefined) { void reviews.loadRefusals(system, rule.value === 'all' ? undefined : rule.value); }
  if (current === 'logs') { void store.followLogs(); } else { store.unfollowLogs(); }
}, { immediate: true });

onBeforeUnmount(() => { store.close(); parts.close(); reviews.close(); });

async function save(config: Json): Promise<void> {
  const result = await store.configure(config);
  problems.value = result.ok ? [] : result.problems;
  if (result.ok) {
    toasts.ok('Config saved', `Version ${result.version}`);
    // a per-person system's page becomes ready once its config is valid
    if (connectPage.value !== undefined) { void chat.connections.load(true); }
  }
}

/** The page people connect their own account on, when this system has one (a calendar). */
const connectPage = computed(() => (name.value === undefined ? undefined : chat.connections.page(name.value)));
/** Where the provider sends people back to: this hub's `/connect/callback`. */
const redirect = `${window.location.origin}/connect/callback`;

async function enable(part: keyof SystemEnabled, on: boolean): Promise<void> {
  if (!await store.enable(part, on)) { toasts.error(store.enabling.problem.value); }
}

/** Everything else it added, under its headings, and how many parts that is (with its resource roots). */
const others = computed(() => parts.others.value.value);
const groups = computed(() => (others.value === undefined ? [] : partGroups(others.value)));
const roots = computed(() => parts.roots.value.value ?? []);
const otherCount = computed(() => groups.value.reduce((sum, group) => sum + group.total, roots.value.length));
const rootPage = (root: ResourceRoot): RouteLocationRaw => (name.value === undefined ? links.systems() : links.explore(name.value, MAIN_INSTANCE, [root.name]));
/** An example's fn page, or a `/command`'s context item page. */
const ownerPage = (section: SystemPartSection, owner: QualifiedName): RouteLocationRaw => (section === 'examples' ? links.fn(owner) : links.contextItem(owner));

async function switchFn(fn: QualifiedName, on: boolean): Promise<void> {
  if (!await store.switchFn(fn, on)) { toasts.error(store.switching.problem.value); }
}

async function switchContext(item: QualifiedName, on: boolean): Promise<void> {
  if (!await parts.switchContext(item, on)) { toasts.error(parts.switching.problem.value); }
}

async function act(action: SystemAction, version?: string): Promise<void> {
  if (action === 'remove' && !removing.value) { removing.value = true; return; }
  const system = name.value;
  const result = await store.act(action, version);
  removing.value = false;
  if (!result.ok) { toasts.error(result.problem); return; }
  const outcome = result.value;
  if (outcome.kind === 'upgrade') { toasts.ok(`Upgraded to ${outcome.to}`, `From ${outcome.from}.`); }
  else if (outcome.kind === 'reimport') {
    const { added, updated, removed, refused } = outcome.report;
    toasts.push({ tone: refused.length > 0 ? 'warn' : 'ok', title: 'Reimported', body: `${added.length} added, ${updated.length} changed, ${removed.length} removed${refused.length > 0 ? `, ${refused.length} refused` : ''}.` });
  } else if (action === 'remove') {
    toasts.ok(`Removed ${system ?? 'the system'}`);
    await router.push(links.systems());
  } else { toasts.ok(`${action === 'start' ? 'Started' : action === 'stop' ? 'Stopped' : 'Restarted'} ${system ?? ''}`); }
}
</script>

<template>
  <AppPage :title="name ?? 'System'" :description="view?.description ?? ''" keep-title>
    <template #crumb>
      <RouterLink :to="links.systems()" class="crumb" data-testid="back-to-systems"><UiIcon name="chevron-left" :size="14" />Systems</RouterLink>
    </template>
    <template v-if="view" #actions>
      <!-- the banner below says when it is not live or changes wait, with its own link to the review: the header
           doesn't repeat it. On a phone the links are icons, so they and the status share one row -->
      <RouterLink v-if="name !== undefined && view.status === 'connected'" :to="links.explore(name, MAIN_INSTANCE)" class="waiting" title="Files" data-testid="system-explore">
        <UiIcon name="folder" :size="14" /><span class="word">Files</span>
      </RouterLink>
      <RouterLink v-if="name !== undefined" :to="links.waitingRuns(name)" class="waiting" title="Waiting runs" data-testid="system-waiting-runs">
        <UiIcon name="shield" :size="14" /><span class="word">Waiting runs</span>
      </RouterLink>
      <RouterLink v-if="name !== undefined && stage === 'live' && review?.pending === undefined" :to="links.review(name)" class="waiting" title="Review" data-testid="system-review">
        <UiIcon name="eye" :size="14" /><span class="word">Review</span>
      </RouterLink>
      <StatusBadge :look="SYSTEM_STATUS_LOOK[view.status]" />
    </template>
    <LoadState :loading="store.view.loading.value" :problem="store.view.problem.value" :ready="view !== undefined" :empty="false" :lines="8" @retry="name && store.open(name)">
      <template v-if="view">
        <UiBanner v-if="stage === 'installed'" tone="warn" data-testid="system-installed">
          Not live yet: nothing it offers is used until it is reviewed.
          <template #actions><RouterLink v-if="name !== undefined" :to="links.review(name)">Review and go live</RouterLink></template>
        </UiBanner>
        <UiBanner v-else-if="review?.pending" tone="warn" data-testid="system-pending">
          Changes wait for review; the live version keeps working.
          <template #actions><RouterLink v-if="name !== undefined" :to="links.review(name, 'pending')">Review changes</RouterLink></template>
        </UiBanner>
        <UiTabs v-model="tab" :tabs="tabs" label="System" />
        <SystemOverview v-if="tab === 'overview'" :system="view" :now="now" :acting="store.acting.value" :name-of="admin.actors.nameOf" @enable="enable" @act="act" />
        <div v-else-if="tab === 'instances'" class="instances">
          <div class="bar">
            <p class="dim">Each attached copy of {{ view.name }} is an instance with its own key, config and folders. Runs pick one by its resources, the chat’s pin, or the default.</p>
            <UiButton icon="plus" data-testid="add-instance" @click="installOpen = true">Install another</UiButton>
          </div>
          <InstanceList :instances="view.instances" :now="now" :default-instance="view.defaultInstance" :page-of="instancePage" />
          <template v-if="(autoPairs.secrets.value.value?.length ?? 0) > 0">
            <h3 class="sub">Auto pair secrets</h3>
            <AutoPairList :secrets="autoPairs.secrets.value.value ?? []" :now="now" :busy="autoPairs.revoking.busy.value" @revoke="revoking = $event" />
          </template>
        </div>
        <div v-else-if="tab === 'config'" class="config-tab">
          <ConnectSetup
            v-if="connectPage !== undefined" :title="connectPage.decl.title" :redirect="redirect" :ready="connectPage.ready" :page="links.connect(connectPage.system)"
            @copied="(ok) => (ok ? toasts.ok('Copied') : toasts.error('Couldn’t copy.'))"
          />
          <ConfigWithCustom
            :type="view.configType" :value="view.config?.value" :version="view.config?.version" :set-at="view.config?.setAt" :needs-config="view.needsConfig" :now="now"
            :busy="store.config.busy.value" :problems="problems" :secrets="secretFields(view.configSecrets, view.config?.value)" :target="target" :loader="loader" @save="save"
          />
        </div>
        <LoadState
          v-else-if="tab === 'fns'" :loading="store.fns.loading.value" :problem="store.fns.problem.value" :ready="store.fns.value.value !== undefined"
          :empty="(store.fns.value.value?.length ?? 0) === 0" empty-icon="fn" empty-title="No fns" empty-body="This system doesn't add any fns." @retry="store.loadFns()"
        >
          <RouterLink v-if="name !== undefined" :to="links.systemFns(name)" class="search-fns" data-testid="search-system-fns"><UiIcon name="search" :size="14" />Search and sort in Fns</RouterLink>
          <AllSwitch
            :on="view.enabled.functions" label="Use its fns" testid="system-fns-all" on-text="Its fns, mentions and hooks can be used, unless a fn is switched off by itself."
            off-text="All of its fns are off, and its mentions and hooks with them; each fn keeps its own switch for when they are back on."
            @switch="enable('functions', $event)"
          />
          <FnList :fns="store.fns.value.value ?? []" :now="now" :runs-of="links.fnRuns" switchable @switch="switchFn" @switched="(fn, on) => store.fnSwitched(fn, on)" />
        </LoadState>
        <LoadState
          v-else-if="tab === 'context'" :loading="parts.context.loading.value" :problem="parts.context.problem.value" :ready="parts.context.loaded.value"
          :empty="parts.context.items.value.length === 0" empty-icon="layers" empty-title="No context" empty-body="This system doesn't add any context." @retry="name && parts.loadContext(name)"
        >
          <RouterLink v-if="name !== undefined" :to="links.systemContext(name)" class="search-fns" data-testid="search-system-context"><UiIcon name="search" :size="14" />Search and sort in Context</RouterLink>
          <AllSwitch
            :on="view.enabled.context !== false" label="Use its context" testid="system-context-all" on-text="Every item below can be selected, searched and loaded, unless switched off by itself."
            off-text="All of it is off; each item keeps its own switch for when it is back on."
            @switch="enable('context', $event)"
          />
          <div class="list" data-testid="system-context">
            <div v-for="item in parts.context.items.value" :key="item.name" class="switch-row">
              <UiSwitch :model-value="item.disabled !== true" :label="`Use ${contextLabel(item.decl)}`" hide-label data-testid="context-switch" @update:model-value="switchContext(item.name, $event)" />
              <ContextRow :record="item" :to="links.contextItem(item.name)" :now="now" detailed />
            </div>
          </div>
          <UiButton v-if="parts.context.hasMore.value" class="more" variant="ghost" size="sm" :loading="parts.context.loadingMore.value" @click="parts.context.more()">Show more context</UiButton>
        </LoadState>
        <LoadState
          v-else-if="tab === 'types'" :loading="parts.types.loading.value" :problem="parts.types.problem.value" :ready="parts.types.loaded.value"
          :empty="parts.types.items.value.length === 0" empty-icon="braces" empty-title="No types" empty-body="This system doesn't name any types." @retry="name && parts.loadTypes(name)"
        >
          <InstanceTypes :types="parts.types.items.value" :changing="NO_CHANGES" detailed />
          <UiButton v-if="parts.types.hasMore.value" class="more" variant="ghost" size="sm" :loading="parts.types.loadingMore.value" @click="parts.types.more()">Show more types</UiButton>
        </LoadState>
        <LoadState
          v-else-if="tab === 'parts'" :loading="parts.others.loading.value" :problem="parts.others.problem.value || parts.roots.problem.value" :ready="others !== undefined"
          :empty="otherCount === 0" empty-icon="layers" empty-title="Nothing else" empty-body="This system adds only fns, context and types." @retry="name && parts.loadOthers(name)"
        >
          <PartsByKind
            v-model:part="part" :groups="groups" :roots="roots" :root-page="rootPage" :owner-page="ownerPage" :is-on="review === undefined ? undefined : partOn"
            :busy="reviews.switching.busy.value" :system="name" @switch="switchPart"
          />
        </LoadState>
        <SystemGraph v-else-if="tab === 'graph' && name" :system="name" />
        <InstanceData v-else-if="tab === 'data'" :dirs="main?.dirs" :busy="admin.instance.exporting.busy.value" :exported="exported" @export="exportData" />
        <LoadState
          v-else-if="tab === 'refusals'" :loading="reviews.refusals.loading.value" :problem="reviews.refusals.problem.value" :ready="reviews.refusals.loaded.value" :empty="false"
          @retry="reviews.refusals.load()"
        >
          <RefusalList v-model:rule="rule" :refusals="reviews.refusals.items.value" :now="now" :run-page="runPage" />
          <UiEmpty v-if="reviews.refusals.items.value.length === 0" icon="shield" title="No refusals" body="The hub hasn't refused anything it tried." />
          <UiButton v-if="reviews.refusals.hasMore.value" class="more" variant="ghost" size="sm" :loading="reviews.refusals.loadingMore.value" @click="reviews.refusals.more()">Show more</UiButton>
        </LoadState>
        <LoadState v-else :loading="store.logs.loading.value" :problem="store.logs.problem.value" :ready="store.logs.value.value !== undefined" :empty="false" @retry="store.followLogs()">
          <LogView :lines="store.logs.value.value ?? []" />
        </LoadState>
      </template>
    </LoadState>
    <InstallDialog
      v-model:open="installOpen" from="zip" :busy="admin.packages.install.busy.value" :problem="admin.packages.install.problem.value" :progress="admin.packages.progress.value"
      @install-zip="installZip"
    />
    <ConfirmDialog
      v-model:open="removing" :title="`Remove ${name ?? 'this system'}?`" :busy="store.acting.value === 'remove'" confirm="Remove"
      :body="`Its ${view?.counts.fns ?? 0} fns stop working until it pairs again. Its runs and messages stay.`" @confirm="act('remove')"
    />
    <ConfirmDialog
      v-model:open="revokeOpen" title="Revoke this auto pair secret?" :busy="autoPairs.revoking.busy.value" confirm="Revoke"
      body="The instance stays paired, but can no longer pair again by itself. Pairing it anew can give it a new secret." @confirm="revoke"
    />
  </AppPage>
</template>

<style scoped>
.instances { display: grid; gap: var(--space-3); }
.list { display: grid; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.list > * + * { border-top: 1px solid var(--border); }
.switch-row { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; padding-left: var(--space-4); }
.more { justify-self: start; margin-top: var(--space-2); }
.config-tab { display: grid; gap: var(--space-4); }
.search-fns { display: inline-flex; align-items: center; gap: var(--space-1); margin-bottom: var(--space-2); font-size: var(--text-sm); }
.waiting { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--text-sm); white-space: nowrap; }
@media (max-width: 759.98px) {
  .waiting { position: relative; justify-content: center; min-width: 32px; min-height: 32px; border-radius: var(--radius); }
  .waiting .word { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
}
.sub { margin: var(--space-2) 0 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
.bar .dim { flex: 1 1 280px; }
.dim { color: var(--text-dim); font-size: var(--text-sm); }
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); text-decoration: none; }
.crumb:focus-visible { border-radius: var(--radius-sm); outline: none; box-shadow: var(--ring); }
</style>
