<script setup lang="ts">
/**
 * JSON (and JSON Lines) as a tree: branches open and close (or all at once to a depth), large ones page their
 * entries, a search opens the way to every match and lights it, and each row copies its path or its value. Text that
 * isn't JSON says why and shows as text.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { copyText, UiBanner, UiButton, UiIconButton, UiInput } from '../../ui/index.ts';
import { PAGE, parseJson, pathsTo, treeRows, valueAt, type JsonRow } from '../logic/json-tree.ts';

const props = withDefaults(defineProps<{ text: string; lines?: boolean; compact?: boolean }>(), { lines: false, compact: false });
const emit = defineEmits<{ copied: [what: string] }>();

const parsed = computed(() => parseJson(props.text, props.lines));
const open = shallowRef<ReadonlySet<string>>(new Set(['']));
const shown = shallowRef<ReadonlyMap<string, number>>(new Map());
const search = ref('');
watch(() => props.text, () => { open.value = new Set(['']); shown.value = new Map(); });

const rows = computed<readonly JsonRow[]>(() => (parsed.value.ok ? treeRows(parsed.value.value, { open: open.value, shown: shown.value, search: search.value }) : []));
const visible = computed(() => (props.compact ? rows.value.slice(0, 12) : rows.value));

function toggle(path: string): void {
  const next = new Set(open.value);
  if (next.has(path)) { next.delete(path); } else { next.add(path); }
  open.value = next;
}
function more(path: string): void {
  shown.value = new Map([...shown.value, [path, (shown.value.get(path) ?? PAGE) + PAGE]]);
}
/** Open every branch down to `depth` levels. */
function openTo(depth: number): void {
  if (parsed.value.ok) { open.value = pathsTo(parsed.value.value, depth); }
}
async function copy(row: Extract<JsonRow, { kind: 'value' }>, what: 'path' | 'value'): Promise<void> {
  if (!parsed.value.ok) { return; }
  const text = what === 'path' ? row.path || '$' : JSON.stringify(valueAt(parsed.value.value, row.path) ?? null, null, 2);
  if (await copyText(text)) { emit('copied', what === 'path' ? 'Path copied' : 'Value copied'); }
}
</script>

<template>
  <div class="json-tree" :class="{ compact }" data-testid="json-view">
    <UiBanner v-if="!parsed.ok" tone="warn">This isn't JSON: {{ parsed.problem }}</UiBanner>
    <template v-else>
      <div v-if="!compact" class="tools">
        <UiInput v-model="search" type="search" icon="search" label="Search keys and values" hide-label placeholder="Search keys and values" size="sm" clearable />
        <UiButton size="sm" variant="ghost" @click="openTo(3)">Open 3 levels</UiButton>
        <UiButton size="sm" variant="ghost" @click="open = new Set([''])">Close all</UiButton>
      </div>
      <ul class="rows" role="tree" aria-label="JSON">
        <li
          v-for="row in visible" :key="`${row.kind}:${row.path}`" class="row" :class="[row.kind === 'value' ? `t-${row.type}` : 'more-row', { match: row.kind === 'value' && row.match }]"
          :style="{ paddingLeft: `${row.depth * 16 + 4}px` }" role="treeitem" :aria-expanded="row.kind === 'value' && row.branch ? row.open : undefined"
        >
          <template v-if="row.kind === 'value'">
            <button v-if="row.branch" type="button" class="twist" :aria-label="row.open ? `Close ${row.key || 'root'}` : `Open ${row.key || 'root'}`" @click="toggle(row.path)">{{ row.open ? '▾' : '▸' }}</button>
            <span v-else class="twist" aria-hidden="true"></span>
            <span v-if="row.key !== ''" class="key">{{ row.key }}</span><span v-if="row.key !== ''" class="colon">:</span>
            <span class="value">{{ row.preview }}</span>
            <span v-if="!compact" class="row-tools">
              <UiIconButton icon="link" size="sm" :label="`Copy the path of ${row.key || 'root'}`" @click="copy(row, 'path')" />
              <UiIconButton icon="copy" size="sm" :label="`Copy the value of ${row.key || 'root'}`" @click="copy(row, 'value')" />
            </span>
          </template>
          <button v-else type="button" class="show-more" @click="more(row.path)">Show {{ Math.min(PAGE, row.hidden) }} more of {{ row.hidden.toLocaleString() }}</button>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.json-tree { display: grid; gap: var(--space-2); min-width: 0; }
.tools { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
.tools > :first-child { flex: 1 1 200px; max-width: 320px; }
.rows { margin: 0; padding: var(--space-2) 0; list-style: none; border: 1px solid var(--border); border-radius: var(--radius); background: var(--code-bg); font: 13px/1.7 var(--mono); max-height: min(70dvh, 720px); overflow: auto; }
.compact .rows { max-height: 220px; }
.row { display: flex; align-items: center; gap: 4px; min-width: 0; padding-right: var(--space-2); }
.row:hover { background: var(--surface-2); }
.row.match { background: color-mix(in oklab, var(--accent) 14%, transparent); }
.twist { width: 16px; flex: none; padding: 0; border: 0; background: none; color: var(--text-faint); font: inherit; cursor: pointer; }
.twist:focus-visible, .show-more:focus-visible { outline: none; box-shadow: var(--ring); border-radius: 4px; }
.key { color: var(--accent); white-space: nowrap; }
.colon { color: var(--text-faint); }
.value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.t-string .value { color: light-dark(oklch(0.5 0.13 150), oklch(0.78 0.12 150)); }
.t-number .value, .t-boolean .value { color: light-dark(oklch(0.55 0.15 50), oklch(0.8 0.12 60)); }
.t-null .value, .t-object .value, .t-array .value { color: var(--text-faint); }
.row-tools { display: flex; gap: 2px; opacity: 0; }
.row:hover .row-tools, .row:focus-within .row-tools { opacity: 1; }
@media (hover: none) { .row-tools { opacity: 1; } }
.show-more { padding: 0; border: 0; background: none; color: var(--accent); font: inherit; font-size: var(--text-xs); cursor: pointer; }
</style>
