<script setup lang="ts">
/**
 * One context item in the list: its origin's mark, its name and description, and badges for what sets it apart (its
 * `/command`, the agents it is always given to, its size in tokens, stale or forgotten), with when it last changed.
 * The whole row is a link to the item's page.
 */
import type { ContextRecord } from '@harness/core';
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { fullTime, relativeTime, UiBadge, UiIcon } from '../../ui/index.ts';
import { ORIGIN_WORDS, originOf } from '../logic/context.ts';

const props = defineProps<{ record: ContextRecord; to: RouteLocationRaw; now: number }>();
const origin = computed(() => ORIGIN_WORDS[originOf(props.record)]);
const command = computed(() => props.record.decl.command?.name);
</script>

<template>
  <RouterLink class="row" :class="{ off: record.disabled === true }" :to="to" :data-context="record.name" data-testid="context-row">
    <span class="mark" :data-origin="originOf(record)" aria-hidden="true"><UiIcon :name="origin.icon" :size="16" /></span>
    <span class="main">
      <span class="top">
        <code class="name">{{ record.name }}</code>
        <UiBadge v-if="command !== undefined">/{{ command }}</UiBadge>
        <UiBadge v-if="record.decl.alwaysFor.length > 0" tone="accent">Always given</UiBadge>
        <UiBadge v-if="record.stale" tone="warn">Stale</UiBadge>
        <UiBadge v-if="record.disabled === true">Forgotten</UiBadge>
      </span>
      <span class="description">{{ record.decl.description }}</span>
    </span>
    <span class="side">
      <span class="origin">{{ origin.short }}</span>
      <span v-if="record.tokens !== undefined" class="tokens">{{ record.tokens.full.toLocaleString() }} tokens</span>
      <time class="when" :datetime="new Date(record.updatedAt).toISOString()" :title="fullTime(record.updatedAt)">{{ relativeTime(record.updatedAt, now) }}</time>
    </span>
  </RouterLink>
</template>

<style scoped>
.row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-3);
  padding: var(--space-3) var(--space-4); color: var(--text); text-decoration: none; transition: background var(--fast) var(--ease);
}
.row:hover { background: var(--surface-2); text-decoration: none; }
.row:focus-visible { outline: none; box-shadow: inset var(--ring); }
.off .name, .off .description { color: var(--text-faint); }
.mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); background: var(--surface-2); color: var(--text-dim); }
.mark[data-origin='memory'] { background: var(--accent-soft); color: var(--accent); }
.main { display: grid; gap: 2px; min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); min-width: 0; }
.name { font-size: var(--text-sm); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.description { color: var(--text-dim); font-size: var(--text-sm); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.side { display: grid; justify-items: end; gap: 2px; color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap; }
.origin { color: var(--text-dim); }
@media (max-width: 559.98px) {
  .row { grid-template-columns: auto minmax(0, 1fr); align-items: start; }
  .side { grid-column: 2; display: flex; flex-wrap: wrap; justify-items: start; gap: var(--space-2); }
}
</style>
