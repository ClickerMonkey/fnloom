<script setup lang="ts">
/** The value visual: a result of one row and one column, drawn large with its column's name under it. */
import type { VisualProps } from './props.ts';
import { formatCell } from './format.ts';

defineProps<VisualProps>();
</script>

<template>
  <div class="db-value">
    <span class="number">{{ formatCell(table.rows[0]?.[0], table.columns[0]?.kind ?? 'text') }}</span>
    <span class="name">{{ table.columns[0]?.label ?? table.columns[0]?.name }}</span>
  </div>
</template>

<style scoped>
.db-value { display: inline-flex; flex-direction: column; gap: var(--space-1); padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); max-width: 100%; }
.number { font-size: var(--text-2xl); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.name { font-size: var(--text-sm); color: var(--text-dim); }
</style>
