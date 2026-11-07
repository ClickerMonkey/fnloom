<script setup lang="ts">
/**
 * The input for an `fs/Entry` in forms and handler prompts: what it is (file, folder or link) and its path, with
 * the size and modified time shown when the value came from the system. Works with `v-model`.
 */
import type { InputViewOf } from '@harness/sdk';
import { computed, useId } from 'vue';
import { formatBytes } from '../shared/format.ts';
import type { EntryValue, fs } from '../shared/index.ts';

const props = defineProps<InputViewOf<typeof fs, 'Entry'>>();
const emit = defineEmits<{ 'update:modelValue': [value: EntryValue] }>();

const TYPES: ReadonlyArray<{ value: EntryValue['type']; label: string }> = [
  { value: 'file', label: 'File' },
  { value: 'folder', label: 'Folder' },
  { value: 'link', label: 'Link' },
];

const id = useId();
const current = computed<EntryValue>(() => props.modelValue ?? { path: '', type: 'file', size: 0, modifiedAt: new Date() });
const known = computed(() => props.modelValue !== undefined && props.modelValue.path !== '' && props.modelValue.size > 0);
const details = computed(() => {
  const value = current.value;
  const when = value.modifiedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return value.type === 'file' ? `${formatBytes(value.size)} · modified ${when}` : `modified ${when}`;
});

function change(patch: Partial<EntryValue>): void {
  emit('update:modelValue', { ...current.value, ...patch });
}
function onPath(event: Event): void {
  if (event.target instanceof HTMLInputElement) { change({ path: event.target.value }); }
}
</script>

<template>
  <div class="entry" :class="{ invalid: props.problems.length > 0 }">
    <div class="types" role="radiogroup" aria-label="What it is">
      <button
        v-for="option in TYPES" :key="option.value" type="button" role="radio" class="type"
        :aria-checked="current.type === option.value" @click="change({ type: option.value })"
      >
        {{ option.label }}
      </button>
    </div>
    <label class="field" :for="`${id}-path`">
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
        <path v-if="current.type === 'folder'" d="M1.5 4a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
        <path v-else d="M4 1.5h5L12.5 5v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z" />
      </svg>
      <input
        :id="`${id}-path`" class="path" type="text" spellcheck="false" autocomplete="off" placeholder="docs/notes.md"
        :value="current.path" :aria-invalid="props.problems.length > 0" :aria-describedby="`${id}-help`" @input="onPath"
      >
    </label>
    <p :id="`${id}-help`" class="help">
      <template v-if="props.problems.length > 0">
        <span v-for="problem in props.problems" :key="problem" class="problem">{{ problem }}</span>
      </template>
      <template v-else-if="known">{{ details }}</template>
      <template v-else>Absolute, or relative to a root.</template>
    </p>
  </div>
</template>

<style scoped>
.entry { display: grid; gap: var(--space-2); min-width: 0; }
.types { display: inline-flex; justify-self: start; padding: 2px; border-radius: var(--radius-sm); background: var(--surface-2); }
.type {
  min-height: 28px;
  padding: 0 var(--space-3);
  border: 0;
  border-radius: calc(var(--radius-sm) - 2px);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: background var(--fast) var(--ease), color var(--fast) var(--ease);
}
.type[aria-checked='true'] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
.field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.field:focus-within { border-color: var(--accent); box-shadow: var(--ring); }
.invalid .field { border-color: var(--danger); }
.icon { width: 16px; height: 16px; flex: none; fill: none; stroke: var(--text-dim); stroke-width: 1.3; stroke-linejoin: round; }
.path { flex: 1; min-width: 0; min-height: var(--control); border: 0; outline: 0; background: transparent; font: var(--text-sm)/1.4 var(--mono); }
.help { display: grid; gap: 2px; margin: 0; color: var(--text-dim); font-size: var(--text-xs); }
.problem { color: var(--danger); }
</style>
