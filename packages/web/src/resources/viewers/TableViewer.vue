<script setup lang="ts">
/**
 * Tables: a workbook's sheets (or a csv's one table) with a tab per table, a sticky header row and first column,
 * columns sorted by a click on their header (numbers and dates by value), rows filtered by words, numbers aligned
 * right, row numbers, and rows shown a page at a time ("showing 200 of 52,000 rows" with more on request).
 */
import { computed, ref, watch } from 'vue';
import { UiButton, UiIcon, UiInput, UiTabs, type TabItem } from '../../ui/index.ts';
import { isNumeric, kindsOf, nextSort, viewRows, type Table, type TableView } from '../logic/tables.ts';

const props = withDefaults(defineProps<{ tables: readonly Table[]; compact?: boolean }>(), { compact: false });

/** Rows drawn at first and added per "show more". */
const ROWS = 200;
const at = ref('0');
const filter = ref('');
const sort = ref<TableView['sort']>(undefined);
const limit = ref(ROWS);
watch(() => props.tables, () => { at.value = '0'; });
watch([at, filter, sort], () => { limit.value = ROWS; });

const tabs = computed<readonly TabItem<string>[]>(() => props.tables.map((t, i) => ({ value: String(i), label: t.name ?? t.sheetName ?? `Table ${i + 1}`, count: t.rows.length })));
const table = computed(() => props.tables[Number(at.value)]);
const kinds = computed(() => (table.value === undefined ? [] : kindsOf(table.value)));
const rows = computed(() => (table.value === undefined ? [] : viewRows(table.value, { filter: filter.value, ...(sort.value === undefined ? {} : { sort: sort.value }) }, kinds.value)));
const shown = computed(() => rows.value.slice(0, props.compact ? 8 : limit.value));
const width = computed(() => Math.max(table.value?.headers.length ?? 0, ...(table.value?.rows.slice(0, 500).map((r) => r.length) ?? [0])));
const columns = computed(() => Array.from({ length: width.value }, (_, i) => ({ index: i, name: table.value?.headers[i] ?? `Column ${i + 1}`, numeric: isNumeric(kinds.value[i]) })));

function sortBy(column: number): void {
  sort.value = nextSort(sort.value, column);
}
const ariaSort = (column: number): 'ascending' | 'descending' | 'none' => (sort.value?.column !== column ? 'none' : sort.value.descending ? 'descending' : 'ascending');
</script>

<template>
  <div class="table-viewer" :class="{ compact }" data-testid="table-view">
    <UiTabs v-if="tables.length > 1 && !compact" v-model="at" :tabs="tabs" label="Tables" />
    <div v-if="!compact && table" class="tools">
      <UiInput v-model="filter" type="search" icon="filter" label="Filter rows" hide-label placeholder="Filter rows" size="sm" clearable />
      <span class="count" aria-live="polite">
        <template v-if="filter.trim() !== ''">{{ rows.length.toLocaleString() }} of {{ table.rows.length.toLocaleString() }} rows match</template>
        <template v-else>{{ table.rows.length.toLocaleString() }} rows · {{ width }} columns</template>
      </span>
    </div>
    <p v-if="!table" class="dim">There are no tables in this.</p>
    <div v-else class="scroller" tabindex="0" role="region" :aria-label="tabs[Number(at)]?.label ?? 'Table'">
      <table class="grid">
        <thead>
          <tr>
            <th class="rownum" scope="col"><span class="sr-only">Row</span></th>
            <th
              v-for="column in columns" :key="column.index" scope="col" :class="{ numeric: column.numeric }" :aria-sort="ariaSort(column.index)"
            >
              <button type="button" class="sort" :disabled="compact" @click="sortBy(column.index)">
                <span class="head-name">{{ column.name }}</span>
                <UiIcon v-if="sort?.column === column.index" :name="sort.descending ? 'chevron-down' : 'chevron-up'" :size="14" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in shown" :key="row.number">
            <th class="rownum" scope="row">{{ row.number }}</th>
            <td v-for="column in columns" :key="column.index" :class="{ numeric: column.numeric }">{{ row.cells[column.index] ?? '' }}</td>
          </tr>
          <tr v-if="shown.length === 0"><td :colspan="columns.length + 1" class="dim">No rows{{ filter.trim() === '' ? '' : ' match' }}.</td></tr>
        </tbody>
      </table>
    </div>
    <div v-if="!compact && rows.length > shown.length" class="more">
      <span class="dim">Showing {{ shown.length.toLocaleString() }} of {{ rows.length.toLocaleString() }} rows</span>
      <UiButton size="sm" variant="ghost" @click="limit += ROWS">Show {{ Math.min(ROWS, rows.length - shown.length).toLocaleString() }} more</UiButton>
    </div>
  </div>
</template>

<style scoped>
.table-viewer { display: grid; gap: var(--space-2); min-width: 0; }
.tools { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); }
.tools > :first-child { flex: 1 1 200px; max-width: 320px; }
.count { color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.scroller { max-width: 100%; max-height: min(70dvh, 720px); overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); }
.compact .scroller { max-height: 220px; }
.scroller:focus-visible { outline: none; box-shadow: var(--ring); }
.grid { border-collapse: separate; border-spacing: 0; font-size: var(--text-sm); min-width: 100%; }
.grid th, .grid td { padding: var(--space-1) var(--space-3); border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); white-space: nowrap; max-width: 360px; overflow: hidden; text-overflow: ellipsis; text-align: left; }
.grid thead th { position: sticky; top: 0; z-index: 2; background: var(--surface-2); font-weight: var(--weight-medium); }
.grid .rownum { width: 1%; position: sticky; left: 0; z-index: 1; background: var(--surface-2); color: var(--text-faint); font: var(--text-xs) var(--mono); text-align: right; }
.grid thead .rownum { z-index: 3; }
.grid td.numeric, .grid th.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.sort { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.sort:disabled { cursor: default; }
.sort:focus-visible { outline: none; box-shadow: var(--ring); border-radius: 4px; }
.head-name { overflow: hidden; text-overflow: ellipsis; }
.more { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }
.dim { color: var(--text-faint); font-size: var(--text-sm); }
</style>
