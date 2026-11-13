<script setup lang="ts">
/**
 * A session's tasks and workflows with their progress, as a tree: each task its kind, name, status and latest progress
 * line, the tasks it started under it. A subagent's own transcript opens from its row (`transcriptOf`); the one open is
 * marked.
 */
import type { RouteLocationRaw } from 'vue-router';
import StatusBadge from '../../admin/components/StatusBadge.vue';
import { UiIcon } from '../../ui/index.ts';
import { TASK_ICON, TASK_LOOK, type TaskNode } from '../logic/claude.ts';

defineProps<{
  nodes: readonly TaskNode[];
  /** The link to a subagent's transcript. */
  transcriptOf: (task: string) => RouteLocationRaw;
  /** The task whose transcript is open. */
  open?: string | undefined;
  depth?: number | undefined;
}>();
</script>

<template>
  <ul class="tasks" :class="{ nested: (depth ?? 0) > 0 }" data-testid="claude-tasks">
    <li v-for="node in nodes" :key="node.task.id" :data-task="node.task.id">
      <div class="row" :class="{ open: open === node.task.id }">
        <span class="kind" :title="node.task.kind"><UiIcon :name="TASK_ICON[node.task.kind]" :size="14" /></span>
        <span class="main">
          <span class="top">
            <span class="name">{{ node.task.name || node.task.description }}</span>
            <StatusBadge :look="TASK_LOOK[node.task.status]" />
          </span>
          <span v-if="node.task.name && node.task.description" class="description">{{ node.task.description }}</span>
          <span v-if="node.task.progress" class="progress" data-testid="task-progress">{{ node.task.progress }}</span>
          <RouterLink v-if="node.task.kind === 'agent'" class="link" :to="transcriptOf(node.task.id)" data-testid="task-transcript">
            {{ open === node.task.id ? 'Showing its transcript' : 'Its transcript' }}
          </RouterLink>
        </span>
      </div>
      <ClaudeTaskList v-if="node.children.length > 0" :nodes="node.children" :transcript-of="transcriptOf" :open="open" :depth="(depth ?? 0) + 1" />
    </li>
  </ul>
</template>

<style scoped>
.tasks { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; min-width: 0; }
.tasks.nested { margin-top: var(--space-2); padding-left: var(--space-4); border-left: 1px solid var(--border); }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2); min-width: 0; padding: var(--space-1); border-radius: var(--radius); }
.row.open { background: var(--accent-soft); }
.kind { display: grid; place-items: center; width: 24px; height: 24px; border-radius: var(--radius); background: var(--surface-2); color: var(--text-dim); }
.main { display: grid; gap: 2px; min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); }
.name { font-size: var(--text-sm); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.description, .progress { color: var(--text-dim); font-size: var(--text-xs); overflow-wrap: anywhere; }
.progress { font-family: var(--mono); }
.link { width: fit-content; font-size: var(--text-xs); }
</style>
