<script setup lang="ts">
/**
 * A bar chart of one label column and one number column (a single series, so the number column's name heads it and
 * there is no legend): horizontal bars so long labels stay readable at any width, each with its value written at its
 * end, on one quiet baseline. The rows keep the result's order.
 */
import { computed } from 'vue';
import { cellText } from './table.ts';
import type { VisualProps } from './visuals.ts';

const props = defineProps<VisualProps>();

const labelColumn = computed(() => props.table.columns[0]);
const valueColumn = computed(() => props.table.columns[1]);
const bars = computed(() => {
  const label = labelColumn.value;
  const value = valueColumn.value;
  if (label === undefined || value === undefined) { return []; }
  const numbers = props.table.rows.map((row) => (typeof row[1] === 'number' ? row[1] : 0));
  const top = Math.max(0, ...numbers);
  return props.table.rows.map((row, i) => {
    const amount = numbers[i] ?? 0;
    return { key: i, label: cellText(row[0], label) ?? '—', value: cellText(row[1], value) ?? '', width: top === 0 ? 0 : (amount / top) * 100 };
  });
});
</script>

<template>
  <figure class="bars" data-testid="result-bars">
    <figcaption class="title">{{ valueColumn?.label ?? valueColumn?.name }} <span class="by">by {{ labelColumn?.label ?? labelColumn?.name }}</span></figcaption>
    <ul class="rows">
      <li v-for="bar in bars" :key="bar.key" class="row" :aria-label="`${bar.label}: ${bar.value}`">
        <span class="label" :title="bar.label">{{ bar.label }}</span>
        <span class="track" aria-hidden="true"><span class="bar" :style="{ width: `${bar.width <= 0 ? 0 : Math.max(0.6, bar.width)}%` }" /></span>
        <span class="value">{{ bar.value }}</span>
      </li>
    </ul>
  </figure>
</template>

<style scoped>
.bars { display: grid; gap: var(--space-2); margin: 0; min-width: 0; }
.title { font-size: var(--text-sm); font-weight: var(--weight-strong); }
.by { color: var(--text-dim); font-weight: var(--weight-medium); }
.rows { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; max-height: 420px; overflow-y: auto; }
.row { display: grid; grid-template-columns: minmax(64px, 28%) minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); min-width: 0; font-size: var(--text-sm); }
.label { overflow: hidden; color: var(--text-dim); text-overflow: ellipsis; white-space: nowrap; }
.track { display: block; height: 14px; border-left: 1px solid var(--border-strong); }
/* a thin mark, rounded where the data ends, square on the baseline */
.bar { display: block; height: 100%; border-radius: 0 4px 4px 0; background: var(--series-1); transition: width var(--medium) var(--ease); }
.value { min-width: 3ch; color: var(--text); font-variant-numeric: tabular-nums; text-align: right; }
</style>
