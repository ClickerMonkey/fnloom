<script setup lang="ts">
/**
 * One field of a form, drawn by the form itself when the chat gives no value editor: a line or a box of text, a
 * number, yes or no, a choice (chips, one or several), a date, a date and time, lines of text, or JSON for anything else.
 */
import { Json } from '@harness/core';
import { computed, ref } from 'vue';
import { controlOf, type FormField } from './form.ts';

const props = defineProps<{ field: FormField; id: string; disabled: boolean }>();
const model = defineModel<Json | undefined>();

const control = computed(() => controlOf(props.field.type));
const jsonText = ref(model.value === undefined ? '' : JSON.stringify(model.value));
const jsonProblem = ref(false);

const text = computed({
  get: () => (typeof model.value === 'string' ? model.value : ''),
  set: (value: string) => { model.value = value; },
});
const lines = computed({
  get: () => (Array.isArray(model.value) ? model.value.filter((line) => typeof line === 'string').join('\n') : ''),
  set: (value: string) => { model.value = value.split('\n').map((line) => line.trim()).filter((line) => line !== ''); },
});

function setNumber(event: Event): void {
  const raw = event.target instanceof HTMLInputElement ? event.target.value : '';
  model.value = raw === '' ? undefined : Number(raw);
}

function picked(option: string): boolean {
  return Array.isArray(model.value) ? model.value.includes(option) : model.value === option;
}

function pick(option: string, multiple: boolean): void {
  if (!multiple) { model.value = option; return; }
  const current = Array.isArray(model.value) ? model.value.filter((item) => typeof item === 'string') : [];
  model.value = current.includes(option) ? current.filter((item) => item !== option) : [...current, option];
}

function setJson(event: Event): void {
  const value = event.target instanceof HTMLTextAreaElement ? event.target.value : '';
  jsonText.value = value;
  if (value.trim() === '') { model.value = undefined; jsonProblem.value = false; return; }
  try {
    model.value = Json.parse(JSON.parse(value));
    jsonProblem.value = false;
  } catch {
    jsonProblem.value = true;
  }
}
</script>

<template>
  <template v-if="control.control === 'text'">
    <textarea v-if="control.long" :id="id" v-model="text" class="box" rows="3" :disabled="disabled" :required="field.required" />
    <input v-else :id="id" v-model="text" class="box" type="text" :disabled="disabled" :required="field.required">
  </template>
  <input
    v-else-if="control.control === 'number'" :id="id" class="box number" type="number" inputmode="decimal"
    :min="control.min" :max="control.max" :step="control.step" :value="typeof model === 'number' ? model : ''" :disabled="disabled" @input="setNumber"
  >
  <div v-else-if="control.control === 'yes-no'" :id="id" class="chips" role="radiogroup">
    <button
      v-for="choice in [true, false]" :key="String(choice)" type="button" role="radio" class="chip" :aria-checked="model === choice"
      :disabled="disabled" @click="model = choice"
    >
      {{ choice ? 'Yes' : 'No' }}
    </button>
  </div>
  <div v-else-if="control.control === 'choice'" :id="id" class="chips" :role="control.multiple ? 'group' : 'radiogroup'">
    <button
      v-for="option in control.options" :key="option" type="button" class="chip" :role="control.multiple ? 'checkbox' : 'radio'"
      :aria-checked="picked(option)" :disabled="disabled" @click="pick(option, control.multiple)"
    >
      {{ option }}
    </button>
  </div>
  <input v-else-if="control.control === 'date'" :id="id" v-model="text" class="box" type="date" :disabled="disabled">
  <input v-else-if="control.control === 'datetime'" :id="id" v-model="text" class="box" type="datetime-local" :disabled="disabled">
  <textarea v-else-if="control.control === 'lines'" :id="id" v-model="lines" class="box" rows="3" placeholder="One per line" :disabled="disabled" />
  <textarea
    v-else :id="id" class="box mono" rows="3" :value="jsonText" :aria-invalid="jsonProblem" placeholder="JSON" :disabled="disabled"
    @input="setJson"
  />
</template>

<style scoped>
.box {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--text);
  font: inherit;
}
.box:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.box[aria-invalid='true'] { border-color: var(--danger); }
.number { max-width: 12rem; }
.mono { font-family: var(--font-mono); font-size: var(--text-sm); }
textarea.box { resize: vertical; }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.chip {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.chip[aria-checked='true'] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.chip:disabled { cursor: default; opacity: 0.7; }
.chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
