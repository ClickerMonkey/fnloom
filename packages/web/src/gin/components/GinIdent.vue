<script setup lang="ts">
/**
 * A name or a line of text typed in place in code: monospace, as wide as what it holds, with no box until it is
 * hovered or focused, so the code around it reads as code. Its label is for screen readers only; position says what
 * it is.
 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  modelValue: string;
  label: string;
  placeholder?: string;
  /** How it is coloured: a name, a string or a number. */
  tone?: 'name' | 'string' | 'number';
}>(), { placeholder: '', tone: 'name' });

const emit = defineEmits<{ 'update:modelValue': [text: string] }>();
// as wide as its text, plus its padding, so it sits in the code like the text it holds
const width = computed(() => `calc(${Math.max(1, (props.modelValue === '' ? props.placeholder : props.modelValue).length)}ch + 2px)`);

function onInput(event: Event): void {
  if (event.target instanceof HTMLInputElement) { emit('update:modelValue', event.target.value); }
}
</script>

<template>
  <input
    class="gin-ident" :class="tone" type="text" :value="modelValue" :placeholder="placeholder" :aria-label="label" :style="{ width }" spellcheck="false" autocomplete="off"
    @input="onInput"
  />
</template>

<style scoped>
.gin-ident {
  min-width: 1ch; max-width: 100%; height: 1.6em; margin: 0; padding: 0 1px; border: 0; border-radius: var(--radius-sm); background: transparent;
  color: var(--text); font: inherit; line-height: inherit;
}
.gin-ident.number { color: light-dark(oklch(0.55 0.15 50), oklch(0.8 0.12 60)); }
.gin-ident.string { color: light-dark(oklch(0.5 0.13 150), oklch(0.78 0.12 150)); }
.gin-ident:hover { background: var(--surface-2); box-shadow: inset 0 -1px 0 var(--border-strong); }
.gin-ident:focus { outline: none; background: var(--surface); box-shadow: var(--ring); }
.gin-ident::placeholder { color: var(--text-faint); }
</style>
