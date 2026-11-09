<script setup lang="ts">
/**
 * The picker for every input that names things: the values picked show as chips in the box (their readable labels,
 * fetched once; a value that no longer resolves shows struck through), and typing searches the source as you type
 * (once typing pauses). Arrows move through the list, Enter picks, Backspace in an empty box removes the last chip,
 * Esc closes the list. `max` 1 makes a single picker (a pick replaces the value). `custom` takes the words as typed
 * as a value too (a pattern like `fs/*`), offered after the options. Rules in `picker.ts`.
 */
import type { PickOption } from '@harness/core';
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import UiField from './UiField.vue';
import UiIcon from './UiIcon.vue';
import UiPopover from './UiPopover.vue';
import { pickChoices, stepActive, withoutPicked, withPicked, type PickChoice, type PickerSource } from './picker.ts';

const props = withDefaults(defineProps<{
  source: PickerSource;
  label: string;
  hideLabel?: boolean;
  placeholder?: string;
  hint?: string;
  error?: string;
  /** At most this many values; 1 is a single picker. */
  max?: number | undefined;
  /** Read the words as typed as a value when no option fits, or undefined when they aren't one. */
  custom?: ((text: string) => string | undefined) | undefined;
  /** Show values in monospace (names, ids, addresses). */
  code?: boolean;
  /** How long typing pauses before the source is asked (ms). */
  delay?: number;
  disabled?: boolean;
  testid?: string;
}>(), { hideLabel: false, placeholder: 'Search', hint: '', error: '', max: undefined, custom: undefined, code: true, delay: 200, disabled: false, testid: '' });

const model = defineModel<readonly string[]>({ required: true });

const id = useId();
const listId = `${id}-list`;
const box = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const typed = ref('');
const options = shallowRef<readonly PickOption[]>([]);
const known = shallowRef<ReadonlyMap<string, PickOption>>(new Map());
const open = ref(false);
const active = ref(0);
const searching = ref(false);

const choices = computed<PickChoice[]>(() => pickChoices(options.value, model.value, typed.value, props.custom));
const listOpen = computed({ get: () => open.value && (choices.value.length > 0 || searching.value), set: (next: boolean) => { open.value = next; } });
const full = computed(() => props.max !== undefined && props.max !== 1 && model.value.length >= props.max);
const chips = computed(() => model.value.map((value) => known.value.get(value) ?? { value, label: value }));

let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
async function search(text: string): Promise<void> {
  const mine = ++generation;
  searching.value = true;
  try {
    const found = await props.source.search(text.trim());
    if (mine === generation) { options.value = found; active.value = 0; }
  } catch {
    if (mine === generation) { options.value = []; }
  } finally {
    if (mine === generation) { searching.value = false; }
  }
}
watch(typed, (text) => {
  if (text !== '') { open.value = true; }
  clearTimeout(timer);
  timer = setTimeout(() => { void search(text); }, props.delay);
});
onBeforeUnmount(() => { clearTimeout(timer); });

/** Label the chips whose options aren't known yet. */
watch(model, async (values) => {
  const unknown = values.filter((value) => !known.value.has(value));
  if (unknown.length === 0) { return; }
  try {
    const labelled = await props.source.label(unknown);
    const next = new Map(known.value);
    for (const option of labelled) { next.set(option.value, option); }
    known.value = next;
  } catch {
    // chips keep their raw values
  }
}, { immediate: true });

function focusIn(): void {
  open.value = true;
  if (options.value.length === 0 && !searching.value) { void search(typed.value); }
}
function pick(choice: PickChoice): void {
  known.value = new Map(known.value).set(choice.option.value, choice.option);
  model.value = withPicked(model.value, choice.option.value, props.max);
  typed.value = '';
  active.value = 0;
  if (props.max === 1) { open.value = false; }
  input.value?.focus();
}
function remove(index: number): void {
  model.value = withoutPicked(model.value, index);
  input.value?.focus();
}
function onKey(event: KeyboardEvent): void {
  const rows = choices.value;
  switch (event.key) {
    case 'ArrowDown': case 'ArrowUp':
      event.preventDefault();
      if (!open.value) { focusIn(); return; }
      active.value = stepActive(active.value, rows.length, event.key === 'ArrowDown' ? 1 : -1);
      return;
    case 'Enter': {
      const row = listOpen.value ? rows[active.value] : undefined;
      if (row !== undefined || typed.value !== '') { event.preventDefault(); }
      if (row !== undefined && !full.value) { pick(row); }
      return;
    }
    case 'Escape':
      if (listOpen.value) { event.preventDefault(); event.stopPropagation(); open.value = false; }
      return;
    case 'Backspace':
      if (typed.value === '' && model.value.length > 0) { remove(model.value.length - 1); }
      return;
    case 'Tab':
      open.value = false;
      return;
  }
}
defineExpose({ focus: () => { input.value?.focus(); } });
</script>

