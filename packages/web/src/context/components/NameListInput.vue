<script setup lang="ts" generic="T extends string">
/**
 * A short list of names typed into one box: each name shows as a removable chip, Enter or a comma adds what is typed
 * (when `read` accepts it; otherwise its problem shows), Backspace in an empty box removes the last. While typing,
 * `suggest` (when given) offers matching names to pick from.
 */
import { ref, useId, watch } from 'vue';
import { UiIcon } from '../../ui/index.ts';

const props = withDefaults(defineProps<{
  modelValue: readonly T[];
  label: string;
  placeholder?: string;
  hint?: string;
  /** The name as typed read into a name, or undefined when it isn't one. */
  read: (text: string) => T | undefined;
  /** What a refused name is told. */
  refusal?: string;
  /** Names matching what is typed. */
  suggest?: ((prefix: string) => Promise<readonly string[]>) | undefined;
  testid?: string;
}>(), { placeholder: '', hint: '', refusal: 'That isn’t a name.', suggest: undefined, testid: '' });

const emit = defineEmits<{ 'update:modelValue': [names: T[]] }>();
const id = useId();
const typed = ref('');
const problem = ref('');
const offered = ref<readonly string[]>([]);

watch(typed, async (text) => {
  problem.value = '';
  offered.value = props.suggest === undefined || text.trim() === '' ? [] : await props.suggest(text.trim());
});

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
  <div class="name-list" :data-testid="testid || undefined">
    <label class="label" :for="id">{{ label }}</label>
    <div class="box" :class="{ bad: problem !== '' }">
      <span v-for="(name, i) in modelValue" :key="name" class="chip">
        <code>{{ name }}</code>
        <button type="button" class="drop" :aria-label="`Remove ${name}`" @click="remove(i)"><UiIcon name="x" :size="12" /></button>
      </span>
      <input
        :id="id" v-model="typed" class="type" :list="`${id}-names`" :placeholder="modelValue.length === 0 ? placeholder : ''" autocomplete="off"
        :aria-invalid="problem !== '' ? 'true' : undefined" :aria-describedby="`${id}-note`" @keydown="key" @blur="add"
      >
      <datalist :id="`${id}-names`"><option v-for="name in offered" :key="name" :value="name" /></datalist>
    </div>
    <p v-if="problem !== '' || hint !== ''" :id="`${id}-note`" class="note" :class="{ bad: problem !== '' }">{{ problem || hint }}</p>
  </div>
</template>

<style scoped>
.name-list { display: grid; gap: var(--space-1); min-width: 0; }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.box {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); min-height: 36px; padding: 3px var(--space-2);
  border: 1px solid var(--border-strong, var(--border)); border-radius: var(--radius); background: var(--surface);
}
.box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.box.bad { border-color: var(--danger); }
.chip { display: inline-flex; align-items: center; gap: 2px; padding: 1px 2px 1px 6px; border-radius: 5px; background: var(--surface-2); font-size: var(--text-xs); }
.drop { display: inline-grid; place-items: center; padding: 2px; border: 0; border-radius: 4px; background: none; color: var(--text-faint); cursor: pointer; }
.drop:hover { color: var(--danger); }
.type { flex: 1 1 8rem; min-width: 6rem; border: 0; outline: none; background: transparent; color: var(--text); font: inherit; font-size: var(--text-sm); }
.note { margin: 0; color: var(--text-faint); font-size: var(--text-xs); }
.note.bad { color: var(--danger); }
</style>
