<script setup lang="ts">
/**
 * Providers and models, the tab in the URL: the configured providers (add or replace one, remove one), every model
 * they offer, the model categories agents choose from, the model roles (which model transcribes, dictates, speaks,
 * describes images, reads text in them and makes decisions; `?role=` opens one), who picks suggestions (no model, a
 * decision model or an LLM; `?decision=1` opens it), the auto mode classifier that checks a chat's calls in auto mode (`?classifier=1` opens it),
 * where the index embeds pictures (off, the text model's space, or a model of their own; `?images=1` opens it) and each model's limits (`?model=` opens one).
 */
import { ModelRole, type AutoClassifier, type ImageEmbedding, type ModelCategory, type SessionId, type SuggestDecision, type ModelLimits, type ProviderInput, type RoleChoice } from '@harness/core';
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import AppPage from '../../app/AppPage.vue';
import { useParamChoice, useRouteQuery } from '../../app/url.ts';
import { ROUTES } from '../../app/routes.ts';
import { useStores } from '../../state/stores.ts';
import { UiBadge, UiButton, UiEmpty, UiTabs, type TabItem } from '../../ui/index.ts';
import CategoryDialog from '../components/CategoryDialog.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import ClassifierDialog from '../components/ClassifierDialog.vue';
import ImageEmbeddingDialog from '../components/ImageEmbeddingDialog.vue';
import { IMAGE_USE_WORDS, imageSettingText, spaceText } from '../logic/images.ts';
import { classifierText } from '../logic/classifier.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import LoadState from '../components/LoadState.vue';
import ModelLimitsDialog from '../components/ModelLimitsDialog.vue';
import ModelRoleDialog from '../components/ModelRoleDialog.vue';
import ModelTable from '../components/ModelTable.vue';
import ProviderDialog from '../components/ProviderDialog.vue';
import RuleList from '../components/RuleList.vue';
import RuleRow from '../components/RuleRow.vue';
import type { ModelInfo } from '@harness/core';
import { modelProviderName, PROVIDER_NAME, type CategoryBody } from '../logic/forms.ts';
import { CHOOSER_WORDS, decisionModelText } from '../logic/suggestions.ts';
import { LIMIT_FIELDS, LIMIT_SOURCE_WORDS, LIMIT_WORDS, resolvedText, ROLE_FROM_WORDS, ROLE_WORDS, roleLanguage, roleWorks, rolesByModel } from '../logic/roles.ts';
import type { IconName } from '../../ui/index.ts';
import { ModelsTab } from '../sections.ts';
import type { ProviderRow } from '../state/models.ts';

