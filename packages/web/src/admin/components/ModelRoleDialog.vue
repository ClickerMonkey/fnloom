<script setup lang="ts">
/**
 * Setting one model role: for dictation, the engine (the browser's speech recognition, or a model); otherwise, and for
 * a model engine, the model (those that can do the job first), optionally pinned to one configured provider, and a
 * language hint. Reset goes back to the hub's default.
 */
import type { ModelInfo, ModelRoleView, ProviderId, RoleChoice } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiInput, UiSegmented, UiSelect, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import { PROVIDER_NAME } from '../logic/forms.ts';
import { modelsFor, resolvedText, ROLE_WORDS, roleChoiceOf, roleDraft, type RoleDraft } from '../logic/roles.ts';
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

const draft = ref<RoleDraft>({ engine: 'model', model: '', provider: '', language: '' });
const tried = ref(false);
watch([open, () => props.role], ([isOpen, role]) => { if (isOpen && role !== undefined) { draft.value = roleDraft(role); tried.value = false; } }, { immediate: true });

const words = computed(() => (props.role === undefined ? undefined : ROLE_WORDS[props.role.role]));
const ENGINES: readonly SegmentOption<RoleDraft['engine']>[] = [{ value: 'browser', label: 'In the browser', icon: 'globe' }, { value: 'model', label: 'A model', icon: 'cpu' }];
const usesModel = computed(() => props.role?.role !== 'dictate' || draft.value.engine === 'model');

const modelOptions = computed<SelectOption<string>[]>(() => {
  if (props.role === undefined) { return []; }
  const { able, other } = modelsFor(props.role.role, props.models);
  const known = [...able, ...other].some((m) => m.id === draft.value.model);
  return [
    { value: '', label: 'Choose a model' },
    // a model set before that no provider lists any more stays choosable, so opening the dialog never loses it
    ...(known || draft.value.model === '' ? [] : [{ value: draft.value.model, label: `${draft.value.model} (not offered now)` }]),
    ...able.map((m) => ({ value: m.id, label: m.name })),
    ...other.map((m) => ({ value: m.id, label: `${m.name} (not listed as able to ${words.value?.can ?? 'do this'})` })),
  ];
});
const chosen = computed(() => props.models.find((m) => m.id === draft.value.model));
const providerOptions = computed<SelectOption<ProviderId>[]>(() => [
  { value: '', label: 'Any provider that offers it' },
  ...props.providers.filter((p) => chosen.value === undefined || p.provider === chosen.value.provider).map((p) => ({ value: p.id, label: PROVIDER_NAME[p.provider] })),
]);
const checked = computed(() => (props.role === undefined ? undefined : roleChoiceOf(props.role.role, draft.value)));
const error = computed(() => (tried.value && checked.value !== undefined && !checked.value.ok ? checked.value.problem : ''));

function save(): void {
  tried.value = true;
  if (checked.value?.ok === true) { emit('save', checked.value.choice); }
}
</script>

<template>
  <UiDialog v-model:open="open" :title="words ? `${words.label} model` : 'Model role'" :description="words?.about ?? ''" width="520px">
    <form v-if="role" class="form" novalidate data-testid="role-form" :data-role="role.role" @submit.prevent="save">
      <p class="now" data-testid="role-now"><span class="dim">Now:</span> {{ resolvedText(role) }}</p>
      <UiSegmented v-if="role.role === 'dictate'" v-model="draft.engine" :options="ENGINES" label="Dictation engine" data-testid="role-engine" />
      <p v-if="role.role === 'dictate' && draft.engine === 'browser'" class="dim">The browser’s own speech recognition: no recording is uploaded and no model is called. Not every browser has one.</p>
      <template v-if="usesModel">
        <UiSelect v-model="draft.model" :options="modelOptions" label="Model" :error="error" required data-testid="role-model" />
        <UiSelect v-model="draft.provider" :options="providerOptions" label="Provider" hint="Pin one when several providers serve the same model." data-testid="role-provider" />
      </template>
      <UiInput v-model="draft.language" label="Language" placeholder="en-US" hint="A BCP 47 tag; empty lets the model tell." data-testid="role-language" />
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
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.grow { flex: 1; }
</style>
