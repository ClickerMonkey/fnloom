<script setup lang="ts">
/**
 * One instance of a system (`/admin/systems/:name/instances/:instance`), its tab in the URL: the overview (what it
 * said about itself, status, version, address, key, pairing and last sighting, its process when the hub runs it, and
 * removing it), its own config (checked against the system's config type), and its data (the folders the hub gives it
 * and an export of its data folder as a zip, its config's secrets only when asked).
 */
import { InstanceName, SystemName, type Json } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { links } from '../../app/routes.ts';
import { useParamChoice } from '../../app/url.ts';
import { formatBytes } from '../../chat/logic/format.ts';
import { useStores } from '../../state/stores.ts';
import { UiBanner, UiButton, UiCard, UiIcon, UiSwitch, UiTabs, fullTime, relativeTime, type TabItem } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import LoadState from '../components/LoadState.vue';
import StatusBadge from '../components/StatusBadge.vue';
import SystemConfig from '../components/SystemConfig.vue';
import { INSTALLED_STATUS_LOOK, SYSTEM_STATUS_LOOK } from '../logic/systems.ts';
import { InstanceTab } from '../sections.ts';

const { admin, toasts } = useStores();
const store = admin.instance;
const route = useRoute();
const router = useRouter();
const now = useNow();
const tab = useParamChoice('tab', InstanceTab, 'overview');
const key = computed(() => {
  const system = SystemName.safeParse(route.params['name']);
  const instance = InstanceName.safeParse(route.params['instance']);
  return system.success && instance.success ? { system: system.data, instance: instance.data } : undefined;
});
const view = computed(() => store.view.value);
const problems = ref<readonly string[]>([]);
const removing = ref(false);
const withSecrets = ref(false);
const exported = ref<{ readonly url: string; readonly size: number } | undefined>(undefined);
const title = computed(() => (key.value === undefined ? 'Instance' : `${key.value.system}@${key.value.instance}`));

const tabs = computed<readonly TabItem<InstanceTab>[]>(() => [
  { value: 'overview', label: 'Overview' },
  { value: 'config', label: 'Config' },
  { value: 'data', label: 'Data' },
]);

interface Fact { readonly label: string; readonly value: string; readonly title?: string }
const facts = computed<readonly Fact[]>(() => {
  const v = view.value;
  if (v === undefined) { return []; }
  const list: Fact[] = [{ label: 'Version', value: v.version }, { label: 'Key', value: v.keyFingerprint }];
  if (v.address !== undefined) { list.push({ label: 'Address', value: v.address }); }
  if (v.pairedAt !== undefined) { list.push({ label: 'Paired', value: `${relativeTime(v.pairedAt, now.value)}${v.pairedBy === undefined ? '' : ` by ${admin.actors.nameOf(v.pairedBy)}`}`, title: fullTime(v.pairedAt) }); }
  if (v.lastSeenAt !== undefined) { list.push({ label: 'Last seen', value: v.status === 'connected' ? 'Online now' : relativeTime(v.lastSeenAt, now.value), title: fullTime(v.lastSeenAt) }); }
  if (v.config !== undefined) { list.push({ label: 'Config', value: `Version ${v.config.version}, ${relativeTime(v.config.setAt, now.value)}`, title: fullTime(v.config.setAt) }); }
  list.push({ label: 'Manifest', value: v.manifestHash });
  return list;
});

watch(key, (k) => { if (k !== undefined) { void store.open(k); void admin.actors.load(); } }, { immediate: true });
watch(tab, () => { problems.value = []; });
onBeforeUnmount(() => { store.close(); });

async function save(config: Json): Promise<void> {
  const result = await store.configure(config);
  problems.value = result.ok ? [] : result.problems;
  if (result.ok) { toasts.ok('Config saved', `Version ${result.version}`); }
}

async function exportData(): Promise<void> {
  const result = await store.exportData(withSecrets.value);
  if (result.ok) { exported.value = result.value; toasts.ok('Data exported', `${formatBytes(result.value.size)} zip ready to download.`); } else { toasts.error(result.problem); }
}

async function remove(): Promise<void> {
  const k = key.value;
  if (k === undefined) { return; }
  const ok = await store.remove();
  removing.value = false;
  if (!ok) { toasts.error(store.removing.problem.value || `Couldn't remove ${title.value}.`); return; }
  toasts.ok(`Removed ${title.value}`);
  await router.push(links.system(k.system, 'instances'));
}
</script>

