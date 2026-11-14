<script setup lang="ts">
/**
 * The table visual: a result's rows under a header, each column formatted for its kind (numbers right-aligned
 * in tabular figures, empty cells marked, long text on one line with the full value on hover), sortable by a header
 * click, paged 25 at a time. The table is as tall as its page (never a scroll inside the chat or page); a table wider
 * than its frame scrolls sideways, with its first column pinned and the cut side faded so the hidden columns show. When the rows held are the whole result, sorting and paging happen here; when they are a slice,
 * moving past them or sorting asks the fn again (`pager`), and without a pager the sort orders the rows held. A
 * buffered pager (a widget's) only adds rows after those held, so the sort orders the rows held there too. The page
 * size starts at the visual's (`pageSize`) and the person may change it.
 *
 * The table family's styles: `table`, `compact` (tighter rows) and `cards` (a card per row, each column labelled),
 * which it also takes by itself when drawn narrower than 600px and too narrow for its columns (product's phone rule;
 * a chat card on a wide screen keeps a table its columns fit in). With a binding it draws the
 * bound columns only (ranking leaves out the opaque ones: ids, keys, references), in their order. A click on a row
 * (or card) emits `drill` with its index in the table, as a chart's mark does: the page runs its drill there, else
 * opens the row's actions; where a click drills (`DRILLABLE`) the rows show they can be clicked. Where the widget view provides a cell editor (the Data page's records), an editable column's
 * cells are inputs: what is typed is staged there, a changed cell marked, and a click in one never opens the row.
 */
import type { ResultSort } from '@harness/core';
import type { Json, ResultColumn } from '@harness/core';
import { computed, inject, ref, watch } from 'vue';
import { UiIcon, UiIconButton, UiSelect, useMoreEdges, type SelectOption } from '../../ui/index.ts';
import { PHONE_WIDTH, useWidth } from '../visuals/size.ts';
import { cellText, GRID_PAGE, gridWindow, isComplete, isNumeric, nextSort, PAGE_SIZES, sortRows, windowLabel } from './table.ts';
import { CELL_EDITOR } from '../widgets/record-edits.ts';
import { WIDGET_HOST } from '../widgets/widgets.ts';
import { DRILLABLE, type VisualProps } from './visuals.ts';

/** The width a column needs to read as a table column; a narrower frame draws cards. */
const COLUMN_FITS = 130;

/** Whether an agent can be asked for more rows here (a chat); elsewhere the count says there are more. */
const askable = inject(WIDGET_HOST, undefined)?.ask !== undefined;

const props = withDefaults(defineProps<Pick<VisualProps, 'table' | 'title' | 'pager' | 'opener'> & Partial<Pick<VisualProps, 'bind' | 'style' | 'facts' | 'palette'>> & {
  /** Rows a page shows at first (the visual's `pageSize`). */
  pageSize?: number;
}>(), {
  pager: undefined, opener: undefined, style: 'table', pageSize: GRID_PAGE,
});

const emit = defineEmits<{ drill: [row: number] }>();
/** A row clicked: its index in the table (the rows shown may be sorted here). */
function clicked(row: readonly unknown[]): void {
  const index = props.table.rows.findIndex((held) => held === row);
  if (index >= 0) { emit('drill', index); }
}

/** Whether a row's click drills into it, as the widget view around it says. */
const drillable = inject(DRILLABLE, undefined);
const drills = computed(() => drillable?.value === true);

/** The cell editor of the widget view around it, when its cells are edited in place. */
const editor = inject(CELL_EDITOR, undefined);
const inputOf = (column: ResultColumn) => editor?.input(column);
/** An editable cell's value as its input holds it. */
function entry(row: readonly Json[], index: number): string {
  const value = editor?.value(row, index);
  return value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
}
function typed(row: readonly Json[], index: number, event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) { editor?.stage(row, index, target.type === 'checkbox' ? target.checked : target.value); }
}

const root = ref<HTMLElement | null>(null);
const width = useWidth(root);
/** The columns drawn, with their index in the row: the bound ones, else every one. */
const columns = computed(() => {
  const all = props.table.columns.map((column, index) => ({ column, index }));
  const names = props.bind?.['columns'];
  return names === undefined ? all : names.flatMap((name) => all.filter((c) => c.column.name === name));
});
/** The style drawn: cards on a frame narrower than a phone's and than its columns need, whatever was picked. */
const shown = computed(() => (width.value > 0 && width.value < Math.min(PHONE_WIDTH, columns.value.length * COLUMN_FITS) ? 'cards' : props.style));

const strip = ref<HTMLElement | null>(null);
/** The sides with columns beyond them; any at all pins the first column. */
const edges = useMoreEdges(strip);

