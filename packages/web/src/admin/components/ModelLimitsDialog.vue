<script setup lang="ts">
/**
 * Setting one model's limits: each field the admin's own value, or blank to let the next source fill it (the provider's
 * probe, aeye's model info, the hub's default), each showing what it resolves to now and from where.
 */
import type { ModelLimits, ModelLimitsView } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiInput } from '../../ui/index.ts';
import { LIMIT_FIELDS, LIMIT_SOURCE_WORDS, LIMIT_WORDS, limitsDraft, limitsOf } from '../logic/roles.ts';

const props = withDefaults(defineProps<{ view: ModelLimitsView | undefined; busy?: boolean; problem?: string }>(), { busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [limits: ModelLimits] }>();

const draft = ref<Record<keyof ModelLimits, string>>({ contextWindow: '', maxOutputTokens: '', reasoningTokens: '', charsPerToken: '' });
const tried = ref(false);
watch([open, () => props.view], ([isOpen, view]) => { if (isOpen && view !== undefined) { draft.value = limitsDraft(view); tried.value = false; } }, { immediate: true });
const checked = computed(() => limitsOf(draft.value));
const error = computed(() => (tried.value && !checked.value.ok ? checked.value.problem : ''));

const hint = (field: keyof ModelLimits): string => {
  if (props.view === undefined) { return LIMIT_WORDS[field].about; }
  return `Now ${props.view.limits[field].toLocaleString()} ${LIMIT_WORDS[field].unit} (${LIMIT_SOURCE_WORDS[props.view.sources[field]]}). ${LIMIT_WORDS[field].about}`;
};

function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', checked.value.limits); }
}
</script>

<template>
  <UiDialog v-model:open="open" :title="view ? `Limits of ${view.model}` : 'Model limits'" description="What the hub budgets this model's prompts against. Leave a field empty to use the next source." width="520px">
    <form class="form" novalidate data-testid="limits-form" @submit.prevent="save">
      <UiInput
        v-for="field in LIMIT_FIELDS" :key="field" v-model="draft[field]" type="number" :label="LIMIT_WORDS[field].label" :hint="hint(field)"
        :placeholder="view ? String(view.limits[field]) : ''" :data-testid="`limit-${field}`"
      />
      <p v-if="view" class="dim">Estimates are multiplied by {{ view.ratio.toFixed(2) }}, the measured ratio of real to estimated input for this model.</p>
      <UiBanner v-if="error !== '' || problem !== ''" tone="danger">{{ error || problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="limits-save" @click="save">Save limits</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
