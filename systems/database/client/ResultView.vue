<script setup lang="ts">
/**
 * A query's rows in the chat (the `result` attachment): the best fitting visual, a switch between every visual that
 * fits (hidden when only the table does), and a line with the count, whether there are more rows, and the sort.
 */
import { ResultTable } from '@harness/core';
import type { AttachmentViewOf } from '@harness/sdk';
import { computed } from 'vue';
import type { database } from '../shared/index.ts';
import { OWN_VISUALS } from './own-visuals.ts';
import { useVisualChoice } from './visuals.ts';

const props = defineProps<AttachmentViewOf<typeof database, 'result'>>();
const table = computed(() => ResultTable.parse(props.data));
const { options, shown, choose } = useVisualChoice(table, OWN_VISUALS);
const summary = computed(() => {
  const { rows: list, total, offset, truncated, sort: order } = table.value;
  const rows = list.length;
  const count = total !== undefined && total > rows
    ? `Rows ${offset + 1}–${offset + rows} of ${total}`
    : `${rows} ${rows === 1 ? 'row' : 'rows'}${truncated ? ', more available' : ''}`;
  const sort = order.map((entry) => `${entry.column} ${entry.dir === 'asc' ? '↑' : '↓'}`).join(', ');
  return sort === '' ? count : `${count} · sorted by ${sort}`;
});
</script>

<template>
  <section class="db-result" :aria-label="title">
    <header>
      <span class="summary">{{ summary }}</span>
      <div v-if="options.length > 1" class="switch" role="radiogroup" aria-label="Show as">
        <button
          v-for="option in options" :key="option.name" type="button" role="radio"
          :aria-checked="shown?.name === option.name" :class="{ on: shown?.name === option.name }" @click="choose(option.name)"
        >
          {{ option.label }}
        </button>
      </div>
    </header>
    <component :is="shown.visual.component" v-if="shown" :table="table" :system="system" />
  </section>
</template>

<style scoped>
.db-result { display: grid; gap: var(--space-2); min-width: 0; }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.summary { font-size: var(--text-xs); color: var(--text-dim); }
.switch { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface-2); }
.switch button { border: none; background: transparent; color: var(--text-dim); font: inherit; font-size: var(--text-xs); padding: var(--space-1) var(--space-2); border-radius: var(--radius-full); cursor: pointer; }
.switch button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
.switch button:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
</style>