/** The sort picked here (rows held), over the sort the table was read with. */
const picked = ref<ResultSort | undefined>(undefined);
const page = ref(0);
const size = ref(props.pageSize);
const sizes = computed((): SelectOption<string>[] => [...new Set([props.pageSize, ...PAGE_SIZES])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: `${String(n)} a page` })));
const sizeText = computed({ get: () => String(size.value), set: (text: string) => { size.value = Number(text); page.value = 0; } });
/** A buffered pager's table grows from the rows held: keep the page and sort while it does. */
const buffered = computed(() => props.pager?.buffered === true);
/** Next was pressed past the rows held: move on once the buffer grows. */
let wantsNext = false;
watch(() => props.table, (next, before) => {
  if (buffered.value && next.rows.length >= before.rows.length && next.columns === before.columns) {
    if (wantsNext && next.rows.length > before.rows.length) { page.value++; }
    wantsNext = false;
    return;
  }
  wantsNext = false;
  picked.value = undefined;
  page.value = 0;
});

const complete = computed(() => isComplete(props.table));
const sort = computed(() => picked.value ?? props.table.sort[0]);
const rows = computed(() => (picked.value === undefined ? props.table.rows : sortRows(props.table, picked.value)));
const window = computed(() => gridWindow(props.table, rows.value, page.value, size.value));
const label = computed(() => windowLabel(window.value, props.table.truncated));

