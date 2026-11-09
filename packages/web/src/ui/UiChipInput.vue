<script setup lang="ts" generic="T extends string">
/**
 * A short list of names typed into one box: each name shows as a removable chip, Enter or a comma adds what is typed
 * (when `read` accepts it; otherwise its problem shows), Backspace in an empty box removes the last. Free text (tags);
 * names of things on the hub use a picker (`HubPicker`).
 */
import { ref, useId, watch } from 'vue';
import UiIcon from './UiIcon.vue';

const props = withDefaults(defineProps<{
  modelValue: readonly T[];
  label: string;
  placeholder?: string;
  hint?: string;
  /** The name as typed read into a name, or undefined when it isn't one. */
  read: (text: string) => T | undefined;
  /** What a refused name is told. */
  refusal?: string;
  testid?: string;
}>(), { placeholder: '', hint: '', refusal: 'That isn’t a name.', testid: '' });

const emit = defineEmits<{ 'update:modelValue': [names: T[]] }>();
const id = useId();
const typed = ref('');
const problem = ref('');

watch(typed, () => { problem.value = ''; });

function add(): void {
  const text = typed.value.trim().replace(/,$/, '');
  if (text === '') { return; }
  const name = props.read(text);
  if (name === undefined) { problem.value = props.refusal; return; }
  if (!props.modelValue.includes(name)) { emit('update:modelValue', [...props.modelValue, name]); }
  typed.value = '';
}
function remove(index: number): void {
  emit('update:modelValue', props.modelValue.filter((_, i) => i !== index));
}
function key(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); return; }
  if (event.key === 'Backspace' && typed.value === '' && props.modelValue.length > 0) { remove(props.modelValue.length - 1); }
}
</script>

<template>
  <div class="ui-chip-input" :data-testid="testid || undefined">
    <label class="label" :for="id">{{ label }}</label>
    <div class="box" :class="{ bad: problem !== '' }">
      <span v-for="(name, i) in modelValue" :key="name" class="chip">
        <code>{{ name }}</code>
        <button type="button" class="drop" :aria-label="`Remove ${name}`" @click="remove(i)"><UiIcon name="x" :size="12" /></button>
      </span>
      <input
        :id="id" v-model="typed" class="type" :placeholder="modelValue.length === 0 ? placeholder : ''" autocomplete="off"
        :aria-invalid="problem !== '' ? 'true' : undefined" :aria-describedby="`${id}-note`" @keydown="key" @blur="add"
      >
    </div>
    <p v-if="problem !== '' || hint !== ''" :id="`${id}-note`" class="note" :class="{ bad: problem !== '' }">{{ problem || hint }}</p>
  </div>
</template>

<style scoped>
/* sized like UiPicker (and every UiField), so the two sit level in a form grid */
.ui-chip-input { display: grid; align-content: start; gap: 6px; min-width: 0; }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.box {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: var(--control); padding: 3px var(--space-2);
  border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface);
}
.box:focus-within { border-color: var(--accent); box-shadow: var(--ring); }
.box.bad { border-color: var(--danger); }
.chip { display: inline-flex; align-items: center; gap: 2px; height: 24px; padding: 0 2px 0 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); font-size: var(--text-xs); }
.drop { display: inline-grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: var(--radius-sm); background: none; color: var(--text-dim); cursor: pointer; }
.drop:hover { color: var(--danger); }
.type { flex: 1 1 6rem; min-width: 4rem; height: 26px; padding: 0; border: 0; outline: none; background: transparent; color: var(--text); font: inherit; font-size: var(--text-sm); }
.type::placeholder { color: var(--text-faint); }
.note { margin: 0; color: var(--text-faint); font-size: var(--text-sm); line-height: var(--leading-tight); }
.note.bad { color: var(--danger); }
</style>
