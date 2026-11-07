<script setup lang="ts">
/** A turn's whole fn tree, live while the turn runs: every run with its status, timing and cost, and LLM calls as leaves. */
import type { LlmInteractionId, RunId, RunStatus, TreeNode } from '@harness/core';
import { UiBanner, UiButton, UiSkeleton } from '../../ui/index.ts';
import { formatCost } from '../logic/format.ts';
import { treeSize } from '../logic/inspect.ts';
import TreeBranch from './TreeBranch.vue';

withDefaults(defineProps<{ tree: TreeNode | undefined; loading: boolean; problem?: string; live: (run: RunId) => RunStatus | undefined }>(), { problem: '' });
const emit = defineEmits<{ run: [id: RunId]; llm: [id: LlmInteractionId]; retry: [] }>();
</script>

<template>
  <div class="tree" data-testid="turn-tree">
    <UiBanner v-if="problem !== ''" tone="danger">
      {{ problem }}
      <template #actions><UiButton size="sm" variant="ghost" @click="emit('retry')">Retry</UiButton></template>
    </UiBanner>
    <UiSkeleton v-if="loading && tree === undefined" shape="lines" :lines="5" />
    <template v-else-if="tree">
      <p class="summary">{{ treeSize(tree) }} run{{ treeSize(tree) === 1 ? '' : 's' }} · {{ formatCost(tree.run.totalCost) }} in all</p>
      <ul class="root"><TreeBranch :node="tree" :live="live" @run="emit('run', $event)" @llm="emit('llm', $event)" /></ul>
    </template>
  </div>
</template>

<style scoped>
.tree { display: grid; gap: var(--space-3); min-width: 0; }
.summary { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.root { margin: 0; padding: 0; }
</style>
