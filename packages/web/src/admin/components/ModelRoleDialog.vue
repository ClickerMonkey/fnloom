<script setup lang="ts">
/**
 * Setting one model role: for dictation, the engine (the browser's speech recognition, or a model); otherwise, and for
 * a model engine, the model from the chat's searchable model picker over the models able to do the job (every model
 * on request, for one aeye doesn't label), optionally pinned to one configured provider, and a language hint; for the
 * decide role, the threshold a yes/no answer must reach instead. Reset goes back to the hub's default.
 */
import type { ModelInfo, ModelRoleView, ProviderId, RoleChoice } from '@harness/core';
import { computed, ref, watch } from 'vue';
import ModelPicker from '../../chat/components/ModelPicker.vue';
import type { ModelPick } from '../../chat/logic/session.ts';
import { UiBanner, UiButton, UiDialog, UiField, UiInput, UiSegmented, UiSelect, UiSwitch, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import { PROVIDER_NAME } from '../logic/forms.ts';
import { hasLanguage, modelsFor, resolvedText, ROLE_WORDS, roleChoiceOf, roleDraft, type RoleDraft } from '../logic/roles.ts';
import type { ProviderRow } from '../state/models.ts';

const props = withDefaults(defineProps<{
  role: ModelRoleView | undefined;
  models: readonly ModelInfo[];
  providers: readonly ProviderRow[];
  busy?: boolean;
  problem?: string;
}>(), { busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [choice: RoleChoice]; reset: [] }>();

const draft = ref<RoleDraft>({ engine: 'model', model: '', provider: '', language: '', threshold: '' });
const tried = ref(false);
watch([open, () => props.role], ([isOpen, role]) => { if (isOpen && role !== undefined) { draft.value = roleDraft(role); tried.value = false; } }, { immediate: true });

const words = computed(() => (props.role === undefined ? undefined : ROLE_WORDS[props.role.role]));
const ENGINES: readonly SegmentOption<RoleDraft['engine']>[] = [{ value: 'browser', label: 'In the browser', icon: 'globe' }, { value: 'model', label: 'A model', icon: 'cpu' }];
const usesModel = computed(() => props.role?.role !== 'dictate' || draft.value.engine === 'model');

/** Whether the picker also lists the models not labelled as able to do the job. */
const everyModel = ref(false);
watch(open, (isOpen) => { if (isOpen) { everyModel.value = false; } });
const sorted = computed(() => (props.role === undefined ? { able: [], other: [] } : modelsFor(props.role.role, props.models)));
/** The models offered: those able to do the job, or every model when asked (or when none is labelled able). */
const pickable = computed(() => (everyModel.value || sorted.value.able.length === 0 ? [...sorted.value.able, ...sorted.value.other] : sorted.value.able));
const picked = computed<ModelPick>(() => (draft.value.model === '' ? 'default' : `model:${draft.value.model}`));
function pick(choice: ModelPick): void {
  if (choice === 'default') { return; }
  draft.value = { ...draft.value, model: choice.slice('model:'.length) };
}
const chosen = computed(() => props.models.find((m) => m.id === draft.value.model));
/** The chosen model in words; a model set before that no provider lists any more is still shown, so it isn't lost. */
const chosenText = computed(() => {
  if (draft.value.model === '') { return 'None yet'; }
  if (chosen.value === undefined) { return `${draft.value.model} (not offered now)`; }
  const able = sorted.value.able.includes(chosen.value);
  return `${chosen.value.name} · ${chosen.value.provider}${able ? '' : ` (not listed as able to ${words.value?.can ?? 'do this'})`}`;
});
const providerOptions = computed<SelectOption<ProviderId>[]>(() => [
  { value: '', label: 'Any provider that offers it' },
  ...props.providers.filter((p) => chosen.value === undefined || p.provider === chosen.value.provider).map((p) => ({ value: p.id, label: PROVIDER_NAME[p.provider] })),
]);
const checked = computed(() => (props.role === undefined ? undefined : roleChoiceOf(props.role.role, draft.value)));
const error = computed(() => (tried.value && checked.value !== undefined && !checked.value.ok ? checked.value.problem : ''));

function save(): void {
  tried.value = true;
  if (checked.value?.ok === true) { emit('save', checked.value.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" :title="words ? `${words.label} model` : 'Model role'" :description="words?.about ?? ''" width="520px">
    <form v-if="role" class="form" novalidate data-testid="role-form" :data-role="role.role" @submit.prevent="save">
      <p class="now" data-testid="role-now"><span class="dim">Now:</span> {{ resolvedText(role) }}</p>
      <UiSegmented v-if="role.role === 'dictate'" v-model="draft.engine" :options="ENGINES" label="Dictation engine" data-testid="role-engine" />
      <p v-if="role.role === 'dictate' && draft.engine === 'browser'" class="dim">The browser’s own speech recognition: no recording is uploaded and no model is called. Not every browser has one.</p>
      <template v-if="usesModel">
        <UiField label="Model" :error="error" required>
          <div class="model" data-testid="role-model">
            <p class="chosen" data-testid="role-chosen"><span class="dim">Chosen:</span> {{ chosenText }}</p>
            <ModelPicker :models="pickable" :current="picked" :own-choice="false" :limit="100" list-height="min(300px, 40vh)" @pick="pick" />
            <UiSwitch
              v-if="sorted.other.length > 0 && sorted.able.length > 0" v-model="everyModel" label="Show every model"
              :description="`Also list models not labelled as able to ${words?.can ?? 'do this'}.`" data-testid="role-every-model"
            />
          </div>
        </UiField>
        <UiSelect v-model="draft.provider" :options="providerOptions" label="Provider" hint="Pin one when several providers serve the same model." data-testid="role-provider" />
      </template>
      <UiInput v-if="hasLanguage(role.role)" v-model="draft.language" label="Language" placeholder="en-US" hint="A BCP 47 tag; empty lets the model tell." data-testid="role-language" />
      <UiInput
        v-else v-model="draft.threshold" type="number" label="Threshold" placeholder="0.5" data-testid="role-threshold"
        hint="How likely a yes/no answer must be to count as yes, 0 to 1. Context crawls, systems’ reuse questions and suggestions by a decision model use it."
      />
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton v-if="role?.from === 'setting'" variant="ghost" icon="undo" :disabled="busy" data-testid="role-reset" @click="emit('reset')">Use the hub default</UiButton>
      <span class="grow" />
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="role-save" @click="save">Save</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.now { margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
.model { display: grid; gap: var(--space-3); min-width: 0; }
.chosen { margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.grow { flex: 1; }
</style>
