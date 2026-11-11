<script setup lang="ts">
/**
 * The table visual: a result's rows under a header, each column formatted for its kind (numbers right-aligned
 * in tabular figures, empty cells marked, long text on one line with the full value on hover), sortable by a header
 * click, paged 25 at a time. The table is as tall as its page (never a scroll inside the chat or page); a table wider
 * than its frame scrolls sideways, with its first column pinned and the cut side faded so the hidden columns show. When the rows held are the whole result, sorting and paging happen here; when they are a slice,
 * moving past them or sorting asks the fn again (`pager`), and without a pager the sort orders the rows held.
 */
import type { ResultSort } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiIcon, UiIconButton, useMoreEdges } from '../../ui/index.ts';
import { cellText, gridWindow, isComplete, isNumeric, nextSort, sortRows, windowLabel } from './table.ts';
import type { VisualProps } from './visuals.ts';

const props = withDefaults(defineProps<VisualProps>(), { pager: undefined });

const strip = ref<HTMLElement | null>(null);
/** The sides with columns beyond them; any at all pins the first column. */
const edges = useMoreEdges(strip);

/** The sort picked here (rows held), over the sort the table was read with. */
const picked = ref<ResultSort | undefined>(undefined);
const page = ref(0);
watch(() => props.table, () => { picked.value = undefined; page.value = 0; });

const complete = computed(() => isComplete(props.table));
const sort = computed(() => picked.value ?? props.table.sort[0]);
const rows = computed(() => (picked.value === undefined ? props.table.rows : sortRows(props.table, picked.value)));
const window = computed(() => gridWindow(props.table, rows.value, page.value));
const label = computed(() => windowLabel(window.value, props.table.truncated));

function sortBy(column: string): void {
  const next = nextSort(sort.value, column);
  if (!complete.value && props.pager !== undefined) {
    props.pager({ offset: 0, limit: props.table.limit ?? props.table.rows.length, sort: next === undefined ? [] : [next] });
    return;
  }
  picked.value = next;
  page.value = 0;
}

function prev(): void {
  if (window.value.canPrev) { page.value--; } else if (window.value.fetchPrev !== undefined) { props.pager?.(window.value.fetchPrev); }
}

function next(): void {
  if (window.value.canNext) { page.value++; } else if (window.value.fetchNext !== undefined) { props.pager?.(window.value.fetchNext); }
}

const hasPrev = computed(() => window.value.canPrev || (window.value.fetchPrev !== undefined && props.pager !== undefined));
const hasNext = computed(() => window.value.canNext || (window.value.fetchNext !== undefined && props.pager !== undefined));
const ariaSort = (column: string): 'ascending' | 'descending' | 'none' => (sort.value?.column !== column ? 'none' : sort.value.dir === 'asc' ? 'ascending' : 'descending');
</script>

<template>
  <div class="grid" data-testid="result-grid">
    <div class="frame">
      <div ref="strip" class="scroll edge-fade" :class="{ pinned: edges !== '' }" :data-more="edges" tabindex="0" role="region" :aria-label="title">
        <table>
          <thead>
            <tr>
              <th v-for="column in table.columns" :key="column.name" scope="col" :class="{ num: isNumeric(column) }" :aria-sort="ariaSort(column.name)">
                <button type="button" class="sort" :title="`Sort by ${column.label ?? column.name}`" @click="sortBy(column.name)">
                  <span class="name">{{ column.label ?? column.name }}</span>
                  <span class="kind">{{ column.kind }}</span>
                  <UiIcon v-if="sort?.column === column.name" :name="sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'" :size="12" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, r) in window.rows" :key="window.from + r">
              <td v-for="(column, c) in table.columns" :key="column.name" :class="{ num: isNumeric(column), mono: column.kind === 'json' || column.kind === 'uuid' }">
                <span v-if="cellText(row[c], column) === undefined" class="empty">null</span>
                <span v-else class="cell" :title="cellText(row[c], column)">{{ cellText(row[c], column) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="table.rows.length === 0" class="none">No rows.</p>
      </div>
    </div>
    <footer v-if="hasPrev || hasNext || !complete" class="foot">
      <span class="count" data-testid="result-count">{{ label }}</span>
      <span v-if="!complete && pager === undefined && table.truncated" class="hint">Ask for more to see the rest.</span>
      <span class="pages">
        <UiIconButton icon="chevron-left" label="Previous rows" size="sm" :disabled="!hasPrev" data-testid="result-prev" @click="prev" />
        <UiIconButton icon="chevron-right" label="Next rows" size="sm" :disabled="!hasNext" data-testid="result-next" @click="next" />
      </span>
    </footer>
  </div>
</template>

<style scoped>
.grid { display: grid; gap: var(--space-2); min-width: 0; }
.frame { container-type: inline-size; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.scroll { overflow-x: auto; overflow-y: hidden; }
.scroll:focus-visible { outline: none; box-shadow: inset var(--ring); }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--text-sm); }
th { padding: 0; border-bottom: 1px solid var(--border-strong); background: var(--surface-2); text-align: left; white-space: nowrap; }
.sort {
  display: flex; align-items: baseline; gap: 6px; width: 100%; padding: var(--space-2) var(--space-3); border: 0; background: transparent;
  color: var(--text); font: inherit; font-weight: var(--weight-strong); text-align: inherit; cursor: pointer;
}
.sort:hover { background: var(--surface-3); }
.sort:focus-visible { outline: none; box-shadow: inset var(--ring); }
.num .sort { justify-content: flex-end; }
.kind { color: var(--text-faint); font-size: var(--text-xs); font-weight: 400; }
td { padding: 6px var(--space-3); border-bottom: 1px solid var(--border); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--surface-2); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-family: var(--mono); font-size: var(--text-xs); }
/* wide: the first column stays put while the rest scroll under it, at most 40% of the frame */
.pinned th:first-child, .pinned td:first-child { position: sticky; left: 0; z-index: 1; box-shadow: inset -1px 0 0 var(--border); }
.scroll.pinned { --fade-start: 0px; }
.pinned td:first-child { background: var(--surface); }
.pinned tbody tr:hover td:first-child { background: var(--surface-2); }
.pinned td:first-child .cell, .pinned th:first-child .name { max-width: 40cqi; overflow: hidden; text-overflow: ellipsis; }
.cell { display: block; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: var(--text-faint); font-style: italic; }
.none { margin: 0; padding: var(--space-3); color: var(--text-dim); font-size: var(--text-sm); }
.foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); color: var(--text-dim); font-size: var(--text-xs); }
.count { font-variant-numeric: tabular-nums; }
.hint { color: var(--text-faint); }
.pages { display: flex; gap: 2px; margin-left: auto; }
</style>