<template>
  <div class="picker-root">
    <UiField v-slot="field" :label="label" :hint="hint" :error="error" :hide-label="hideLabel">
      <div ref="box" class="ui-picker" :class="{ invalid: field.invalid, disabled }" :data-testid="testid || undefined" @click.self="input?.focus()">
        <span v-for="(chip, i) in chips" :key="chip.value" class="chip" :class="{ missing: chip.missing === true, code }" :title="chip.hint ?? chip.value" data-testid="picker-chip">
          <UiIcon v-if="chip.missing === true" name="warning" :size="12" class="warn" />
          <span class="chip-text">{{ chip.label }}</span>
          <button v-if="!disabled" type="button" class="chip-x" :aria-label="`Remove ${chip.label}`" tabindex="-1" @click="remove(i)"><UiIcon name="x" :size="12" /></button>
        </span>
        <input
          :id="field.id" ref="input" v-model="typed" class="text" type="text" autocomplete="off" :disabled="disabled || full"
          :placeholder="model.length === 0 ? placeholder : ''" role="combobox" aria-autocomplete="list" :aria-expanded="listOpen ? 'true' : 'false'" :aria-controls="listId"
          :aria-activedescendant="listOpen && choices.length > 0 ? `${listId}-${active}` : undefined" :aria-describedby="field.describedBy" :aria-invalid="field.invalid ? 'true' : undefined"
          data-testid="picker-input" @focus="focusIn" @blur="open = false" @keydown="onKey"
        />
      </div>
    </UiField>
    <UiPopover v-model:open="listOpen" :anchor="box" role="listbox" :label="`${label} options`" match-width :take-focus="false">
      <ul :id="listId" class="options" data-testid="picker-options">
        <li
          v-for="(row, i) in choices" :id="`${listId}-${i}`" :key="`${row.custom ? '+' : ''}${row.option.value}`" role="option" class="option" :class="{ active: i === active }"
          :aria-selected="i === active ? 'true' : 'false'" data-testid="picker-option" @mousedown.prevent="pick(row)" @mouseenter="active = i"
        >
          <UiIcon v-if="row.custom" name="plus" :size="14" class="mark" />
          <span class="o-label" :class="{ code }">{{ row.option.label }}</span>
          <span v-if="row.option.hint" class="o-hint">{{ row.option.hint }}</span>
        </li>
        <li v-if="choices.length === 0 && searching" class="option dim" aria-disabled="true">Searching…</li>
      </ul>
    </UiPopover>
  </div>
</template>

<style scoped>
.picker-root { min-width: 0; }
.ui-picker {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; min-height: var(--control);
  padding: 3px var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); cursor: text;
  transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.ui-picker:hover { border-color: var(--text-faint); }
.ui-picker:focus-within { border-color: var(--accent); box-shadow: var(--ring); }
.ui-picker.invalid { border-color: var(--danger); }
.ui-picker.disabled { opacity: 0.6; cursor: default; }
.chip {
  display: inline-flex; align-items: center; gap: 2px; min-width: 0; max-width: 100%; height: 24px; padding: 0 2px 0 8px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); font-size: var(--text-xs);
}
.chip.code .chip-text { font-family: var(--mono); }
.chip.missing { border-style: dashed; color: var(--text-faint); }
.chip.missing .chip-text { text-decoration: line-through; }
.chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warn { color: var(--warn); }
.chip-x { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: var(--radius-sm); background: none; color: var(--text-dim); cursor: pointer; }
.chip-x:hover { background: var(--surface-3); color: var(--danger); }
.text { flex: 1 1 6rem; min-width: 4rem; height: 26px; padding: 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: var(--text-sm); outline: none; }
.text::placeholder { color: var(--text-faint); }
.options { display: grid; margin: 0; padding: var(--space-1); list-style: none; max-height: min(320px, 50vh); overflow-y: auto; }
.option { display: flex; align-items: center; gap: var(--space-2); min-height: 32px; padding: 0 var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-sm); cursor: pointer; }
.option.active { background: var(--surface-2); }
.option.dim { color: var(--text-faint); cursor: default; }
.mark { flex: none; color: var(--text-faint); }
.o-label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.o-label.code { font-family: var(--mono); font-size: var(--text-xs); }
.o-hint { flex: 1 1 auto; min-width: 0; margin-left: auto; overflow: hidden; color: var(--text-faint); font-size: var(--text-xs); text-align: right; text-overflow: ellipsis; white-space: nowrap; }
</style>
