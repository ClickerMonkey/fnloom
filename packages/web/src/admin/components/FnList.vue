<script setup lang="ts">
/**
 * A system's fns: what each does, whether it can be used now (and why not), whether it is paused or off, its tags,
 * and how its runs have gone (count, failure rate, typical time and cost). Each links to its runs.
 */
import type { FnRecord, QualifiedName } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { formatCost, formatDuration } from '../../chat/logic/format.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import { UiBadge, UiIcon, fullTime, relativeTime } from '../../ui/index.ts';
import { availabilityText } from '../logic/systems.ts';

defineProps<{ fns: readonly FnRecord[]; now: number; runsOf: (fn: QualifiedName) => RouteLocationRaw }>();

const failureRate = (fn: FnRecord): string => (fn.stats.runs === 0 ? '' : `${Math.round((fn.stats.failures / fn.stats.runs) * 100)}% failed`);
</script>

<template>
  <ul class="fns" data-testid="fns">
    <li v-for="fn in fns" :key="fn.name" class="fn" :class="{ off: fn.available !== true }">
      <span class="mark" aria-hidden="true"><UiIcon name="fn" :size="16" /></span>
      <div class="main">
        <p class="top">
          <span class="label">{{ fnLabel(fn.name) }}</span>
          <code class="name">{{ fn.name }}</code>
        </p>
        <p class="description">{{ fn.decl.description }}</p>
        <p class="chips">
          <UiBadge v-if="fn.available !== true" tone="warn" :title="fn.available.detail">{{ availabilityText(fn.available) }}</UiBadge>
          <UiBadge v-if="fn.paused">Paused</UiBadge>
          <UiBadge v-if="fn.origin === 'runtime'" tone="accent">Added while running</UiBadge>
          <UiBadge v-for="tag in fn.decl.tags" :key="tag">{{ tag }}</UiBadge>
        </p>
      </div>
      <RouterLink class="stats" :to="runsOf(fn.name)" :title="fn.stats.lastRunAt === undefined ? 'Never run' : `Last run ${fullTime(fn.stats.lastRunAt)}`">
        <span class="runs">{{ fn.stats.runs.toLocaleString() }} {{ fn.stats.runs === 1 ? 'run' : 'runs' }}</span>
        <span v-if="fn.stats.runs > 0" class="dim">{{ failureRate(fn) }} · {{ formatDuration(fn.stats.averageTime) }} · {{ formatCost(fn.stats.averageCost) }}</span>
        <span v-if="fn.stats.lastRunAt !== undefined" class="dim">last {{ relativeTime(fn.stats.lastRunAt, now) }}</span>
      </RouterLink>
    </li>
  </ul>
</template>

<style scoped>
.fns { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.fn { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--space-3); padding: var(--space-4); }
.fn + .fn { border-top: 1px solid var(--border); }
.fn.off .label { color: var(--text-dim); }
.mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); background: var(--surface-2); color: var(--text-dim); }
.main { display: grid; gap: var(--space-1); min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-2); margin: 0; }
.label { font-weight: var(--weight-medium); }
.name { color: var(--text-faint); font-size: var(--text-xs); overflow-wrap: anywhere; }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; }
.chips:empty { display: none; }
.stats {
  display: grid; justify-items: end; gap: 2px; padding: var(--space-1) var(--space-2); border-radius: var(--radius); color: var(--text);
  font-size: var(--text-sm); text-align: right; text-decoration: none; white-space: nowrap;
}
.stats:hover { background: var(--surface-2); text-decoration: none; }
.stats:focus-visible { outline: none; box-shadow: var(--ring); }
.runs { font-weight: var(--weight-medium); }
.dim { color: var(--text-faint); font-size: var(--text-xs); }
@media (max-width: 559.98px) {
  .fn { grid-template-columns: auto minmax(0, 1fr); }
  .stats { grid-column: 2; justify-items: start; text-align: left; white-space: normal; margin-left: calc(var(--space-2) * -1); }
}
</style>
