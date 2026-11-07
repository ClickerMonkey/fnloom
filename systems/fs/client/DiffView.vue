<script setup lang="ts">
/**
 * The diff attachment: a file's change as a unified diff with line numbers, unchanged runs folded (click to open),
 * and the count of added and removed lines. Long lines wrap inside the card, so nothing runs off a phone.
 */
import type { AttachmentViewOf } from '@harness/sdk';
import { computed, reactive, ref } from 'vue';
import type { fs } from '../shared/index.ts';
import { diffBlocks, diffLines, diffStats, type DiffLine } from './diff.ts';

const view = defineProps<AttachmentViewOf<typeof fs, 'diff'>>();

/** Unchanged lines kept around each change. */
const CONTEXT = 3;
/** Lines drawn before "Show the whole diff". */
const FIRST_LINES = 300;

const lines = computed(() => diffLines(view.data.before, view.data.after));
const stats = computed(() => diffStats(lines.value));
const blocks = computed(() => diffBlocks(lines.value, CONTEXT));
const opened = reactive(new Set<number>());
const whole = ref(false);
const kind = computed(() => (view.data.before === '' ? 'New file' : view.data.after === '' ? 'Deleted' : undefined));

/** The rows to draw: lines, and folds not opened yet, cut to the first lines until asked for all. */
const rows = computed(() => {
  const out: Array<{ type: 'line'; line: DiffLine; key: string } | { type: 'fold'; index: number; count: number; key: string }> = [];
  blocks.value.forEach((block, index) => {
    if (block.kind === 'fold' && !opened.has(index)) {
      out.push({ type: 'fold', index, count: block.lines.length, key: `f${index}` });
      return;
    }
    block.lines.forEach((line, i) => { out.push({ type: 'line', line, key: `${index}:${i}` }); });
  });
  return out;
});
const shown = computed(() => (whole.value ? rows.value : rows.value.slice(0, FIRST_LINES)));
const cut = computed(() => rows.value.length - shown.value.length);
const sign = (line: DiffLine) => (line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ');
</script>

<template>
  <figure class="diff">
    <figcaption class="head">
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5L12.5 5v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z" /><path d="M9 1.5V5h3.5" /></svg>
      <span class="title">{{ view.title }}</span>
      <span v-if="kind" class="kind">{{ kind }}</span>
      <span class="stats"><span class="plus">+{{ stats.added }}</span><span class="minus">−{{ stats.removed }}</span></span>
      <span class="path" :title="view.data.path">{{ view.data.path }}</span>
    </figcaption>
    <div v-if="lines.length === 0" class="empty">The file is empty.</div>
    <div v-else class="scroll" role="table" :aria-label="`Changes to ${view.data.path}`">
      <div class="body" role="rowgroup">
        <template v-for="row in shown" :key="row.key">
          <button v-if="row.type === 'fold'" type="button" class="fold" @click="opened.add(row.index)">
            ⋯ {{ row.count }} unchanged {{ row.count === 1 ? 'line' : 'lines' }}
          </button>
          <div v-else class="line" :class="row.line.kind" role="row">
            <span class="num" role="cell">{{ row.line.kind === 'added' ? '' : row.line.old }}</span>
            <span class="num" role="cell">{{ row.line.kind === 'removed' ? '' : row.line.new }}</span>
            <span class="sign" role="cell" aria-hidden="true">{{ sign(row.line) }}</span>
            <span class="text" role="cell">{{ row.line.text || ' ' }}</span>
          </div>
        </template>
      </div>
    </div>
    <button v-if="cut > 0" type="button" class="all" @click="whole = true">Show the whole diff ({{ cut }} more lines)</button>
  </figure>
</template>

<style scoped>
.diff {
  margin: 0;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  font-size: var(--text-sm);
}
.icon { width: 15px; height: 15px; flex: none; fill: none; stroke: var(--text-dim); stroke-width: 1.3; stroke-linejoin: round; }
.title { font-weight: var(--weight-strong); }
.kind { padding: 0 6px; border-radius: var(--radius-full); background: var(--surface-2); color: var(--text-dim); font-size: var(--text-xs); line-height: 18px; }
.stats { display: inline-flex; gap: var(--space-1); font: var(--text-xs)/1 var(--mono); }
.plus { color: var(--ok); }
.minus { color: var(--danger); }
.path {
  flex: 1 1 100%;
  min-width: 0;
  color: var(--text-dim);
  font: var(--text-xs)/1.4 var(--mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.scroll { max-height: 560px; overflow-y: auto; overscroll-behavior: contain; }
.body {
  display: grid;
  grid-template-columns: auto auto auto minmax(0, 1fr);
  font: var(--text-xs)/1.6 var(--mono);
}
.line { display: contents; }
.line > span { padding: 0 var(--space-2); white-space: pre; }
.line > .text { white-space: pre-wrap; overflow-wrap: anywhere; }
.num { text-align: right; color: var(--text-dim); user-select: none; opacity: 0.7; }
.line > .sign { padding: 0 4px 0 0; user-select: none; }
.text { tab-size: 4; }
.added > span { background: var(--ok-soft); }
.added > .sign { color: var(--ok); }
.removed > span { background: var(--danger-soft); }
.removed > .sign { color: var(--danger); }
.fold, .all {
  display: block;
  width: 100%;
  padding: 4px var(--space-3);
  border: 0;
  background: var(--surface-2);
  color: var(--accent);
  font-size: var(--text-xs);
  text-align: left;
  cursor: pointer;
  transition: background var(--fast) var(--ease);
}
.fold { grid-column: 1 / -1; }
.fold:hover, .all:hover { background: var(--accent-soft); }
.all { border-top: 1px solid var(--border); text-align: center; }
.empty { padding: var(--space-3); color: var(--text-dim); font-size: var(--text-sm); }
</style>
