<script setup lang="ts">
/**
 * One node of a turn's fn tree and, nested under it, the fns it called; LLM calls are its leaves. Live statuses win over
 * the tree's snapshot. The fn is a `FnPill` (it opens the fn modal); the rest of the row opens the run.
 */
import type { LlmInteractionId, RunId, RunStatus, TreeNode } from '@harness/core';
import { computed, ref } from 'vue';
import FnPill from '../../fns/components/FnPill.vue';
import { UiIcon } from '../../ui/index.ts';
import { formatCost, formatDuration } from '../logic/format.ts';
import { fnLabel } from '../logic/labels.ts';
import RunDot from './RunDot.vue';

const props = withDefaults(defineProps<{ node: TreeNode; live: (run: RunId) => RunStatus | undefined; depth?: number }>(), { depth: 0 });
const emit = defineEmits<{ run: [id: RunId]; llm: [id: LlmInteractionId] }>();

const open = ref(true);
const status = computed(() => props.live(props.node.run.id) ?? props.node.run.status);
const took = computed(() => (props.node.run.startedAt !== undefined && props.node.run.endedAt !== undefined ? formatDuration(props.node.run.endedAt - props.node.run.startedAt) : ''));
const hasChildren = computed(() => props.node.children.length > 0 || props.node.llmCalls.length > 0);
</script>

<template>
  <li class="branch" data-testid="tree-node" :data-run="node.run.id">
    <div class="node">
      <button v-if="hasChildren" type="button" class="fold" :aria-expanded="open ? 'true' : 'false'" :aria-label="open ? 'Fold' : 'Unfold'" @click="open = !open">
        <UiIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />
      </button>
      <span v-else class="fold-space" />
      <RunDot :status="status" class="dot" />
      <FnPill :name="node.run.fn" class="fn" />
      <button type="button" class="run" :aria-label="`Open the run of ${fnLabel(node.run.fn)}`" data-testid="tree-run" @click="emit('run', node.run.id)">
        <span class="stats">
          <span v-if="took !== ''">{{ took }}</span>
          <span>{{ formatCost(node.run.totalCost) }}</span>
        </span>
        <UiIcon name="chevron-right" :size="13" class="go" />
      </button>
    </div>
    <ul v-if="open && hasChildren" class="children">
      <li v-for="call in node.llmCalls" :key="call.id" class="llm">
        <button type="button" class="llm-button" data-testid="tree-llm" @click="emit('llm', call.id)">
          <UiIcon name="sparkles" :size="13" />
          <span class="label">{{ call.model }}</span>
          <span class="stats">{{ call.status }} · {{ formatCost(call.cost) }}</span>
        </button>
      </li>
      <TreeBranch v-for="child in node.children" :key="child.run.id" :node="child" :live="live" :depth="depth + 1" @run="emit('run', $event)" @llm="emit('llm', $event)" />
    </ul>
  </li>
</template>

<style scoped>
.branch { list-style: none; min-width: 0; }
.node { display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.fold, .fold-space { display: grid; place-items: center; flex: none; width: 24px; height: 24px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-faint); }
.fold:hover { background: var(--surface-2); }
.run, .llm-button {
  display: flex; align-items: center; gap: var(--space-2); flex: 1; min-width: 0; min-height: 36px; padding: 0 var(--space-2);
  border: 0; border-radius: var(--radius); background: transparent; color: var(--text); text-align: left; font-size: var(--text-sm);
}
.run:hover, .llm-button:hover { background: var(--surface-2); }
.run:focus-visible, .llm-button:focus-visible { outline: none; box-shadow: var(--ring); }
.label { flex: none; font-weight: var(--weight-medium); }
.dot { flex: none; margin-left: var(--space-1); }
.fn { flex: 0 1 auto; min-width: 0; }
.run { justify-content: flex-end; }
.go { flex: none; color: var(--text-faint); opacity: 0; transition: opacity var(--fast) var(--ease); }
.run:hover .go, .run:focus-visible .go { opacity: 1; }
.stats { display: flex; gap: var(--space-2); flex: none; color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.children { display: grid; gap: 2px; margin: 0 0 0 11px; padding: 0 0 0 var(--space-3); border-left: 1px solid var(--border); }
.llm { list-style: none; }
.llm-button { color: var(--text-dim); }
.llm-button .label { font-weight: normal; font-family: var(--mono); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; flex: 1; }
</style>
