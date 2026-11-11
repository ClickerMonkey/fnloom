<script setup lang="ts">
/**
 * One system's page, its tab in the URL: the overview (switches, facts, process and maintenance), its instances (a
 * fleet's copies, each with its own page; another copy can be installed from a package zip), its config form, what it
 * added to the hub (its fns, each with its own page of metrics; its context items, each with its key; its named types),
 * and its live output. Removing asks first.
 */
import { MAIN_INSTANCE, SystemName, type AutoPairId, type InstanceName, type Json, type SystemEnabled } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { links } from '../../app/routes.ts';
import { useParamChoice } from '../../app/url.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiIcon, UiTabs, type TabItem } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import FnList from '../components/FnList.vue';
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
import SystemConfig from '../components/SystemConfig.vue';
import SystemOverview from '../components/SystemOverview.vue';
import { SYSTEM_STATUS_LOOK, type SystemAction } from '../logic/systems.ts';
import { secretFields } from '../logic/instances.ts';
import { SystemTab } from '../sections.ts';

const { admin, toasts, chat } = useStores();
const store = admin.system;
const parts = admin.systemParts;
/** No change waits on a system's own types here; an instance's page shows those. */
const NO_CHANGES: ReadonlySet<string> = new Set();
const route = useRoute();
const router = useRouter();
const now = useNow();
const tab = useParamChoice('tab', SystemTab, 'overview');
const name = computed(() => { const parsed = SystemName.safeParse(route.params['name']); return parsed.success ? parsed.data : undefined; });
const view = computed(() => store.view.value.value);
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

const tabs = computed<readonly TabItem<SystemTab>[]>(() => [
  { value: 'overview', label: 'Overview' },
  { value: 'instances', label: 'Instances', count: view.value?.instances.length ?? 0 },
  { value: 'config', label: 'Config' },
  { value: 'fns', label: 'Fns', count: view.value?.fns ?? 0 },
  { value: 'context', label: 'Context', ...(parts.contextCount.value === undefined ? {} : { count: parts.contextCount.value }) },
  { value: 'types', label: 'Types', ...(parts.typeCount.value === undefined ? {} : { count: parts.typeCount.value }) },
  // every system's output reaches the hub (an installed one's process, a paired one's log lines), so the tab is always there
  { value: 'logs', label: 'Output' },
]);

watch(name, (system) => {
  if (system !== undefined) { void store.open(system); void admin.actors.load(); }
}, { immediate: true });

watch([tab, name], ([current, system]) => {
  problems.value = [];
  if (current === 'fns') { void store.loadFns(); }
  if (current === 'context' && system !== undefined) { void parts.loadContext(system); }
  if (current === 'types' && system !== undefined) { void parts.loadTypes(system); }
  if (current === 'logs') { void store.followLogs(); } else { store.unfollowLogs(); }
}, { immediate: true });

onBeforeUnmount(() => { store.close(); parts.close(); });

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
      <RouterLink v-if="name !== undefined && view.status === 'connected'" :to="links.explore(name, MAIN_INSTANCE)" class="waiting" data-testid="system-explore"><UiIcon name="folder" :size="14" />Files</RouterLink>
      <RouterLink v-if="name !== undefined" :to="links.waitingRuns(name)" class="waiting" data-testid="system-waiting-runs"><UiIcon name="shield" :size="14" />Waiting runs</RouterLink>
      <StatusBadge :look="SYSTEM_STATUS_LOOK[view.status]" />
    </template>
    <LoadState :loading="store.view.loading.value" :problem="store.view.problem.value" :ready="view !== undefined" :empty="false" :lines="8" @retry="name && store.open(name)">
      <template v-if="view">
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
          <SystemConfig
            :type="view.configType" :value="view.config?.value" :version="view.config?.version" :set-at="view.config?.setAt"
            :needs-config="view.needsConfig" :now="now" :busy="store.config.busy.value" :problems="problems" :secrets="secretFields(view.configSecrets, view.config?.value)" @save="save"
          />
        </div>
        <LoadState
          v-else-if="tab === 'fns'" :loading="store.fns.loading.value" :problem="store.fns.problem.value" :ready="store.fns.value.value !== undefined"
          :empty="(store.fns.value.value?.length ?? 0) === 0" empty-icon="fn" empty-title="No fns" empty-body="This system doesn't add any fns." @retry="store.loadFns()"
        >
          <RouterLink v-if="name !== undefined" :to="links.systemFns(name)" class="search-fns" data-testid="search-system-fns"><UiIcon name="search" :size="14" />Search and sort in Fns</RouterLink>
          <FnList :fns="store.fns.value.value ?? []" :now="now" :runs-of="links.fnRuns" :page-of="(fn) => links.fn(fn)" />
        </LoadState>
        <LoadState
          v-else-if="tab === 'context'" :loading="parts.context.loading.value" :problem="parts.context.problem.value" :ready="parts.context.loaded.value"
          :empty="parts.context.items.value.length === 0" empty-icon="layers" empty-title="No context" empty-body="This system doesn't add any context." @retry="name && parts.loadContext(name)"
        >
          <RouterLink v-if="name !== undefined" :to="links.systemContext(name)" class="search-fns" data-testid="search-system-context"><UiIcon name="search" :size="14" />Search and sort in Context</RouterLink>
          <div class="list" data-testid="system-context">
            <ContextRow v-for="item in parts.context.items.value" :key="item.name" :record="item" :to="links.contextItem(item.name)" :now="now" keyed />
          </div>
          <UiButton v-if="parts.context.hasMore.value" class="more" variant="ghost" size="sm" :loading="parts.context.loadingMore.value" @click="parts.context.more()">Show more context</UiButton>
        </LoadState>
        <LoadState
          v-else-if="tab === 'types'" :loading="parts.types.loading.value" :problem="parts.types.problem.value" :ready="parts.types.loaded.value"
          :empty="parts.types.items.value.length === 0" empty-icon="braces" empty-title="No types" empty-body="This system doesn't name any types." @retry="name && parts.loadTypes(name)"
        >
          <InstanceTypes :types="parts.types.items.value" :changing="NO_CHANGES" />
          <UiButton v-if="parts.types.hasMore.value" class="more" variant="ghost" size="sm" :loading="parts.types.loadingMore.value" @click="parts.types.more()">Show more types</UiButton>
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
      :body="`Its ${view?.fns ?? 0} fns stop working until it pairs again. Its runs and messages stay.`" @confirm="act('remove')"
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
.more { justify-self: start; margin-top: var(--space-2); }
.config-tab { display: grid; gap: var(--space-4); }
.search-fns { display: inline-flex; align-items: center; gap: var(--space-1); margin-bottom: var(--space-2); font-size: var(--text-sm); }
.waiting { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--text-sm); white-space: nowrap; }
.sub { margin: var(--space-2) 0 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
.bar .dim { flex: 1 1 280px; }
.dim { color: var(--text-dim); font-size: var(--text-sm); }
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); text-decoration: none; }
.crumb:focus-visible { border-radius: var(--radius-sm); outline: none; box-shadow: var(--ring); }
</style>
