<script setup lang="ts">
/**
 * A context item's markdown before and after, rendered: blocks kept as they were read plainly, a block added or
 * removed is rendered in green or struck through in red, and a changed block reads as its word diff. Long runs of kept
 * blocks fold to a line, so the change is what shows.
 */
import { computed } from 'vue';
import { UiMarkdown } from '../../../ui/index.ts';
import { blockDiff, type BlockDiff } from '../../logic/review.ts';
import ProseDiff from './ProseDiff.vue';

const props = defineProps<{ before: string | undefined; after: string | undefined }>();

/** Kept blocks around a change that stay shown; longer runs fold. */
const CONTEXT = 1;
type Shown = { readonly kind: 'block'; readonly block: BlockDiff; readonly at: number } | { readonly kind: 'fold'; readonly count: number; readonly at: number };
const shown = computed<readonly Shown[]>(() => {
  const blocks = blockDiff(props.before ?? '', props.after ?? '');
  const near = (at: number): boolean => blocks.slice(Math.max(0, at - CONTEXT), at + CONTEXT + 1).some((block) => block.kind !== 'same');
  const out: Shown[] = [];
  blocks.forEach((block, at) => {
    if (block.kind !== 'same' || near(at)) { out.push({ kind: 'block', block, at }); return; }
    const last = out.at(-1);
    if (last?.kind === 'fold') { out[out.length - 1] = { ...last, count: last.count + 1 }; } else { out.push({ kind: 'fold', count: 1, at }); }
  });
  return out;
});
</script>

<template>
  <div class="md-diff" data-testid="markdown-diff">
    <template v-for="item in shown" :key="item.at">
      <p v-if="item.kind === 'fold'" class="fold">{{ item.count }} unchanged {{ item.count === 1 ? 'block' : 'blocks' }}</p>
      <div v-else class="block" :class="item.block.kind" :data-block="item.block.kind">
        <ProseDiff v-if="item.block.kind === 'change'" :words="item.block.words" />
        <UiMarkdown v-else :source="item.block.text" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.md-diff { display: grid; gap: var(--space-1); min-width: 0; }
.block { padding: var(--space-1) var(--space-3); border-left: 3px solid transparent; border-radius: var(--radius-sm); }
.block.add { border-left-color: var(--ok); background: var(--ok-soft); }
.block.remove { border-left-color: var(--danger); background: var(--danger-soft); opacity: 0.8; }
.block.remove :deep(.ui-markdown) { text-decoration: line-through; text-decoration-thickness: 1px; }
.block.change { border-left-color: var(--accent); background: var(--surface-2); }
.fold { margin: 0; padding: 0 var(--space-3); color: var(--text-faint); font-size: var(--text-xs); }
</style>
