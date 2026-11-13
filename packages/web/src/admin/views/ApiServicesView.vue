<script setup lang="ts">
/**
 * The API services api fns run on (`/admin/api-services`), each an instance of the bundled `api` system: its name,
 * base URL, how it signs in and its instance's status; each opens its page. "Add API service" (`?add=1`) adds one: the
 * hub installs, pairs, configures and starts it. Its fns are made in the chat (`api/make_api`).
 */
import { InstanceName } from '@harness/core';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { useLive } from '../../app/live.ts';
import { links, ROUTES } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import type { PathProblems } from '../../state/problems.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiEmpty } from '../../ui/index.ts';
import AddServiceDialog from '../components/AddServiceDialog.vue';
import ApiServiceForm from '../components/ApiServiceForm.vue';
import LoadState from '../components/LoadState.vue';
import ServiceRows from '../components/ServiceRows.vue';
import type { ServiceRow } from '../logic/service-views.ts';
import { apiServiceConfig, apiServiceDraft, readApiService } from '../logic/api-services.ts';
import { authSummary } from '../logic/remote-config.ts';
import { SYSTEM_STATUS_LOOK } from '../logic/systems.ts';

const { admin, toasts } = useStores();
const fleet = admin.apiServices.fleet;
const router = useRouter();
const query = useRouteQuery(ROUTES.apiServices);
const add = query.text('add', { push: true });
const adding = computed({ get: () => add.value === '1', set: (isOpen) => { add.value = isOpen ? '1' : ''; } });

const draft = ref(apiServiceDraft());
const instance = ref('');
const problems = ref<PathProblems>({});
const nameError = ref('');
watch(adding, (isOpen) => { if (isOpen) { draft.value = apiServiceDraft(); instance.value = ''; problems.value = {}; nameError.value = ''; } });

const rows = computed(() => (fleet.list.value.value ?? []).map((view): ServiceRow => {
  const config = readApiService(view.config?.value);
  return {
    key: view.instance, to: links.apiService(view.instance), label: config?.label ?? view.instance, look: SYSTEM_STATUS_LOOK[view.status],
    where: config?.baseUrl ?? 'Not set up', detail: [view.instance, config === undefined ? '' : authSummary(config.auth)].filter((part) => part !== '').join(' · '),
  };
}));

onMounted(() => { void fleet.load(fleet.list.value.value !== undefined); });
useLive(() => { void fleet.load(true); }, 15_000);

async function save(): Promise<void> {
  const checked = apiServiceConfig(draft.value);
  const name = InstanceName.safeParse(instance.value);
  problems.value = checked.ok ? {} : checked.problems;
  nameError.value = name.success ? '' : 'invalid';
  if (!checked.ok || !name.success) { return; }
  const description = draft.value.description.trim();
  const added = await fleet.add(name.data, checked.config, description === '' ? undefined : description);
  if (!added.ok) { return; }
  toasts.ok(`Added ${draft.value.label.trim()}`, 'Ask in the chat to make fns that call it.');
  await router.replace(links.apiService(added.value.instance));
}
</script>

<template>
  <AppPage title="API services" description="Web APIs that api fns call: each holds its base URL and signs every request, so a fn never sees a credential.">
    <template #actions>
      <UiButton variant="primary" icon="plus" data-testid="add-api-service" @click="adding = true">Add API service</UiButton>
    </template>
    <LoadState :loading="fleet.list.loading.value" :problem="fleet.list.problem.value" :ready="fleet.list.value.value !== undefined" :empty="rows.length === 0" @retry="fleet.load()">
      <template #empty>
        <UiEmpty icon="globe" title="No API services yet" body="Add one by its base URL and sign-in; then ask in the chat for fns that call it.">
          <template #actions><UiButton variant="primary" icon="plus" @click="adding = true">Add API service</UiButton></template>
        </UiEmpty>
      </template>
      <ServiceRows :rows="rows" icon="globe" testid="api-services" />
    </LoadState>
    <AddServiceDialog
      v-model:open="adding" v-model:instance="instance" title="Add API service" description="A web API that api fns call through the hub."
      :label="draft.label" name-hint="Names the service its fns run on; it can't change later." :name-error="nameError"
      :busy="fleet.adding.busy.value" :problem="fleet.adding.problem.value" @save="save"
    >
      <ApiServiceForm v-model="draft" :problems="problems" />
    </AddServiceDialog>
  </AppPage>
</template>
