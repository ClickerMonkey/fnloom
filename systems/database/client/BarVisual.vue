<script setup lang="ts">
/**
 * The bar chart visual: one bar per row, its label on the left and its value at the end, scaled to the largest
 * value. Fits a result of one label column and one number column with 2 to 50 rows.
 */
import type { VisualProps } from './props.ts';
import { computed } from 'vue';
import { barsOf } from '../shared/visuals.ts';
import { formatCell } from './format.ts';

const props = defineProps<VisualProps>();
const chart = computed(() => barsOf(props.table));
const valueKind = computed(() => props.table.columns[1]?.kind ?? 'number');
const width = (value: number): string => `${chart.value.max === 0 ? 0 : Math.max(1, (Math.abs(value) / chart.value.max) * 100)}%`;
</script>

<template>
  <figure class="db-bars">
    <figcaption>{{ table.columns[1]?.label ?? table.columns[1]?.name }} by {{ table.columns[0]?.label ?? table.columns[0]?.name }}</figcaption>
    <ul>
      <li v-for="(bar, i) in chart.bars" :key="i">
        <span class="label" :title="bar.label">{{ bar.label }}</span>
        <span class="track"><span class="bar" :style="{ width: width(bar.value) }" /></span>
        <span class="value">{{ formatCell(bar.value, valueKind) }}</span>
      </li>
    </ul>
  </figure>
</template>

<style scoped>
.db-bars { margin: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
figcaption { font-size: var(--text-xs); color: var(--text-dim); margin-bottom: var(--space-2); }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); max-height: 26rem; overflow: auto; }
li { display: grid; grid-template-columns: minmax(4rem, 30%) 1fr auto; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track { height: 0.75rem; background: var(--surface-2); border-radius: var(--radius-full); overflow: hidden; }
.bar { display: block; height: 100%; background: var(--series-1); border-radius: var(--radius-full); }
.value { font-variant-numeric: tabular-nums; color: var(--text-dim); min-width: 3rem; text-align: right; }
</style>