const { admin, toasts, chat } = useStores();
const suggestions = admin.suggestions;
const classifier = admin.classifier;
const images = admin.images;
const models = admin.models;
const tab = useParamChoice('tab', ModelsTab, 'providers');
/** The models search, kept in the URL (`?q=`) once typing pauses. */
const query = useRouteQuery(ROUTES.models);
const { draft: modelQuery } = query.draft('q');
const roles = admin.roles;
/** The role whose editor is open (`?role=`), and the model whose limits are (`?model=`). */
const roleParam = query.text('role', { push: true });
const openRole = computed(() => { const parsed = ModelRole.safeParse(roleParam.value); return parsed.success ? parsed.data : undefined; });
const openModel = query.text('model', { push: true });
const roleOpen = computed({ get: () => openRole.value !== undefined, set: (isOpen) => { if (!isOpen) { roleParam.value = ''; } } });
const decisionParam = query.text('decision', { push: true });
const decisionOpen = computed({ get: () => decisionParam.value === '1', set: (isOpen) => { decisionParam.value = isOpen ? '1' : ''; } });
const classifierParam = query.text('classifier', { push: true });
const classifierOpen = computed({ get: () => classifierParam.value === '1', set: (isOpen) => { classifierParam.value = isOpen ? '1' : ''; } });
const imagesParam = query.text('images', { push: true });
const imagesOpen = computed({ get: () => imagesParam.value === '1', set: (isOpen) => { imagesParam.value = isOpen ? '1' : ''; } });
/** The pictures setting's choice, and whether a space is in use now. */
const imageUse = computed(() => images.setting.value.value?.value.use ?? 'text');
const imageWorks = computed(() => spaceText(images.setting.value.value?.state).works);
const limitsOpen = computed({ get: () => openModel.value !== '', set: (isOpen) => { if (!isOpen) { openModel.value = ''; } } });
const editingRole = computed(() => (openRole.value === undefined ? undefined : roles.role(openRole.value)));
const editingLimits = computed(() => roles.limits.value.value?.find((l) => l.model === openModel.value));
const ROLE_ICON = { chat: 'chat', transcribe: 'file', dictate: 'mic', speak: 'music', describe: 'image', ocr: 'eye', decide: 'sparkles' } as const satisfies Record<ModelRole, IconName>;
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
  { value: 'roles', label: 'Roles' },
  { value: 'limits', label: 'Model limits', count: roles.limits.value.value?.length ?? 0 },
]);
const ready = computed(() => models.providers.value.value !== undefined);
const providerName = (model: ModelInfo): string => modelProviderName(model.provider);
/** The roles each model fills, shown beside it: systems' `ctx.ai()` sees the same list with the same roles. */
const modelRoles = computed(() => rolesByModel(roles.roles.value.value ?? []));
/** Who picks suggestions now (no model until the setting is loaded or set). */
const chooser = computed(() => suggestions.decision.value.value?.value.by ?? 'none');

onMounted(() => { void models.load(ready.value); });
watch(tab, (current) => {
  if (current === 'roles') { void roles.loadRoles(roles.roles.value.value !== undefined); void suggestions.load(suggestions.decision.value.value !== undefined); void classifier.load(classifier.setting.value.value !== undefined); void images.load(images.setting.value.value !== undefined); }
  if (current === 'models') { void roles.loadRoles(roles.roles.value.value !== undefined); }
  if (current === 'limits') { void roles.loadLimits(roles.limits.value.value !== undefined); }
}, { immediate: true });

async function saveRole(choice: RoleChoice): Promise<void> {
  const result = await roles.setRole(choice);
  if (!result.ok) { return; }
  roleOpen.value = false;
  toasts.ok(`${ROLE_WORDS[choice.role].label} saved`, resolvedText(result.value));
}

async function resetRole(): Promise<void> {
  const role = editingRole.value;
  if (role === undefined) { return; }
  const result = await roles.clearRole(role.role);
  if (!result.ok) { return; }
  roleOpen.value = false;
  toasts.ok(`${ROLE_WORDS[role.role].label} back to the hub default`, resolvedText(result.value));
}

watch(decisionOpen, (isOpen) => { if (isOpen && chat.sessions.items.value.length === 0) { void chat.sessions.load(); } }, { immediate: true });

async function saveDecision(value: SuggestDecision): Promise<void> {
  const result = await suggestions.save(value);
  if (!result.ok) { return; }
  decisionOpen.value = false;
  toasts.ok('Suggestions saved', decisionModelText(result.value));
}

async function saveClassifier(value: AutoClassifier): Promise<void> {
  const result = await classifier.save(value);
  if (!result.ok) { return; }
  classifierOpen.value = false;
  toasts.ok('Auto mode classifier saved', classifierText(result.value));
}

// opened from a link on another tab, the setting is loaded too
watch(imagesOpen, (isOpen) => { if (isOpen) { void images.load(images.setting.value.value !== undefined); } }, { immediate: true });

async function saveImages(value: ImageEmbedding): Promise<void> {
  const result = await images.save(value);
  if (!result.ok) { return; }
  imagesOpen.value = false;
  toasts.ok('Pictures saved', imageSettingText(result.value));
}

function tryDecision(session: SessionId, text: string): void {
  void suggestions.try(session, text);
}

