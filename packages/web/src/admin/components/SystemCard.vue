<script setup lang="ts">
/**
 * A system in the list: its name and what it does, where it is (and its process, when the hub runs it), how many fns
 * it adds, what needs the admin (config, a crash), what is switched off, and when it was last heard from. The whole
 * card opens the system.
 */
import type { SystemView } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { UiBadge, UiIcon, fullTime, relativeTime } from '../../ui/index.ts';
import { INSTALLED_STATUS_LOOK, SYSTEM_STATUS_LOOK } from '../logic/systems.ts';
import StatusBadge from './StatusBadge.vue';

defineProps<{ system: SystemView; now: number; to: RouteLocationRaw }>();
</script>

<template>
  <RouterLink :to="to" class="system-card" :data-testid="`system-${system.name}`">
    <span class="mark" aria-hidden="true"><UiIcon name="server" :size="18" /></span>
    <span class="main">
      <span class="top">
        <span class="name">{{ system.name }}</span>
        <span class="version">v{{ system.version }}</span>
      </span>
      <span class="description">{{ system.description }}</span>
      <span class="chips">
        <StatusBadge :look="SYSTEM_STATUS_LOOK[system.status]" />
        <StatusBadge v-if="system.installed" :look="INSTALLED_STATUS_LOOK[system.installed.status]" />
        <UiBadge v-if="system.needsConfig && system.status !== 'needs-config'" tone="warn">Needs config</UiBadge>
        <UiBadge v-if="!system.enabled.functions">Functions off</UiBadge>
        <UiBadge v-if="!system.enabled.renderers">Renderers off</UiBadge>
      </span>
    </span>
    <span class="side">
      <span class="fns">{{ system.fns }} {{ system.fns === 1 ? 'fn' : 'fns' }}</span>
      <time v-if="system.lastSeenAt !== undefined" class="seen" :datetime="new Date(system.lastSeenAt).toISOString()" :title="fullTime(system.lastSeenAt)">
        {{ system.status === 'connected' ? 'Online now' : `Seen ${relativeTime(system.lastSeenAt, now)}` }}
      </time>
    </span>
    <UiIcon name="chevron-right" :size="16" class="chevron" />
  </RouterLink>
</template>

<style scoped>
.system-card {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3) var(--space-4);
  padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm);
  color: var(--text); text-decoration: none;
  transition: border-color var(--fast) var(--ease), box-shadow var(--medium) var(--ease), transform var(--medium) var(--ease);
}
.system-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow); text-decoration: none; transform: translateY(-1px); }
.system-card:focus-visible { outline: none; box-shadow: var(--ring); }
.mark { display: grid; place-items: center; width: 40px; height: 40px; border-radius: var(--radius); background: var(--accent-soft); color: var(--accent); }
.main { display: grid; gap: var(--space-1); min-width: 0; }
.top { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.name { font-weight: var(--weight-strong); overflow-wrap: anywhere; }
.version { color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap; }
.description { display: -webkit-box; overflow: hidden; color: var(--text-dim); font-size: var(--text-sm); -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-1); }
.side { display: grid; justify-items: end; gap: 2px; font-size: var(--text-sm); white-space: nowrap; }
.fns { font-weight: var(--weight-medium); }
.seen { color: var(--text-faint); font-size: var(--text-xs); }
.chevron { color: var(--text-faint); }
@media (max-width: 559.98px) {
  .system-card { grid-template-columns: auto minmax(0, 1fr) auto; }
  .side { grid-column: 2; grid-auto-flow: column; justify-content: start; gap: var(--space-2); }
  .chevron { grid-row: 1; grid-column: 3; }
}
</style>
