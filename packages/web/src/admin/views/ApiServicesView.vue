<script setup lang="ts">
/**
 * The web API services api fns are sent to (`/admin/api-services`): records of the one `api` instance, searched by
 * words in the hub's database (`?q=`), each row its label, base URL, name and sign-in, opening its page. "Add API
 * service" (`?add=1`) adds one as a record; the authoring agent adds them too, from the chat (`api/make_api`). A service
 * holds no secret: a shared token is set on the API sign-ins page.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { useLive } from '../../app/live.ts';
import { links, ROUTES } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import type { PathProblems } from '../../state/problems.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiEmpty, UiInput } from '../../ui/index.ts';
import AddServiceDialog from '../components/AddServiceDialog.vue';
import ApiServiceForm from '../components/ApiServiceForm.vue';
import LoadState from '../components/LoadState.vue';
import ServiceRows from '../components/ServiceRows.vue';
import type { ServiceRow } from '../logic/service-views.ts';
import { API, apiServiceDraft, apiServiceValue } from '../logic/api-services.ts';
import { authSummary } from '../logic/remote-config.ts';

const { admin, toasts } = useStores();
const store = admin.apiServices;
const router = useRouter();
const query = useRouteQuery(ROUTES.apiServices);
const words = query.draft('q');
const add = query.text('add', { push: true });
const adding = computed({ get: () => add.value === '1', set: (isOpen) => { add.value = isOpen ? '1' : ''; } });

const draft = ref(apiServiceDraft());
const name = ref('');
const problems = ref<PathProblems>({});
watch(adding, (isOpen) => { if (isOpen) { draft.value = apiServiceDraft(); name.value = ''; problems.value = {}; } });

/** Services have no state of their own: a row says how people sign in. */
const LOOK = { none: { tone: 'ok', word: 'Open', live: false }, shared: { tone: 'accent', word: 'Shared sign-in', live: false }, person: { tone: 'neutral', word: 'Each person signs in', live: false } } as const;

const rows = computed(() => (store.list.value.value ?? []).map(({ service }): ServiceRow => ({
  key: service.name, to: links.apiService(service.name), label: service.label, where: service.baseUrl,
  look: LOOK[service.auth.kind === 'none' ? 'none' : service.auth.per],
  detail: [service.name, authSummary(service.auth), service.openapi === undefined ? '' : 'OpenAPI'].filter((part) => part !== '').join(' · '),
})));
const searching = computed(() => words.value.value.trim() !== '');

watch(() => words.value.value, (text) => { void store.load(text, store.list.value.value !== undefined); });
onMounted(() => { void store.load(words.value.value, store.list.value.value !== undefined); });
useLive(() => { void store.load(words.value.value, true); }, 30_000);

async function save(): Promise<void> {
  const checked = apiServiceValue({ ...draft.value, name: name.value });
  problems.value = checked.ok ? {} : checked.problems;
  if (!checked.ok) { return; }
  const added = await store.save(checked.service);
  if (!added.ok) { return; }
  const signIn = checked.service.auth.kind === 'none' ? 'Ask in the chat for fns that call it.' : 'Its sign-in is set on the API sign-ins page; then ask in the chat for fns that call it.';
  toasts.ok(`Added ${checked.service.label}`, signIn);
  await router.replace(links.apiService(added.value.service.name));
}
</script>

<template>
  <AppPage title="API services" description="The web APIs api fns call: each a base URL and how it signs in. Fns never see a credential; people's tokens are their connections.">
    <template #actions>
      <UiButton variant="ghost" icon="key" data-testid="api-sign-ins" @click="router.push(links.connect(API))">Sign-ins</UiButton>
      <UiButton variant="primary" icon="plus" data-testid="add-api-service" @click="adding = true">Add API service</UiButton>
    </template>
    <div class="page">
      <UiInput v-model="words.draft.value" type="search" icon="search" label="Search API services" hide-label placeholder="Search names, base URLs and descriptions" clearable data-testid="api-services-search" />
      <LoadState :loading="store.list.loading.value" :problem="store.list.problem.value" :ready="store.list.value.value !== undefined" :empty="rows.length === 0" @retry="store.load()">
        <template #empty>
          <UiEmpty v-if="searching" icon="search" title="No API services match" body="Try other words." />
          <UiEmpty v-else icon="globe" title="No API services yet" body="Add one by its base URL and sign-in, or ask in the chat for a fn that calls a web API: the authoring agent adds its service.">
            <template #actions><UiButton variant="primary" icon="plus" @click="adding = true">Add API service</UiButton></template>
          </UiEmpty>
        </template>
        <ServiceRows :rows="rows" icon="globe" testid="api-services" />
      </LoadState>
    </div>
    <AddServiceDialog
      v-model:open="adding" v-model:instance="name" title="Add API service" description="A web API that api fns call through the hub."
      :label="draft.label" name-hint="Its fns and sign-ins name it; it can't change later." :name-error="problems['name'] ?? ''"
      :busy="store.saving.busy.value" :problem="store.saving.problem.value" @save="save"
    >
      <ApiServiceForm v-model="draft" :problems="problems" />
    </AddServiceDialog>
  </AppPage>
</template>

<style scoped>
.page { display: grid; gap: var(--space-4); min-width: 0; }
</style>
