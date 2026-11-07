<script setup lang="ts">
/**
 * A whole form for a gin type: its inputs, a problem line for the value as a whole, and Submit (with Cancel when
 * offered). Submit is enabled once the value checks out; problems show under each field as the person types.
 */
import type { Json } from '@harness/core';
import { computed, inject, shallowRef, watch } from 'vue';
import { UiButton } from '../../ui/index.ts';
import GinInput from './GinInput.vue';
import { problemAt } from './model.ts';
import { FormState } from './state.ts';
import { FORM_TYPES, LOCAL_TYPES } from './types.ts';

const props = withDefaults(defineProps<{
  /** The gin type definition. */
  type: unknown;
  initial?: Json | undefined;
  submitLabel?: string;
  busy?: boolean;
  cancellable?: boolean;
  /** The label of the value when it isn't an object. */
  label?: string;
}>(), { initial: undefined, submitLabel: 'Submit', busy: false, cancellable: true, label: 'Value' });

const emit = defineEmits<{ submit: [value: Json]; cancel: [] }>();
const types = inject(FORM_TYPES, LOCAL_TYPES);
const form = shallowRef(new FormState(props.type, props.initial, types));
/** Load the named types the type refers to; once they arrive, the form knows their shapes and gin can check them. */
async function load(type: unknown): Promise<void> {
  if (await types.need([type]) && form.value.def === type && !form.value.tried.value) { form.value = new FormState(type, props.initial, types); }
}
void load(props.type);
watch(() => props.type, (type) => { form.value = new FormState(type, props.initial, types); void load(type); });
const whole = computed(() => problemAt(form.value.problems.value, ''));

function submit(): void {
  const checked = form.value.check();
  if (checked.ok) { emit('submit', checked.value); }
}
</script>

<template>
  <form class="gin-form" novalidate data-testid="gin-form" @submit.prevent="submit">
    <GinInput
      :node="form.node" :draft="form.draft.value" path="" :problems="form.problems.value" :label="label"
      :required="form.node.kind !== 'obj'" @update="form.update($event)"
    />
    <p v-if="whole !== '' && form.node.kind === 'obj'" class="whole" role="alert">{{ whole }}</p>
    <div class="actions">
      <UiButton v-if="cancellable" variant="ghost" @click="emit('cancel')">Cancel</UiButton>
      <UiButton type="submit" variant="primary" :loading="busy" :disabled="!form.valid.value" data-testid="gin-submit">{{ submitLabel }}</UiButton>
    </div>
  </form>
</template>

<style scoped>
.gin-form { display: grid; gap: var(--space-4); min-width: 0; }
.whole { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--space-2); }
</style>