async function saveLimits(limits: ModelLimits): Promise<void> {
  const model = openModel.value;
  const result = await roles.setLimits(model, limits);
  if (!result.ok) { return; }
  limitsOpen.value = false;
  toasts.ok(`Limits of ${model} saved`);
}

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

      <ModelTable v-if="tab === 'models'" v-model:query="modelQuery" :models="models.models.value.value ?? []" :provider-name="providerName" :roles="modelRoles" />

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

      <LoadState
        v-if="tab === 'roles'" :loading="roles.roles.loading.value" :problem="roles.roles.problem.value" :ready="roles.roles.value.value !== undefined" :empty="false"
        @retry="roles.loadRoles()"
      >
        <RuleList title="Roles" description="The model the hub uses for each of its own jobs. Agents choose their own." testid="roles">
          <RuleRow
            v-for="row in roles.roles.value.value ?? []" :key="row.role" :icon="ROLE_ICON[row.role]" :title="ROLE_WORDS[row.role].label" :detail="resolvedText(row)"
            :label="ROLE_WORDS[row.role].label" :removable="false" :data-role="row.role" @edit="roleParam = row.role"
          >
            <template #badges>
              <UiBadge :tone="row.from === 'setting' ? 'accent' : 'neutral'">{{ ROLE_FROM_WORDS[row.from] }}</UiBadge>
              <UiBadge v-if="row.from !== 'none'" :tone="roleWorks(row) ? 'ok' : 'warn'">{{ roleWorks(row) ? 'Works' : 'Needs attention' }}</UiBadge>
              <UiBadge v-if="row.choice?.role === 'dictate'">{{ row.choice.engine.engine === 'browser' ? 'In the browser' : 'By a model' }}</UiBadge>
              <UiBadge v-if="roleLanguage(row)">{{ roleLanguage(row) }}</UiBadge>
            </template>
          </RuleRow>
        </RuleList>
        <RuleList title="Suggestions" description="How the fns and context offered with a message are chosen." testid="suggestions">
          <RuleRow
            :icon="CHOOSER_WORDS[chooser].icon" title="Who picks" :detail="decisionModelText(suggestions.decision.value.value)" label="Who picks suggestions" :removable="false"
            data-testid="decision-row" :data-by="chooser" @edit="decisionOpen = true"
          >
            <template #badges><UiBadge :tone="chooser === 'none' ? 'neutral' : 'accent'">{{ CHOOSER_WORDS[chooser].label }}</UiBadge></template>
          </RuleRow>
        </RuleList>
        <RuleList title="Search" description="What the index embeds, so search finds it by meaning." testid="search-settings">
          <RuleRow
            :icon="IMAGE_USE_WORDS[imageUse].icon" title="Pictures" :detail="imageSettingText(images.setting.value.value)" label="Where pictures are embedded" :removable="false"
            data-testid="images-row" :data-use="imageUse" @edit="imagesOpen = true"
          >
            <template #badges>
              <UiBadge :tone="imageUse === 'off' ? 'neutral' : 'accent'">{{ IMAGE_USE_WORDS[imageUse].label }}</UiBadge>
              <UiBadge v-if="imageUse !== 'off' && images.setting.value.value" :tone="imageWorks ? 'ok' : 'warn'">{{ imageWorks ? 'In use' : 'Not in use' }}</UiBadge>
            </template>
          </RuleRow>
        </RuleList>
        <RuleList title="Chat modes" description="How a chat set to Auto decides whether a call that writes or deletes goes ahead." testid="chat-modes">
          <RuleRow
            icon="shield" title="Auto mode classifier" :detail="classifierText(classifier.setting.value.value)" label="Auto mode classifier" :removable="false" data-testid="classifier-row"
            @edit="classifierOpen = true"
          >
            <template #badges><UiBadge :tone="classifier.setting.value.value?.value.model ? 'accent' : 'neutral'">{{ classifier.setting.value.value?.value.model ? 'On' : 'Off' }}</UiBadge></template>
          </RuleRow>
        </RuleList>
      </LoadState>

      <LoadState
        v-if="tab === 'limits'" :loading="roles.limits.loading.value" :problem="roles.limits.problem.value" :ready="roles.limits.value.value !== undefined"
        :empty="(roles.limits.value.value?.length ?? 0) === 0" empty-icon="cpu" empty-title="No chat models yet" empty-body="Add a provider; its chat models show here." @retry="roles.loadLimits()"
      >
        <RuleList title="Limits" description="What prompts are budgeted against, so a small model is never sent more than it takes." testid="model-limits">
          <RuleRow
            v-for="row in roles.limits.value.value ?? []" :key="row.model" icon="cpu" :title="row.model" :removable="false" :label="`limits of ${row.model}`" :data-model="row.model"
            :detail="`${row.limits.contextWindow.toLocaleString()} window · ${row.limits.maxOutputTokens.toLocaleString()} reply${row.limits.reasoningTokens > 0 ? ` · ${row.limits.reasoningTokens.toLocaleString()} reasoning` : ''} · ×${row.ratio.toFixed(2)} calibration`"
            @edit="openModel = row.model"
          >
            <template #badges>
              <UiBadge v-for="field in LIMIT_FIELDS" :key="field" :tone="row.sources[field] === 'admin' ? 'accent' : 'neutral'" :title="LIMIT_WORDS[field].about">
                {{ LIMIT_WORDS[field].label }}: {{ LIMIT_SOURCE_WORDS[row.sources[field]] }}
              </UiBadge>
            </template>
          </RuleRow>
        </RuleList>
      </LoadState>
    </LoadState>

    <ModelRoleDialog
      v-model:open="roleOpen" :role="editingRole" :models="models.models.value.value ?? []" :providers="providers" :busy="roles.save.busy.value" :problem="roles.save.problem.value"
      @save="saveRole" @reset="resetRole"
    />
    <DecisionDialog
      v-model:open="decisionOpen" :view="suggestions.decision.value.value" :models="models.models.value.value ?? []" :sessions="chat.sessions.items.value"
      :busy="suggestions.saving.busy.value" :problem="suggestions.saving.problem.value" :preview="suggestions.preview.value.value" :previewing="suggestions.preview.loading.value"
      :preview-problem="suggestions.preview.problem.value" @save="saveDecision" @try="tryDecision"
    />
    <ClassifierDialog
      v-model:open="classifierOpen" :view="classifier.setting.value.value" :models="models.models.value.value ?? []" :busy="classifier.saving.busy.value"
      :problem="classifier.saving.problem.value" @save="saveClassifier"
    />
    <ImageEmbeddingDialog
      v-model:open="imagesOpen" :view="images.setting.value.value" :busy="images.saving.busy.value" :problem="images.saving.problem.value" @save="saveImages"
    />
    <ModelLimitsDialog v-model:open="limitsOpen" :view="editingLimits" :busy="roles.save.busy.value" :problem="roles.save.problem.value" @save="saveLimits" />
    <ProviderDialog v-model:open="providerOpen" :busy="models.save.busy.value" :problem="models.save.problem.value" @save="saveProvider" />
    <CategoryDialog v-model:open="categoryOpen" :category="editing" :models="models.modelIds.value" :busy="models.save.busy.value" :problem="models.save.problem.value" @save="saveCategory" />
    <ConfirmDialog
      v-model:open="removeOpen" :title="removing?.kind === 'provider' ? 'Remove this provider?' : `Remove ${removing?.kind === 'category' ? removing.row.name : ''}?`"
      :body="removing?.kind === 'provider' ? 'Its models stop being available and its key is deleted.' : 'Agents using it fall back to the default.'"
      confirm="Remove" :busy="models.remove.busy.value" @confirm="confirmRemove"
    />
  </AppPage>
</template>
