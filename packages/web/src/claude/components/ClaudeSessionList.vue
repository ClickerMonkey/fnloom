<script setup lang="ts">
/**
 * The fleet as a list: each session its title and status (how many things wait on the person, when some do), where it works (folder
 * and machine), the last thing Claude said, its tasks and when it last changed; each opens its page.
 */
import type { RouteLocationRaw } from 'vue-router';
import StatusBadge from '../../admin/components/StatusBadge.vue';
import { UiIcon, relativeTime } from '../../ui/index.ts';
import { folderName, statusLook, tasksLine, type FleetSession } from '../logic/claude.ts';

defineProps<{
  sessions: readonly FleetSession[];
  /** The page of a session. */
  linkOf: (session: FleetSession) => RouteLocationRaw;
  now: number;
}>();
</script>

<template>
  <ul class="list" data-testid="claude-sessions">
    <li v-for="item in sessions" :key="item.id" :data-session="item.value.session" :data-waiting="item.value.waiting.length">
      <RouterLink class="open" :to="linkOf(item)" data-testid="claude-session-row">
        <span class="mark" aria-hidden="true"><UiIcon name="code" :size="16" /></span>
        <span class="main">
          <span class="top">
            <span class="name">{{ item.value.title || folderName(item.value.folder) }}</span>
            <StatusBadge :look="statusLook(item.value)" />
          </span>
          <span class="where"><code :title="item.value.folder">{{ item.value.folder }}</code><span class="sep">·</span>{{ item.value.instance }}</span>
          <span v-if="item.value.lastText" class="last">{{ item.value.lastText }}</span>
        </span>
        <span class="side">
          <span>{{ relativeTime(item.value.updatedAt, now) }}</span>
          <span v-if="item.value.tasks.length > 0" class="tasks">{{ tasksLine(item.value.tasks) }}</span>
        </span>
      </RouterLink>
    </li>
  </ul>
</template>

<style scoped>
.list { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); list-style: none; overflow: hidden; }
.list > li + li { border-top: 1px solid var(--border); }
.open { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--space-2) var(--space-4); padding: var(--space-3) var(--space-4); color: var(--text); text-decoration: none; }
.open:hover { background: var(--surface-2); text-decoration: none; }
.open:focus-visible { outline: none; box-shadow: inset var(--ring); }
.mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); background: var(--surface-2); color: var(--text-dim); }
.main { display: grid; gap: 2px; min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); }
.name { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.where { display: flex; gap: var(--space-1); min-width: 0; color: var(--text-dim); font-size: var(--text-xs); white-space: nowrap; }
.where code { overflow: hidden; text-overflow: ellipsis; }
.sep { color: var(--text-faint); }
.last { overflow: hidden; color: var(--text-faint); font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.side { display: grid; justify-items: end; gap: 2px; color: var(--text-dim); font-size: var(--text-xs); white-space: nowrap; }
.tasks { color: var(--accent); }
@media (max-width: 559.98px) {
  .open { grid-template-columns: auto minmax(0, 1fr); }
  .side { grid-column: 2; display: flex; justify-content: flex-start; gap: var(--space-2); }
}
</style>
