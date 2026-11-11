<script setup lang="ts">
/**
 * The search box every list uses: its filters as pills inside the box (`Status: Running`, `Cost > $0.01`), then the
 * words being typed. Typing suggests values that match (pills to add), fields, and the words as a plain search; a
 * filter typed out whole (`cost>0.01`, `status:running`) becomes a pill at a space or Enter. The filter icon in the box
 * opens the menu of every field, its operators and its value; a pill opens the same menu to change it. Backspace in an
 * empty box takes the last pill off. The words reach the model once typing pauses. The pills and the words wrap inside
 * the box; the clear and filter icons stay at the end of its first line. See `search.ts` for the rules.
 */
import type { Filter } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import UiFilterMenu from './UiFilterMenu.vue';
import UiIcon from './UiIcon.vue';
import UiPopover from './UiPopover.vue';
import {
  pillText, readFilter, type ValueNamer, suggest, typing, withFilter, withoutFilter, withText, type NumberFormat, type SearchFields, type SearchQuery, type Suggestion, type ValueOption,
} from './search.ts';

const props = withDefaults(defineProps<{
  fields: SearchFields;
  /** What is searched, for the box's accessible name ("Search runs"). */
  label: string;
  placeholder?: string;
  format?: NumberFormat;
  /** A field's values from the data, for fields whose values aren't fixed (`dynamic`). */
  values?: ((field: string, prefix: string) => Promise<readonly ValueOption[]>) | undefined;
  /** How long typing pauses before the words reach the model (ms). */
  delay?: number;
  /** A data value's readable name in its pill (a session id's chat title). */
  name?: ValueNamer | undefined;
}>(), { placeholder: 'Search or filter', format: (value: number) => String(value), values: undefined, delay: 300, name: undefined });

const model = defineModel<SearchQuery>({ required: true });

const box = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const draft = ref(model.value.text ?? '');
const fetched = ref<Readonly<Record<string, readonly ValueOption[]>>>({});
const suggesting = ref(false);
const active = ref(0);
const menuOpen = ref(false);
/** The pill being changed in the menu (its place), or undefined for a new filter. */
const editingAt = ref<number | undefined>(undefined);
const editing = computed(() => (editingAt.value === undefined ? undefined : model.value.filters?.[editingAt.value]));

const filters = computed(() => model.value.filters ?? []);
const pills = computed(() => filters.value.map((filter) => pillText(props.fields, filter, props.format, props.name)));
const suggestions = computed<Suggestion[]>(() => (draft.value.trim() === '' ? [] : suggest(props.fields, draft.value, fetched.value, props.format)));
const listOpen = computed({ get: () => suggesting.value && suggestions.value.length > 0 && !menuOpen.value, set: (open: boolean) => { suggesting.value = open; } });

/** The words typed, unless they are the start of a filter (`status:`), which only a pill finishes. */
function wordsOf(text: string): string {
  return typing(props.fields, text).field === undefined && readFilter(props.fields, text.trim()) === undefined ? text : model.value.text ?? '';
}

let textTimer: ReturnType<typeof setTimeout> | undefined;
let valuesTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
watch(draft, (text) => {
  active.value = 0;
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    const next = wordsOf(text);
    if (next.trim() !== (model.value.text ?? '')) { model.value = withText(model.value, next); }
  }, props.delay);
  clearTimeout(valuesTimer);
  const values = props.values;
  if (values === undefined) { return; }
  valuesTimer = setTimeout(() => { void fetchValues(values, text); }, 200);
});
watch(() => model.value.text, (text) => { if ((text ?? '') !== draft.value.trim() && !suggesting.value) { draft.value = text ?? ''; } });
onBeforeUnmount(() => { clearTimeout(textTimer); clearTimeout(valuesTimer); });
defineExpose({ focus: () => { input.value?.focus(); } });

/** Ask for the values of the field being typed, or of every data-valued field for loose words. */
async function fetchValues(values: (field: string, prefix: string) => Promise<readonly ValueOption[]>, text: string): Promise<void> {
  const mine = ++generation;
  const { field, prefix } = typing(props.fields, text);
  const asked = field !== undefined
    ? (props.fields[field]?.dynamic === true ? [field] : [])
    : (prefix === '' ? [] : Object.entries(props.fields).filter(([, decl]) => decl.dynamic === true && decl.filterable).map(([key]) => key));
  const got = await Promise.all(asked.map(async (key) => [key, await values(key, prefix).catch(() => [])] as const));
  if (mine === generation) { fetched.value = Object.fromEntries(got); }
}

