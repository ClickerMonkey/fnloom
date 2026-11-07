<script setup lang="ts">
/**
 * Providers and models, the tab in the URL: the configured providers (add or replace one, remove one), every model
 * they offer, and the model categories agents choose from.
 */
import type { ModelCategory, ProviderInput } from '@harness/core';
import { computed, onMounted, ref, shallowRef } from 'vue';
import AppPage from '../../app/AppPage.vue';
import { useParamChoice } from '../../app/url.ts';
import { useStores } from '../../state/stores.ts';
import { UiBadge, UiButton, UiEmpty, UiTabs, type TabItem } from '../../ui/index.ts';
import CategoryDialog from '../components/CategoryDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import LoadState from '../components/LoadState.vue';
import ModelTable from '../components/ModelTable.vue';
import ProviderDialog from '../components/ProviderDialog.vue';
import RuleList from '../components/RuleList.vue';
import RuleRow from '../components/RuleRow.vue';
import type { ModelInfo } from '@harness/core';
import { PROVIDER_NAME, type CategoryBody } from '../logic/forms.ts';
import { ModelsTab } from '../sections.ts';
import type { ProviderRow } from '../state/models.ts';

const { admin, toasts } = useStores();
const models = admin.models;
const tab = useParamChoice('tab', ModelsTab, 'providers');
const providerOpen = ref(false);
const categoryOpen = ref(false);
const editing = shallowRef<ModelCategory | undefined>(undefined);
const removing = shallowRef<{ kind: 'provider'; row: ProviderRow } | { kind: 'category'; row: ModelCategory } | undefined>(undefined);
const removeOpen = computed({ get: () => removing.value !== undefined, set: (open) => { if (!open) { removing.value = undefined; } } });

const providers = computed(() => models.providers.value.value ?? []);
const categories = computed(() => models.categories.value.value ?? []);
const tabs = computed<readonly TabItem<ModelsTab>[]>(() => [
  { value: 'providers', label: 'Providers', count: providers.value.length },
  { value: 'models', label: 'Models', count: models.models.value.value?.length ?? 0 },
  { value: 'categories', label: 'Categories', count: categories.value.length },
]);
const ready = computed(() => models.providers.value.value !== undefined);
const providerName = (model: ModelInfo): string => {
  const row = providers.value.find((p) => p.id === model.provider);
  return row === undefined ? model.provider : PROVIDER_NAME[row.provider];
};

onMounted(() => { void models.load(ready.value); });

async function saveProvider(input: ProviderInput): Promise<void> {
  const result = await models.saveProvider(input);
  if (!result.ok) { return; }
  providerOpen.value = false;
  toasts.ok(`${PROVIDER_NAME[input.provider]} saved`, `${result.value.models} models available.`);
}

function editCategory(category?: ModelCategory): void {
  editing.value = category;
  categoryOpen.value = true;
}

async function saveCategory(body: CategoryBody): Promise<void> {
  const result = await models.saveCategory(body);
  if (!result.ok) { return; }
  categoryOpen.value = false;
  toasts.ok(`Saved ${body.name}`);
}

async function confirmRemove(): Promise<void> {
  const target = removing.value;
  if (target === undefined) { return; }
  const ok = target.kind === 'provider' ? await models.removeProvider(target.row.id) : await models.removeCategory(target.row.id);
  removing.value = undefined;
  if (ok) { toasts.ok('Removed'); } else { toasts.error(models.remove.problem.value); }
}
</script>

<template>
  <AppPage title="Models" description="Where the hub's LLM calls go, and the categories agents choose from.">
    <UiTabs v-model="tab" :tabs="tabs" label="Models" />
    <LoadState
      :loading="models.providers.loading.value" :problem="models.providers.problem.value || models.models.problem.value || models.categories.problem.value"
      :ready="ready" :empty="false" @retry="models.load()"
    >
      <RuleList v-if="tab === 'providers'" title="Providers" description="Keys are stored encrypted and never shown again." add="Add provider" testid="providers" @add="providerOpen = true">
        <RuleRow
          v-for="row in providers" :key="row.id" icon="key" :title="PROVIDER_NAME[row.provider]" :detail="`${row.models} models`" :editable="false"
          @remove="removing = { kind: 'provider', row }"
        />
      </RuleList>
      <UiEmpty v-if="tab === 'providers' && providers.length === 0" icon="key" title="No providers yet" body="Add one so agents can call models.">
        <template #actions><UiButton variant="primary" icon="plus" @click="providerOpen = true">Add provider</UiButton></template>
      </UiEmpty>

      <ModelTable v-if="tab === 'models'" :models="models.models.value.value ?? []" :provider-name="providerName" />

      <template v-if="tab === 'categories'">
        <RuleList title="Categories" description="An ordered list of models: the first is tried first." add="New category" testid="categories" @add="editCategory()">
          <RuleRow
            v-for="category in categories" :key="category.id" icon="sparkles" :title="category.name" :detail="category.description"
            @edit="editCategory(category)" @remove="removing = { kind: 'category', row: category }"
          >
            <template #badges><UiBadge v-for="(model, i) in category.models" :key="model" :tone="i === 0 ? 'accent' : 'neutral'">{{ model }}</UiBadge></template>
          </RuleRow>
        </RuleList>
        <UiEmpty v-if="categories.length === 0" icon="sparkles" title="No categories yet" body="Agents pick a category such as fast or careful, not a model." />
      </template>
    </LoadState>

    <ProviderDialog v-model:open="providerOpen" :busy="models.save.busy.value" :problem="models.save.problem.value" @save="saveProvider" />
    <CategoryDialog v-model:open="categoryOpen" :category="editing" :models="models.modelIds.value" :busy="models.save.busy.value" :problem="models.save.problem.value" @save="saveCategory" />
    <ConfirmDialog
      v-model:open="removeOpen" :title="removing?.kind === 'provider' ? 'Remove this provider?' : `Remove ${removing?.kind === 'category' ? removing.row.name : ''}?`"
      :body="removing?.kind === 'provider' ? 'Its models stop being available and its key is deleted.' : 'Agents using it fall back to the default.'"
      confirm="Remove" :busy="models.remove.busy.value" @confirm="confirmRemove"
    />
  </AppPage>
</template>
