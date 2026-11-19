<script setup lang="ts">
/**
 * One API service (`/admin/api-services/:service`), a record of the one `api` instance, its tab in the URL: the
 * overview (its base URL, sign-in, OpenAPI document and limits, a link to the API sign-ins page when it signs in, and
 * the api fns sent to it, made in the chat with `api/make_api`) and its settings (saved as the record; its name never
 * changes, and it holds no secret). Removing it removes the record: its fns stop working.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { links } from '../../app/routes.ts';
import { useParamChoice } from '../../app/url.ts';
import { formatBytes } from '../../chat/logic/format.ts';
import type { PathProblems } from '../../state/problems.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiCard, UiIcon, UiTabs, type TabItem } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import FactList from '../components/FactList.vue';
import type { Fact } from '../logic/service-views.ts';
import FnList from '../components/FnList.vue';
import LoadState from '../components/LoadState.vue';
import ApiServiceForm from '../components/ApiServiceForm.vue';
import { API, apiServiceDraft, apiServiceValue, serviceParam } from '../logic/api-services.ts';
import { authSummary } from '../logic/remote-config.ts';
import { ApiServiceTab } from '../sections.ts';

const { admin, toasts } = useStores();
const store = admin.apiServices;
const route = useRoute();
const router = useRouter();
const now = useNow();
const tab = useParamChoice('tab', ApiServiceTab, 'overview');
const name = computed(() => serviceParam(route.params['service']));
const row = computed(() => store.service.value.value);
const service = computed(() => row.value?.service);
const title = computed(() => service.value?.label ?? name.value ?? 'API service');
const fns = computed(() => store.fns.value.value ?? []);

const tabs = computed<readonly TabItem<ApiServiceTab>[]>(() => [{ value: 'overview', label: 'Overview' }, { value: 'settings', label: 'Settings' }]);

const facts = computed<readonly Fact[]>(() => {
  const s = service.value;
  if (s === undefined) { return []; }
  return [
    { label: 'Base URL', value: s.baseUrl, code: true },
    { label: 'Sign-in', value: authSummary(s.auth) },
    ...(s.openapi === undefined ? [] : [{ label: 'OpenAPI', value: s.openapi, code: true }]),
    ...(s.headers === undefined ? [] : [{ label: 'Headers', value: Object.keys(s.headers).join(', ') }]),
    { label: 'Limits', value: `${String(s.timeout / 1000)} s a request, bodies up to ${formatBytes(s.maxBody)}` },
    { label: 'Name', value: s.name, code: true },
  ];
});

const draft = ref(apiServiceDraft());
const problems = ref<PathProblems>({});
const removing = ref(false);
watch(() => row.value?.version, () => { draft.value = apiServiceDraft(service.value); problems.value = {}; }, { immediate: true });
watch(name, (next) => { if (next !== undefined) { void store.show(next); } }, { immediate: true });
onBeforeUnmount(() => { store.close(); });

async function save(): Promise<void> {
  const current = row.value;
  if (current === undefined) { return; }
  // the name is the service's key: fns and connections name it, so it is the one it has
  const checked = apiServiceValue({ ...draft.value, name: current.service.name });
  problems.value = checked.ok ? {} : checked.problems;
  if (!checked.ok) { return; }
  const saved = await store.save(checked.service, current);
  if (saved.ok) {
    const moved = saved.value.service.baseUrl !== current.service.baseUrl && current.service.auth.kind !== 'none';
    toasts.ok('Settings saved', moved ? 'Its base URL changed: its sign-ins are set again on the API sign-ins page.' : undefined);
  }
}

async function remove(): Promise<void> {
  const current = row.value;
  if (current === undefined) { return; }
  const ok = await store.remove(current);
  removing.value = false;
  if (!ok) { toasts.error(store.removing.problem.value || `Couldn't remove ${title.value}.`); return; }
  toasts.ok(`Removed ${title.value}`);
  await router.push(links.apiServices());
}
</script>

<template>
  <AppPage :title="title" :description="service?.description ?? ''" keep-title>
    <template #crumb>
      <RouterLink :to="links.apiServices()" class="crumb" data-testid="back-to-services"><UiIcon name="chevron-left" :size="14" />API services</RouterLink>
    </template>
    <template #actions>
      <UiButton v-if="name" icon="refresh" variant="ghost" :loading="store.service.loading.value" data-testid="service-refresh" @click="store.show(name)">Refresh</UiButton>
      <UiButton v-if="row" icon="trash" variant="ghost" data-testid="service-remove" @click="removing = true">Remove</UiButton>
    </template>
    <LoadState
      :loading="store.service.loading.value" :problem="store.service.problem.value" :ready="store.service.value.value !== undefined || !store.service.loading.value" :empty="service === undefined"
      empty-icon="globe" empty-title="No such API service" empty-body="It may have been removed." :lines="8" @retry="name && store.show(name)"
    >
      <template v-if="service && name">
        <UiTabs v-model="tab" :tabs="tabs" label="API service" />

        <template v-if="tab === 'overview'">
          <UiCard compact>
            <FactList :facts="facts" testid="service-facts" />
          </UiCard>
          <div v-if="service.auth.kind !== 'none'" class="links">
            <RouterLink :to="links.connect(API)" data-testid="service-connections">
              <UiIcon name="key" :size="14" />{{ service.auth.per === 'shared' ? 'Set its shared sign-in' : 'Sign-ins' }}
            </RouterLink>
          </div>
          <LoadState
            :loading="store.fns.loading.value" :problem="store.fns.problem.value" :ready="store.fns.value.value !== undefined" :empty="fns.length === 0"
            empty-icon="fn" empty-title="No fns yet" :empty-body="`Ask in the chat for a fn that calls ${title}; the authoring agent reads its OpenAPI document and tests GETs.`"
            @retry="store.show(name)"
          >
            <FnList :fns="fns" :now="now" :runs-of="links.fnRuns" />
          </LoadState>
        </template>

        <form v-else class="settings" novalidate data-testid="service-settings" @submit.prevent="save">
          <UiCard compact>
            <ApiServiceForm v-model="draft" :problems="problems" />
          </UiCard>
          <div class="save">
            <UiButton variant="ghost" @click="draft = apiServiceDraft(service)">Revert</UiButton>
            <UiButton type="submit" variant="primary" :loading="store.saving.busy.value" data-testid="service-save">Save</UiButton>
          </div>
          <p v-if="store.saving.problem.value !== ''" class="problem" role="alert">{{ store.saving.problem.value }}</p>
        </form>
      </template>
    </LoadState>
    <ConfirmDialog
      v-model:open="removing" :title="`Remove ${title}?`" body="Its fns stop working until a service of the same name is added again. People's sign-ins to it stay until they remove them."
      confirm="Remove" :busy="store.removing.busy.value" @confirm="remove"
    />
  </AppPage>
</template>

<style scoped>
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); }
.links { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); font-size: var(--text-sm); }
.links a { display: inline-flex; align-items: center; gap: var(--space-1); }
.settings { display: grid; gap: var(--space-4); max-width: 48rem; }
.save { display: flex; justify-content: flex-end; gap: var(--space-2); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
</style>