function addFilter(filter: Filter, at?: number): void {
  model.value = withFilter(model.value, filter, at);
}

/** Take a suggestion: a pill (the typed words go), a field (its menu opens), or the words as the search. */
function choose(suggestion: Suggestion): void {
  switch (suggestion.kind) {
    case 'filter':
      clearTimeout(textTimer);
      model.value = withText(withFilter(model.value, suggestion.filter), '');
      draft.value = '';
      break;
    case 'field':
      draft.value = '';
      openMenu(undefined, suggestion.field);
      return;
    case 'text':
      clearTimeout(textTimer);
      model.value = withText(model.value, suggestion.text);
      break;
  }
  suggesting.value = false;
  input.value?.focus();
}

/** A finished filter word before the caret becomes a pill when a space follows it. */
function onInput(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) { return; }
  const text = event.target.value;
  suggesting.value = true;
  const last = /(\S+)\s$/.exec(text);
  const spelled = last === null ? undefined : readFilter(props.fields, last[1] ?? '');
  if (spelled !== undefined && last !== null) {
    addFilter(spelled);
    draft.value = text.slice(0, last.index);
    return;
  }
  draft.value = text;
}

function onKey(event: KeyboardEvent): void {
  const list = suggestions.value;
  switch (event.key) {
    case 'ArrowDown': case 'ArrowUp':
      if (list.length === 0) { return; }
      event.preventDefault();
      suggesting.value = true;
      active.value = (active.value + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
      return;
    case 'Enter': {
      event.preventDefault();
      const chosen = listOpen.value ? list[active.value] : undefined;
      if (chosen !== undefined) { choose(chosen); return; }
      clearTimeout(textTimer);
      model.value = withText(model.value, wordsOf(draft.value));
      suggesting.value = false;
      return;
    }
    case 'Escape':
      if (listOpen.value) { event.preventDefault(); suggesting.value = false; }
      return;
    case 'Backspace':
      if (draft.value === '' && filters.value.length > 0) { remove(filters.value.length - 1); }
      return;
  }
}

function remove(at: number): void {
  model.value = withoutFilter(model.value, at);
  input.value?.focus();
}

/** The field a new filter starts on, when a field suggestion opened the menu. */
const startField = ref<string | undefined>(undefined);
function openMenu(at?: number, field?: string): void {
  editingAt.value = at;
  startField.value = field;
  suggesting.value = false;
  menuOpen.value = true;
}
function applyMenu(filter: Filter): void {
  addFilter(filter, editingAt.value);
  closeMenu();
}
function closeMenu(): void {
  menuOpen.value = false;
  editingAt.value = undefined;
  startField.value = undefined;
  input.value?.focus();
}
watch(menuOpen, (open) => { if (!open) { editingAt.value = undefined; startField.value = undefined; } });

function clearAll(): void {
  clearTimeout(textTimer);
  draft.value = '';
  model.value = withText(withoutAll(model.value), '');
  input.value?.focus();
}
function withoutAll(query: SearchQuery): SearchQuery {
  const { filters: _filters, ...rest } = query;
  return rest;
}
const hasAny = computed(() => filters.value.length > 0 || draft.value !== '');
const listId = `search-${Math.random().toString(36).slice(2, 9)}`;
</script>

<template>
  <div ref="box" class="ui-search" role="search" :aria-label="label" data-testid="search" @click.self="input?.focus()">
    <UiIcon name="search" :size="16" class="lead" />
    <div class="field" @click.self="input?.focus()">
      <span v-for="(text, i) in pills" :key="i" class="pill" :title="text" data-testid="search-pill">
        <button type="button" class="pill-text" :aria-label="`Change filter ${text}`" @click="openMenu(i)">{{ text }}</button>
        <button type="button" class="pill-x" :aria-label="`Remove filter ${text}`" @click="remove(i)"><UiIcon name="x" :size="12" /></button>
      </span>
      <input
        ref="input" class="text" :class="{ typing: draft !== '' || filters.length === 0 }" type="search" :value="draft" :placeholder="filters.length === 0 ? placeholder : ''" :aria-label="label" autocomplete="off"
        role="combobox" :aria-expanded="listOpen ? 'true' : 'false'" :aria-controls="listId" aria-autocomplete="list" data-testid="search-input"
        :aria-activedescendant="listOpen ? `${listId}-${active}` : undefined"
        @input="onInput" @keydown="onKey" @focus="suggesting = true" @blur="suggesting = false"
      />
    </div>
    <button v-if="hasAny" type="button" class="icon-btn" aria-label="Clear search and filters" @click="clearAll"><UiIcon name="x" :size="14" /></button>
    <button type="button" class="icon-btn" :class="{ on: menuOpen }" aria-label="Add a filter" aria-haspopup="dialog" :aria-expanded="menuOpen ? 'true' : 'false'" data-testid="search-filter" @click="menuOpen ? closeMenu() : openMenu()">
      <UiIcon name="filter" :size="16" />
    </button>
  </div>
  <UiPopover v-model:open="listOpen" :anchor="box" role="listbox" :label="`Suggestions for ${label}`" match-width :take-focus="false">
    <ul :id="listId" class="suggestions" data-testid="search-suggestions">
      <li
        v-for="(s, i) in suggestions" :id="`${listId}-${i}`" :key="`${s.kind}-${s.label}`" role="option" class="suggestion" :class="{ active: i === active }"
        :aria-selected="i === active ? 'true' : 'false'" @mousedown.prevent="choose(s)" @mouseenter="active = i"
      >
        <UiIcon :name="s.kind === 'filter' ? 'filter' : s.kind === 'field' ? 'chevron-right' : 'search'" :size="14" class="faint" />
        <span class="s-label">{{ s.label }}</span>
        <span v-if="s.kind === 'filter' && s.count !== undefined" class="faint">{{ s.count }}</span>
        <span v-else-if="s.kind === 'field'" class="faint">filter by</span>
      </li>
    </ul>
  </UiPopover>
  <UiPopover v-model:open="menuOpen" :anchor="box" align="end" :label="editing ? 'Change filter' : 'Add a filter'">
    <UiFilterMenu :key="`${editingAt ?? 'new'}-${startField ?? ''}`" :fields="fields" :format="format" :values="values" :editing="editing" :start="startField" @apply="applyMenu" @cancel="closeMenu" />
  </UiPopover>
</template>

<style scoped>
.ui-search {
  display: flex; align-items: flex-start; gap: var(--space-1); flex: 1 1 260px; min-width: 0; min-height: var(--control);
  /* one row is exactly a control tall: 1px border, 5px padding and a 28px row each side */
  padding: 5px var(--space-1) 5px var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); cursor: text;
  transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.ui-search:hover { border-color: var(--text-faint); }
.ui-search:focus-within { border-color: var(--accent); box-shadow: var(--ring); }
.lead { flex: none; margin: 6px var(--space-1) 0 0; color: var(--text-faint); }
/* pills and the input share rows 28px tall, the height of the buttons beside them, so all sit on one centre line */
.field { display: flex; flex: 1 1 auto; flex-wrap: wrap; align-items: center; gap: 0 var(--space-1); min-width: 0; min-height: 28px; }
.pill {
  display: inline-flex; align-items: center; min-width: 0; max-width: 100%; height: 24px; margin-block: 2px; border: 1px solid color-mix(in oklab, var(--accent) 35%, var(--border));
  border-radius: var(--radius-full); background: var(--accent-soft); font-size: var(--text-xs); cursor: default;
}
.pill-text { min-width: 0; padding: 0 4px 0 8px; border: 0; background: none; color: var(--text); font: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.pill-x { display: grid; place-items: center; width: 20px; height: 20px; margin-right: 2px; padding: 0; border: 0; border-radius: var(--radius-full); background: none; color: var(--text-dim); }
.pill-x:hover { background: var(--surface-3); color: var(--text); }
/* beside pills the input takes whatever room is left on their row; once typed in (or with no pills) it needs a little more */
.text { flex: 1 1 1rem; min-width: 1rem; height: 28px; padding: 0; border: 0; background: transparent; color: var(--text); font: inherit; outline: none; }
.text.typing { min-width: 6rem; }
.text::placeholder { color: var(--text-faint); }
.text::-webkit-search-cancel-button { display: none; }
.icon-btn { display: grid; place-items: center; flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--radius-sm); background: none; color: var(--text-dim); }
.icon-btn:hover, .icon-btn.on { background: var(--surface-2); color: var(--text); }
.icon-btn:focus-visible { outline: none; box-shadow: var(--ring); }
.suggestions { display: grid; margin: 0; padding: var(--space-1); list-style: none; }
.suggestion { display: flex; align-items: center; gap: var(--space-2); min-height: 32px; padding: 0 var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-sm); cursor: pointer; }
.suggestion.active { background: var(--surface-2); }
.s-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.faint { color: var(--text-faint); font-size: var(--text-xs); }
</style>
