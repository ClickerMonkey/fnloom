<script setup lang="ts">
/**
 * A labelled form field: the label, the control (the slot), a hint and an error. It makes the ids that tie them
 * together and hands them to the control, so every input is labelled and its hint and error are read with it.
 */
import { computed, useId } from 'vue';

const props = withDefaults(defineProps<{
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Keep the label for screen readers only. */
  hideLabel?: boolean;
}>(), { label: '', hint: '', error: '', required: false, hideLabel: false });

const id = useId();
const hintId = `${id}-hint`;
const errorId = `${id}-error`;
const describedBy = computed(() => [props.error === '' ? '' : errorId, props.hint === '' ? '' : hintId].filter((s) => s !== '').join(' ') || undefined);

defineSlots<{ default: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => unknown }>();
</script>

<template>
  <div class="ui-field" :class="{ invalid: error !== '' }">
    <label v-if="label !== ''" :for="id" class="label" :class="{ 'sr-only': hideLabel }">
      {{ label }}<span v-if="required" class="required" aria-hidden="true">*</span>
    </label>
    <slot :id="id" :described-by="describedBy" :invalid="error !== ''" />
    <p v-if="error !== ''" :id="errorId" class="error" role="alert">{{ error }}</p>
    <p v-else-if="hint !== ''" :id="hintId" class="hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.ui-field { display: grid; gap: 6px; min-width: 0; }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text); }
.required { color: var(--danger); margin-left: 2px; }
.hint, .error { margin: 0; font-size: var(--text-sm); line-height: var(--leading-tight); }
.hint { color: var(--text-faint); }
.error { color: var(--danger); animation: ui-rise-in var(--medium) var(--ease); }
</style>
