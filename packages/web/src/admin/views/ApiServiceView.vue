<script setup lang="ts">
/**
 * One API service (`/admin/api-services/:instance`), its tab in the URL: the overview (its instance's status, base URL,
 * sign-in, OpenAPI document and limits, links to its connections page when people sign in to it and to its instance,
 * and the api fns that run on it, made in the chat with `api/make_api`) and its settings (saved as the instance's
 * config; kept secrets stay unless replaced). Removing it removes the instance.
 */
import { InstanceName, connectFlowOf, type QualifiedName } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { links } from '../../app/routes.ts';
import { useParamChoice } from '../../app/url.ts';
import { formatBytes } from '../../chat/logic/format.ts';
import type { PathProblems } from '../../state/problems.ts';
import { useStores } from '../../state/stores.ts';
import { UiBanner, UiButton, UiCard, UiIcon, UiTabs, type TabItem } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import FactList from '../components/FactList.vue';
import type { Fact } from '../logic/service-views.ts';
import FnList from '../components/FnList.vue';
import LoadState from '../components/LoadState.vue';
import ApiServiceForm from '../components/ApiServiceForm.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { API, apiServiceConfig, apiServiceDraft, readApiService } from '../logic/api-services.ts';
import { authSummary } from '../logic/remote-config.ts';
import { SYSTEM_STATUS_LOOK } from '../logic/systems.ts';
import { ApiServiceTab } from '../sections.ts';

const { admin, toasts } = useStores();
const store = admin.apiServices;
const fleet = store.fleet;
const route = useRoute();
const router = useRouter();
const now = useNow();
const tab = useParamChoice('tab', ApiServiceTab, 'overview');
const instance = computed(() => { const read = InstanceName.safeParse(route.params['instance']); return read.success ? read.data : undefined; });
const view = computed(() => (instance.value === undefined ? undefined : fleet.find(instance.value)));
const config = computed(() => readApiService(view.value?.config?.value));
const title = computed(() => config.value?.label ?? instance.value ?? 'API service');
const fns = computed(() => store.fns.value.value ?? []);
const signIn = computed(() => (config.value === undefined ? undefined : connectFlowOf(config.value.auth)));

const tabs = computed<readonly TabItem<ApiServiceTab>[]>(() => [{ value: 'overview', label: 'Overview' }, { value: 'settings', label: 'Settings' }]);

const facts = computed<readonly Fact[]>(() => {
  const c = config.value;
  if (c === undefined) { return []; }
  return [
    { label: 'Base URL', value: c.baseUrl, code: true },
    { label: 'Sign-in', value: authSummary(c.auth) },
    ...(c.openapi === undefined ? [] : [{ label: 'OpenAPI', value: c.openapi, code: true }]),
    ...(c.headers === undefined ? [] : [{ label: 'Headers', value: Object.keys(c.headers).join(', ') }]),
    { label: 'Limits', value: `${c.timeout / 1000} s a request, bodies up to ${formatBytes(c.maxBody)}` },
  ];
});

const draft = ref(apiServiceDraft());
const problems = ref<PathProblems>({});
const hubProblems = ref<readonly string[]>([]);
const removing = ref(false);
watch(() => view.value?.config?.version, () => { draft.value = apiServiceDraft(view.value?.config?.value); problems.value = {}; }, { immediate: true });
watch(instance, (name) => { if (name !== undefined) { void store.show(name); } }, { immediate: true });
onBeforeUnmount(() => { store.close(); });

async function save(): Promise<void> {
  const name = instance.value;
  const checked = apiServiceConfig(draft.value);
  problems.value = checked.ok ? {} : checked.problems;
  if (!checked.ok || name === undefined) { return; }
  const result = await fleet.configure(name, checked.config);
  hubProblems.value = result.ok ? [] : result.problems;
  if (result.ok) { toasts.ok('Settings saved'); }
}

async function remove(): Promise<void> {
  const name = instance.value;
  if (name === undefined) { return; }
  const ok = await fleet.remove(name);
  removing.value = false;
  if (!ok) { toasts.error(fleet.removing.problem.value || `Couldn't remove ${title.value}.`); return; }
  toasts.ok(`Removed ${title.value}`);
  await router.push(links.apiServices());
}

const pageOf = (fn: QualifiedName) => links.fn(fn);
</script>

<template>
  <AppPage :title="title" :description="config?.description ?? ''" keep-title>
    <template #crumb>
      <RouterLink :to="links.apiServices()" class="crumb" data-testid="back-to-services"><UiIcon name="chevron-left" :size="14" />API services</RouterLink>
    </template>
    <template #actions>
      <UiButton icon="trash" variant="ghost" data-testid="service-remove" @click="removing = true">Remove</UiButton>
    </template>
    <LoadState
      :loading="fleet.list.loading.value" :problem="fleet.list.problem.value" :ready="fleet.list.value.value !== undefined" :empty="view === undefined"
      empty-icon="globe" empty-title="No such API service" empty-body="It may have been removed." :lines="8" @retry="instance && store.show(instance)"
    >
      <template v-if="view && instance">
        <div class="status-row">
          <StatusBadge :look="SYSTEM_STATUS_LOOK[view.status]" />
          <code class="dim">{{ instance }}</code>
        </div>
        <UiTabs v-model="tab" :tabs="tabs" label="API service" />

        <template v-if="tab === 'overview'">
          <UiCard compact>
            <FactList :facts="facts" testid="service-facts" />
          </UiCard>
          <div class="links">
            <RouterLink v-if="signIn !== undefined" :to="links.connect(API)" data-testid="service-connections"><UiIcon name="key" :size="14" />Connections</RouterLink>
            <RouterLink :to="links.instance(API, instance)"><UiIcon name="server" :size="14" />Its instance</RouterLink>
          </div>
          <LoadState
            :loading="store.fns.loading.value" :problem="store.fns.problem.value" :ready="store.fns.value.value !== undefined" :empty="fns.length === 0"
            empty-icon="fn" empty-title="No fns yet" :empty-body="`Ask in the chat for a fn that calls ${title}; the authoring agent reads its OpenAPI document and tests GETs.`"
            @retry="store.show(instance)"
          >
            <FnList :fns="fns" :now="now" :runs-of="links.fnRuns" :page-of="pageOf" />
          </LoadState>
        </template>

        <form v-else class="settings" novalidate data-testid="service-settings" @submit.prevent="save">
          <UiCard compact>
            <ApiServiceForm v-model="draft" :problems="problems" />
          </UiCard>
          <UiBanner v-for="problem in hubProblems" :key="problem" tone="danger">{{ problem }}</UiBanner>
          <div class="save">
            <UiButton variant="ghost" @click="draft = apiServiceDraft(view.config?.value)">Revert</UiButton>
            <UiButton type="submit" variant="primary" :loading="fleet.saving.busy.value" data-testid="service-save">Save</UiButton>
          </div>
        </form>
      </template>
    </LoadState>
    <ConfirmDialog
      v-model:open="removing" :title="`Remove ${title}?`" body="Its fns stop working until it is added again, and its settings and connections are deleted."
      confirm="Remove" :busy="fleet.removing.busy.value" @confirm="remove"
    />
  </AppPage>
</template>

<style scoped>
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); }
.status-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.dim { color: var(--text-dim); font-size: var(--text-sm); }
.links { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); font-size: var(--text-sm); }
.links a { display: inline-flex; align-items: center; gap: var(--space-1); }
.settings { display: grid; gap: var(--space-4); max-width: 48rem; }
.save { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
