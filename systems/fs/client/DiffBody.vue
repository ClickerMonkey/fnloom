<script setup lang="ts">
/**
 * The lines of a diff, drawn: line numbers on both sides, added and removed lines tinted, unchanged runs folded (click
 * to open), gaps a unified diff leaves out marked, and only the first lines until asked for all. Long lines wrap, so
 * nothing runs off a phone. Shared by the diff attachment and a command's changes.
 */
import { computed, reactive, ref } from 'vue';
import type { DiffBlock, DiffLine } from './diff.ts';

const props = defineProps<{
  blocks: readonly DiffBlock[];
  /** What the table is of, for screen readers: "Changes to src/a.ts". */
  label: string;
}>();

/** Lines drawn before "Show the whole diff". */
const FIRST_LINES = 300;

type Row =
  | { type: 'line'; line: DiffLine; key: string }
  | { type: 'fold'; index: number; count: number; key: string }
  | { type: 'gap'; count: number; key: string };

const opened = reactive(new Set<number>());
const whole = ref(false);

/** The rows to draw: lines, folds not opened yet and gaps, cut to the first lines until asked for all. */
const rows = computed(() => {
  const out: Row[] = [];
  props.blocks.forEach((block, index) => {
    if (block.kind === 'gap') { out.push({ type: 'gap', count: block.count, key: `g${index}` }); return; }
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
const lines = (count: number) => `${count} unchanged ${count === 1 ? 'line' : 'lines'}`;
</script>

<template>
  <div class="scroll" role="table" :aria-label="label">
    <div class="body" role="rowgroup">
      <template v-for="row in shown" :key="row.key">
        <button v-if="row.type === 'fold'" type="button" class="fold" @click="opened.add(row.index)">⋯ {{ lines(row.count) }}</button>
        <div v-else-if="row.type === 'gap'" class="gap" role="row"><span role="cell">⋯ {{ lines(row.count) }}</span></div>
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
</template>

<style scoped>
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
.fold, .all, .gap {
  display: block;
  width: 100%;
  padding: 4px var(--space-3);
  border: 0;
  background: var(--surface-2);
  font-size: var(--text-xs);
  text-align: left;
}
.fold, .all { color: var(--accent); cursor: pointer; transition: background var(--fast) var(--ease); }
.gap { grid-column: 1 / -1; color: var(--text-dim); }
.fold { grid-column: 1 / -1; }
.fold:hover, .all:hover { background: var(--accent-soft); }
.all { border-top: 1px solid var(--border); text-align: center; }
</style>
