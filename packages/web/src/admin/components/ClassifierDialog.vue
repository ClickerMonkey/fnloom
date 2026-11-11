<script setup lang="ts">
/**
 * The auto mode classifier, for the whole hub: the model a chat in auto mode asks whether a call that writes or
 * deletes may go ahead, and how many of the chat's last messages it reads with the call. With no model, every such
 * call waits for the person.
 */
import type { AutoClassifier, AutoClassifierView, ModelInfo } from '@harness/core';
import { computed, ref, watch } from 'vue';
import ModelPicker from '../../chat/components/ModelPicker.vue';
import type { ModelPick } from '../../chat/logic/session.ts';
import { UiBanner, UiButton, UiDialog, UiField, UiInput } from '../../ui/index.ts';
import { classifierDraft, classifierOf, type ClassifierDraft } from '../logic/classifier.ts';

const props = withDefaults(defineProps<{ view: AutoClassifierView | undefined; models: readonly ModelInfo[]; busy?: boolean; problem?: string }>(), { busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [value: AutoClassifier] }>();

const draft = ref<ClassifierDraft>(classifierDraft(undefined));
const tried = ref(false);
watch(open, (isOpen) => { if (isOpen) { draft.value = classifierDraft(props.view); tried.value = false; } }, { immediate: true });

const checked = computed(() => classifierOf(draft.value));
const numbersError = computed(() => (tried.value && !checked.value.ok ? checked.value.problem : ''));
const picked = computed<ModelPick>(() => (draft.value.model === '' ? 'default' : `model:${draft.value.model}`));
function pick(choice: ModelPick): void {
  if (choice !== 'default') { draft.value = { ...draft.value, model: choice.slice('model:'.length) }; }
}
function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', checked.value.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" title="Auto mode classifier" description="In a chat set to Auto, this model checks each call that writes or deletes before it runs." width="560px">
    <form class="form" novalidate data-testid="classifier-form" @submit.prevent="save">
      <UiField label="Model">
        <div class="model" data-testid="classifier-model">
          <div class="chosen-row">
            <p class="chosen"><span class="dim">Chosen:</span> {{ draft.model || 'None: such calls wait for the person' }}</p>
            <UiButton v-if="draft.model !== ''" size="sm" variant="ghost" data-testid="classifier-clear" @click="draft = { ...draft, model: '' }">Clear</UiButton>
          </div>
          <ModelPicker :models="models" :current="picked" :own-choice="false" :limit="100" list-height="min(240px, 32vh)" @pick="pick" />
        </div>
      </UiField>
      <UiInput
        :model-value="draft.messages" type="number" label="Recent messages" hint="How many of the chat’s last messages it reads with the call, 0 to 20."
        :error="numbersError" data-testid="classifier-messages" @update:model-value="draft = { ...draft, messages: $event }"
      />
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="classifier-save" @click="save">Save</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-3); }
.model { display: grid; gap: var(--space-2); min-width: 0; }
.chosen-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.chosen { margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
.dim { color: var(--text-dim); }
</style>
