<script setup lang="ts">
/**
 * The table visual: every column and row of a result, numbers on the right, a sticky header, scrolling sideways on
 * narrow screens instead of squeezing columns. Always fits; the lowest score.
 */
import type { VisualProps } from './props.ts';
import { alignsRight, formatCell } from './format.ts';

defineProps<VisualProps>();
</script>

<template>
  <div class="db-table" role="region" aria-label="Result rows" tabindex="0">
    <table>
      <thead>
        <tr>
          <th v-for="column in table.columns" :key="column.name" scope="col" :class="{ num: alignsRight(column.kind) }">{{ column.label ?? column.name }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, r) in table.rows" :key="r">
          <td v-for="(column, c) in table.columns" :key="column.name" :class="{ num: alignsRight(column.kind), empty: row[c] === null }">{{ formatCell(row[c], column.kind) }}</td>
        </tr>
        <tr v-if="table.rows.length === 0"><td class="none" :colspan="Math.max(table.columns.length, 1)">No rows.</td></tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.db-table { overflow: auto; max-height: 26rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: var(--text-sm); }
th, td { padding: var(--space-1) var(--space-2); text-align: left; white-space: nowrap; border-bottom: 1px solid var(--border); }
th { position: sticky; top: 0; background: var(--surface-2); color: var(--text-dim); font-weight: var(--weight-medium); z-index: 1; }
td { max-width: 24rem; overflow: hidden; text-overflow: ellipsis; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: var(--surface-2); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.empty, .none { color: var(--text-faint); }
</style>
