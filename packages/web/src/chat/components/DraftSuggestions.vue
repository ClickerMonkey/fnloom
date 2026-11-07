<script setup lang="ts">
/**
 * A faint row above the composer while writing: the fns and context that match the draft by meaning, best first.
 * Picking a fn opens its `!` form; picking context adds its `/` command.
 */
import type { Suggestion } from '@harness/core';
import { UiIcon } from '../../ui/index.ts';
import { fnLabel, humanize, localName } from '../logic/labels.ts';

defineProps<{ items: readonly Suggestion[] }>();
const emit = defineEmits<{ use: [item: Suggestion] }>();
</script>

<template>
  <div v-if="items.length > 0" class="row" role="region" aria-label="Suggestions for your message" data-testid="draft-suggestions">
    <span class="label"><UiIcon name="sparkles" :size="12" /> Might help</span>
    <ul class="items">
      <li v-for="item in items" :key="`${item.kind}:${item.name}`">
        <button type="button" class="item" :title="`${item.name} · ${item.description}`" :data-kind="item.kind" @click="emit('use', item)">
          <UiIcon :name="item.kind === 'fn' ? 'fn' : 'file'" :size="12" />
          {{ item.kind === 'fn' ? fnLabel(item.name) : humanize(localName(item.name)) }}
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: var(--space-2); min-width: 0; animation: ui-fade-in var(--medium) var(--ease); }
.label { display: inline-flex; align-items: center; gap: 4px; flex: none; color: var(--text-faint); font-size: var(--text-xs); }
.items { display: flex; gap: var(--space-1); min-width: 0; margin: 0; padding: 2px; overflow-x: auto; list-style: none; scrollbar-width: none; }
.item {
  display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 var(--space-2); border: 1px dashed var(--border-strong);
  border-radius: var(--radius-full); background: transparent; color: var(--text-dim); font-size: var(--text-xs); white-space: nowrap;
}
.item:hover { border-style: solid; color: var(--text); background: var(--surface-2); }
.item:focus-visible { outline: none; box-shadow: var(--ring); }
</style>
