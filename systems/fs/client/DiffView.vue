<script setup lang="ts">
/**
 * The diff attachment: a file's change, from its text before and after, with the count of added and removed lines.
 * The lines are drawn by `DiffBody` (folds, line numbers, wrapping).
 */
import type { AttachmentViewOf } from '@harness/sdk';
import { computed } from 'vue';
import type { fs } from '../shared/index.ts';
import DiffBody from './DiffBody.vue';
import { diffBlocks, diffLines, diffStats } from './diff.ts';

const view = defineProps<AttachmentViewOf<typeof fs, 'diff'>>();

/** Unchanged lines kept around each change. */
const CONTEXT = 3;

const lines = computed(() => diffLines(view.data.before, view.data.after));
const stats = computed(() => diffStats(lines.value));
const blocks = computed(() => diffBlocks(lines.value, CONTEXT));
const kind = computed(() => (view.data.before === '' ? 'New file' : view.data.after === '' ? 'Deleted' : undefined));
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
    <DiffBody v-else :blocks="blocks" :label="`Changes to ${view.data.path}`" />
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
.empty { padding: var(--space-3); color: var(--text-dim); font-size: var(--text-sm); }
</style>