<template>
  <AppPage :title="title" :description="view?.description ?? ''" keep-title>
    <template #crumb>
      <RouterLink v-if="key" :to="links.system(key.system, 'instances')" class="crumb" data-testid="back-to-system"><UiIcon name="chevron-left" :size="14" />{{ key.system }}</RouterLink>
    </template>
    <LoadState :loading="store.instances.loading.value" :problem="store.instances.problem.value" :ready="store.instances.value.value !== undefined" :empty="view === undefined" empty-icon="server" empty-title="No such instance" empty-body="It may have been removed." :lines="8" @retry="key && store.open(key)">
      <template v-if="view && key">
        <div class="status-row">
          <StatusBadge :look="SYSTEM_STATUS_LOOK[view.status]" />
          <span class="dim">v{{ view.version }}</span>
        </div>
        <UiTabs v-model="tab" :tabs="tabs" label="Instance" />
        <div v-if="tab === 'overview'" class="overview" data-testid="instance-overview">
          <UiCard title="Details">
            <dl class="facts">
              <div v-for="fact in facts" :key="fact.label"><dt>{{ fact.label }}</dt><dd :title="fact.title">{{ fact.value }}</dd></div>
            </dl>
          </UiCard>
          <UiCard v-if="view.installed" title="Process" :subtitle="`Run by the hub from ${view.installed.dir}`">
            <template #actions><StatusBadge :look="INSTALLED_STATUS_LOOK[view.installed.status]" /></template>
            <dl class="facts">
              <div><dt>Running</dt><dd>{{ view.installed.version }}</dd></div>
              <div v-if="view.installed.pid !== undefined"><dt>Process</dt><dd>{{ view.installed.pid }}</dd></div>
              <div><dt>Starts with hub</dt><dd>{{ view.installed.autoStart ? 'Yes' : 'No' }}</dd></div>
            </dl>
          </UiCard>
          <UiCard title="Remove">
            <div class="row">
              <p class="dim">Its key, config and folders go. The system’s other instances stay.</p>
              <UiButton variant="danger" icon="trash" data-testid="remove-instance" @click="removing = true">Remove</UiButton>
            </div>
          </UiCard>
        </div>
        <SystemConfig
          v-else-if="tab === 'config'" :type="store.configType.value.value" :value="view.config?.value" :version="view.config?.version" :set-at="view.config?.setAt"
          :needs-config="view.config === undefined" :now="now" :busy="store.config.busy.value" :problems="problems" @save="save"
        />
        <div v-else class="overview" data-testid="instance-data">
          <UiCard title="Folders" subtitle="The hub keeps these outside the package, so upgrades and rollbacks keep them.">
            <dl v-if="view.dirs" class="facts">
              <div><dt>Data</dt><dd><code>{{ view.dirs.data }}</code></dd></div>
              <div><dt>State</dt><dd><code>{{ view.dirs.state }}</code></dd></div>
              <div><dt>Cache</dt><dd><code>{{ view.dirs.cache }}</code> <span class="dim">(never exported)</span></dd></div>
            </dl>
            <p v-else class="dim">This instance runs elsewhere, so it keeps its own folders on its machine.</p>
          </UiCard>
          <UiCard title="Export its data" subtitle="A zip of its data folder and config, which harness system install --data restores.">
            <div class="export">
              <UiSwitch v-model="withSecrets" label="Include the config's secrets" description="Anyone with the zip can read them." data-testid="export-secrets" />
              <UiBanner v-if="withSecrets" tone="warn">The zip will hold this instance's secrets in plain text.</UiBanner>
              <div class="row">
                <UiButton icon="download" :loading="store.exporting.busy.value" data-testid="export-data" @click="exportData">Export</UiButton>
                <a v-if="exported" class="download" :href="exported.url" download data-testid="export-download"><UiIcon name="download" :size="14" />Download ({{ formatBytes(exported.size) }})</a>
              </div>
            </div>
          </UiCard>
        </div>
      </template>
    </LoadState>
    <ConfirmDialog v-model:open="removing" :title="`Remove ${title}?`" :busy="store.removing.busy.value" confirm="Remove" body="Its key, config and folders go. It must pair again to come back." @confirm="remove" />
  </AppPage>
</template>

<style scoped>
.status-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
.overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); align-items: start; gap: var(--space-4); }
.facts { display: grid; gap: var(--space-3); margin: 0; }
.facts > div { display: grid; grid-template-columns: minmax(96px, 30%) minmax(0, 1fr); gap: var(--space-3); }
dt { color: var(--text-dim); font-size: var(--text-sm); }
dd { margin: 0; overflow-wrap: anywhere; font-size: var(--text-sm); }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
.export { display: grid; gap: var(--space-3); }
.download { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--text-sm); }
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); }
</style>
