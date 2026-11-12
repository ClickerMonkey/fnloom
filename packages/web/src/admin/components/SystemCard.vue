<script setup lang="ts">
/**
 * A system in the list: its name and what it does, where it is (its process when the hub runs it, its host when
 * another system runs it), how many fns
 * it adds, whether it is still only installed (not live until reviewed: the badge opens its review), what needs the
 * admin (config, a crash), what is switched off, and when it was last heard from while it is away (its status badge
 * is the one sign of presence). The whole card opens the system.
 */
import type { SystemView } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { UiBadge, UiIcon, fullTime, relativeTime } from '../../ui/index.ts';
import { STAGE_LOOK } from '../logic/review.ts';
import { hostText, INSTALLED_STATUS_LOOK, SYSTEM_STATUS_LOOK } from '../logic/systems.ts';
import StatusBadge from './StatusBadge.vue';

defineProps<{ system: SystemView; now: number; to: RouteLocationRaw; review: RouteLocationRaw }>();
</script>

<template>
  <!-- the name's link covers the card; the not-live badge is a link of its own above it (links can't nest) -->
  <div class="system-card" :data-testid="`system-${system.name}`">
    <span class="mark" aria-hidden="true"><UiIcon name="server" :size="18" /></span>
    <span class="main">
      <span class="top">
        <RouterLink :to="to" class="name">{{ system.name }}</RouterLink>
        <span class="version">v{{ system.version }}</span>
      </span>
      <span class="description">{{ system.description }}</span>
      <span class="chips">
        <StatusBadge :look="SYSTEM_STATUS_LOOK[system.status]" />
        <RouterLink v-if="system.stage === 'installed'" :to="review" class="review" title="Review it to go live" data-testid="system-card-installed">
          <StatusBadge :look="STAGE_LOOK.installed" />
        </RouterLink>
        <StatusBadge v-if="system.installed" :look="INSTALLED_STATUS_LOOK[system.installed.status]" />
        <UiBadge v-if="system.host" :title="`Hosted by ${hostText(system.host)}`" data-testid="system-hosted">Hosted by {{ system.host.host.system }}/{{ system.host.host.instance }}</UiBadge>
        <UiBadge v-if="system.needsConfig && system.status !== 'needs-config'" tone="warn">Needs config</UiBadge>
        <UiBadge v-if="!system.enabled.functions">Functions off</UiBadge>
        <UiBadge v-if="!system.enabled.renderers">Renderers off</UiBadge>
      </span>
    </span>
    <span class="side">
      <span class="fns">{{ system.fns }} {{ system.fns === 1 ? 'fn' : 'fns' }}</span>
      <time v-if="system.lastSeenAt !== undefined && system.status !== 'connected'" class="seen" :datetime="new Date(system.lastSeenAt).toISOString()" :title="fullTime(system.lastSeenAt)">
        Seen {{ relativeTime(system.lastSeenAt, now) }}
      </time>
    </span>
    <UiIcon name="chevron-right" :size="16" class="chevron" />
  </div>
</template>

<style scoped>
.system-card {
  position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3) var(--space-4);
  padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm);
  color: var(--text); text-decoration: none;
  transition: border-color var(--fast) var(--ease), box-shadow var(--medium) var(--ease), transform var(--medium) var(--ease);
}
.system-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow); transform: translateY(-1px); }
.system-card:focus-within:has(.name:focus-visible) { box-shadow: var(--ring); }
.name::after { position: absolute; inset: 0; border-radius: inherit; content: ''; }
.name:focus-visible { outline: none; }
.review { position: relative; z-index: 1; display: inline-flex; border-radius: var(--radius-full); text-decoration: none; }
.review:hover { filter: brightness(0.96); text-decoration: none; }
.review:focus-visible { outline: none; box-shadow: var(--ring); }
.mark { display: grid; place-items: center; width: 40px; height: 40px; border-radius: var(--radius); background: var(--accent-soft); color: var(--accent); }
.main { display: grid; gap: var(--space-1); min-width: 0; }
.top { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.name { color: var(--text); font-weight: var(--weight-strong); overflow-wrap: anywhere; text-decoration: none; }
.name:hover { text-decoration: none; }
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
