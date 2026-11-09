<script setup lang="ts">
/** A single value (one row, one column): large, with its column's name under it. */
import { computed } from 'vue';
import { cellText } from './table.ts';
import type { VisualProps } from './visuals.ts';

const props = defineProps<VisualProps>();
const column = computed(() => props.table.columns[0]);
const text = computed(() => (column.value === undefined ? undefined : cellText(props.table.rows[0]?.[0], column.value)));
</script>

<template>
  <div class="value" data-testid="result-value">
    <strong class="number" :class="{ empty: text === undefined }">{{ text ?? 'null' }}</strong>
    <span class="name">{{ column?.label ?? column?.name }}</span>
  </div>
</template>

<style scoped>
.value { display: grid; gap: 2px; padding: var(--space-2) 0; min-width: 0; }
.number { font-size: var(--text-2xl); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.number.empty { color: var(--text-faint); font-style: italic; }
.name { color: var(--text-dim); font-size: var(--text-sm); }
</style>
