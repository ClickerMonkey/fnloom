<script setup lang="ts">
/**
 * One system's page, its tab in the URL: the overview (switches, facts, process and maintenance), its instances (a
 * fleet's copies, each with its own page; another copy can be installed from a package zip), its config form, its fns
 * (each with its own page of metrics), and its live output. Removing asks first.
 */
import { SystemName, type InstanceName, type Json, type SystemEnabled } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { links } from '../../app/routes.ts';
import { useParamChoice } from '../../app/url.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiIcon, UiTabs, type TabItem } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import FnList from '../components/FnList.vue';
import InstallDialog from '../components/InstallDialog.vue';
import InstanceList from '../components/InstanceList.vue';
import type { PackageOptions } from '../state/packages.ts';
import LoadState from '../components/LoadState.vue';
import LogView from '../components/LogView.vue';
import StatusBadge from '../components/StatusBadge.vue';
import SystemConfig from '../components/SystemConfig.vue';
import SystemOverview from '../components/SystemOverview.vue';
import { SYSTEM_STATUS_LOOK, type SystemAction } from '../logic/systems.ts';
import { SystemTab } from '../sections.ts';

const { admin, toasts } = useStores();
const store = admin.system;
const route = useRoute();
const router = useRouter();
const now = useNow();
const tab = useParamChoice('tab', SystemTab, 'overview');
const name = computed(() => { const parsed = SystemName.safeParse(route.params['name']); return parsed.success ? parsed.data : undefined; });
const view = computed(() => store.view.value.value);
const problems = ref<readonly string[]>([]);
const removing = ref(false);
const installOpen = ref(false);
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
  // every system's output reaches the hub (an installed one's process, a paired one's log lines), so the tab is always there
  { value: 'logs', label: 'Output' },
]);

watch(name, (system) => {
  if (system !== undefined) { void store.open(system); void admin.actors.load(); }
}, { immediate: true });

watch([tab, name], ([current]) => {
  problems.value = [];
  if (current === 'fns') { void store.loadFns(); }
  if (current === 'logs') { void store.followLogs(); } else { store.unfollowLogs(); }
}, { immediate: true });

onBeforeUnmount(() => { store.close(); });

async function save(config: Json): Promise<void> {
  const result = await store.configure(config);
  problems.value = result.ok ? [] : result.problems;
  if (result.ok) { toasts.ok('Config saved', `Version ${result.version}`); }
}

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
    <LoadState :loading="store.view.loading.value" :problem="store.view.problem.value" :ready="view !== undefined" :empty="false" :lines="8" @retry="name && store.open(name)">
      <template v-if="view">
        <div class="status-row">
          <StatusBadge :look="SYSTEM_STATUS_LOOK[view.status]" />
          <span class="dim">v{{ view.version }} · {{ view.fns }} {{ view.fns === 1 ? 'fn' : 'fns' }}</span>
        </div>
        <UiTabs v-model="tab" :tabs="tabs" label="System" />
        <SystemOverview v-if="tab === 'overview'" :system="view" :now="now" :acting="store.acting.value" :name-of="admin.actors.nameOf" @enable="enable" @act="act" />
        <div v-else-if="tab === 'instances'" class="instances">
          <div class="bar">
            <p class="dim">Each attached copy of {{ view.name }} is an instance with its own key, config and folders. Runs pick one by its resources, the chat’s pin, or the default.</p>
            <UiButton icon="plus" data-testid="add-instance" @click="installOpen = true">Install another</UiButton>
          </div>
          <InstanceList :instances="view.instances" :now="now" :default-instance="view.defaultInstance" :page-of="instancePage" />
        </div>
        <SystemConfig
          v-else-if="tab === 'config'" :type="view.configType" :value="view.config?.value" :version="view.config?.version" :set-at="view.config?.setAt"
          :needs-config="view.needsConfig" :now="now" :busy="store.config.busy.value" :problems="problems" @save="save"
        />
        <LoadState
          v-else-if="tab === 'fns'" :loading="store.fns.loading.value" :problem="store.fns.problem.value" :ready="store.fns.value.value !== undefined"
          :empty="(store.fns.value.value?.length ?? 0) === 0" empty-icon="fn" empty-title="No fns" empty-body="This system doesn't add any fns." @retry="store.loadFns()"
        >
          <FnList :fns="store.fns.value.value ?? []" :now="now" :runs-of="(fn) => links.runs({ fn })" :page-of="(fn) => links.fn(fn)" />
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
  </AppPage>
</template>

<style scoped>
.instances { display: grid; gap: var(--space-3); }
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
.bar .dim { flex: 1 1 280px; }
.status-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
.dim { color: var(--text-dim); font-size: var(--text-sm); }
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); text-decoration: none; }
.crumb:focus-visible { border-radius: var(--radius-sm); outline: none; box-shadow: var(--ring); }
</style>