function sortBy(column: string): void {
  const next = nextSort(sort.value, column);
  const sorter = props.pager?.sort;
  if (sorter !== undefined) { sorter(next); return; }
  if (!complete.value && props.pager !== undefined && !buffered.value) {
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
  if (window.value.canNext) { page.value++; return; }
  if (window.value.fetchNext !== undefined && props.pager !== undefined) { wantsNext = buffered.value; props.pager(window.value.fetchNext); }
}

const hasPrev = computed(() => window.value.canPrev || (window.value.fetchPrev !== undefined && props.pager !== undefined));
const hasNext = computed(() => window.value.canNext || (window.value.fetchNext !== undefined && props.pager !== undefined));
const ariaSort = (column: string): 'ascending' | 'descending' | 'none' => (sort.value?.column !== column ? 'none' : sort.value.dir === 'asc' ? 'ascending' : 'descending');
</script>

<template>
  <div ref="root" class="grid" :class="[shown, { drills }]" data-testid="result-grid" :data-style="shown">
    <ul v-if="shown === 'cards'" class="cards" :aria-label="title">
      <li v-for="(row, r) in window.rows" :key="window.from + r" class="card" data-testid="result-card" @click="clicked(row)">
        <dl>
          <div v-for="{ column, index } in columns" :key="column.name" class="field">
            <dt>{{ column.label ?? column.name }}</dt>
            <dd :class="{ num: isNumeric(column), changed: editor?.changed(row, index) }">
              <input
                v-if="inputOf(column) === 'checkbox'" type="checkbox" class="edit-check" :checked="editor?.value(row, index) === true" :aria-label="column.label ?? column.name"
                data-testid="result-cell-edit" :data-column="column.name" @click.stop @change="typed(row, index, $event)"
              >
              <input
                v-else-if="inputOf(column)" :type="inputOf(column)" class="edit" :value="entry(row, index)" :aria-label="column.label ?? column.name"
                data-testid="result-cell-edit" :data-column="column.name" @click.stop @change="typed(row, index, $event)"
              >
              <span v-else-if="cellText(row[index], column) === undefined" class="empty">null</span>
              <template v-else>{{ cellText(row[index], column) }}</template>
            </dd>
          </div>
        </dl>
        <UiIconButton v-if="opener?.has(row)" class="card-open" icon="more" :label="opener.label" size="sm" data-testid="result-row-open" @click.stop="opener.open(row)" />
      </li>
      <li v-if="table.rows.length === 0" class="none">No rows.</li>
    </ul>
    <div v-else class="frame">
      <div ref="strip" class="scroll edge-fade" :class="{ pinned: edges !== '' }" :data-more="edges" tabindex="0" role="region" :aria-label="title">
        <table>
          <thead>
            <tr>
              <th v-for="{ column } in columns" :key="column.name" scope="col" :class="{ num: isNumeric(column) }" :aria-sort="ariaSort(column.name)">
                <button type="button" class="sort" :title="`Sort by ${column.label ?? column.name}`" @click="sortBy(column.name)">
                  <span class="name">{{ column.label ?? column.name }}</span>
                  <span class="kind">{{ column.kind }}</span>
                  <UiIcon v-if="sort?.column === column.name" :name="sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'" :size="12" />
                </button>
              </th>
              <th v-if="opener" class="row-tools" scope="col"><span class="sr-only">{{ opener.label }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, r) in window.rows" :key="window.from + r" data-testid="result-row" @click="clicked(row)">
              <td
                v-for="{ column, index } in columns" :key="column.name"
                :class="{ num: isNumeric(column), mono: column.kind === 'json' || column.kind === 'uuid', editing: inputOf(column) !== undefined, changed: editor?.changed(row, index) }"
              >
                <input
                  v-if="inputOf(column) === 'checkbox'" type="checkbox" class="edit-check" :checked="editor?.value(row, index) === true" :aria-label="column.label ?? column.name"
                  data-testid="result-cell-edit" :data-column="column.name" @click.stop @change="typed(row, index, $event)"
                >
                <input
                  v-else-if="inputOf(column)" :type="inputOf(column)" class="edit" :class="{ num: isNumeric(column) }" :value="entry(row, index)" :aria-label="column.label ?? column.name"
                  data-testid="result-cell-edit" :data-column="column.name" @click.stop @change="typed(row, index, $event)"
                >
                <span v-else-if="cellText(row[index], column) === undefined" class="empty">null</span>
                <span v-else class="cell" :title="cellText(row[index], column)">{{ cellText(row[index], column) }}</span>
              </td>
              <td v-if="opener" class="row-tools" @click.stop>
                <UiIconButton v-if="opener.has(row)" icon="more" :label="opener.label" size="sm" data-testid="result-row-open" @click="opener.open(row)" />
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="table.rows.length === 0" class="none">No rows.</p>
      </div>
    </div>
    <footer v-if="hasPrev || hasNext || !complete || buffered" class="foot">
      <span class="count" data-testid="result-count">{{ label }}</span>
      <span v-if="askable && !complete && pager === undefined && table.truncated" class="hint">Ask for more to see the rest.</span>
      <UiSelect v-if="table.rows.length > PAGE_SIZES[0]" v-model="sizeText" class="size" :options="sizes" label="Rows a page" hide-label size="sm" data-testid="result-page-size" />
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
.compact td { padding: 2px var(--space-2); }
.compact .sort { padding: var(--space-1) var(--space-2); }
tbody tr:last-child td { border-bottom: 0; }
.drills tbody tr, .drills .card { cursor: pointer; }
tbody tr:hover td { background: var(--surface-2); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-family: var(--mono); font-size: var(--text-xs); }
/* wide: the first column stays put while the rest scroll under it, at most 40% of the frame */
.pinned th:first-child, .pinned td:first-child { position: sticky; left: 0; z-index: 1; box-shadow: inset -1px 0 0 var(--border); }
.scroll.pinned { --fade-start: 0px; }
.pinned td:first-child { background: var(--surface); }
.pinned tbody tr:hover td:first-child { background: var(--surface-2); }
.pinned td:first-child .cell, .pinned th:first-child .name { max-width: 40cqi; overflow: hidden; text-overflow: ellipsis; }
.row-tools { position: sticky; right: 0; z-index: 1; width: 1%; padding: 2px var(--space-1); background: var(--surface); text-align: right; box-shadow: inset 1px 0 0 var(--border); }
th.row-tools { background: var(--surface-2); }
td.row-tools { vertical-align: middle; }
tbody tr:hover td.row-tools { background: var(--surface-2); }
.cell { display: block; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: var(--text-faint); font-style: italic; }
/* an editable cell: a quiet input that shows itself on hover and focus; a staged change keeps an accent edge */
td.editing { padding: 2px var(--space-1); }
.edit {
  width: 100%; min-width: 6rem; max-width: 320px; padding: 3px var(--space-2); border: 1px solid transparent; border-radius: var(--radius-sm);
  background: transparent; color: var(--text); font: inherit;
}
.edit.num { text-align: right; font-variant-numeric: tabular-nums; }
.edit:hover { border-color: var(--border); }
.edit:focus { outline: none; border-color: var(--accent); background: var(--surface); box-shadow: var(--ring); }
.edit-check { width: 16px; height: 16px; margin: 4px var(--space-2); accent-color: var(--accent); }
td.changed, dd.changed { box-shadow: inset 2px 0 0 var(--accent); }
td.changed .edit, dd.changed .edit { background: color-mix(in oklab, var(--accent) 10%, transparent); }
.field:has(.edit) { align-items: center; }
.field dd .edit { min-width: 0; max-width: none; padding: 1px var(--space-1); }
.none { margin: 0; padding: var(--space-3); color: var(--text-dim); font-size: var(--text-sm); }
.cards { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.card { display: flex; align-items: flex-start; gap: var(--space-2); min-width: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
.card dl { display: grid; flex: 1; gap: 2px; min-width: 0; margin: 0; font-size: var(--text-sm); }
.field { display: grid; grid-template-columns: minmax(72px, 35%) minmax(0, 1fr); gap: var(--space-2); }
.field dt { overflow: hidden; color: var(--text-dim); text-overflow: ellipsis; white-space: nowrap; }
.field dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.field dd.num { text-align: left; }
.card-open { flex: none; }
.foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); color: var(--text-dim); font-size: var(--text-xs); }
.count { font-variant-numeric: tabular-nums; }
.hint { color: var(--text-faint); }
.pages { display: flex; gap: 2px; margin-left: auto; }
.size { width: auto; }
</style>
