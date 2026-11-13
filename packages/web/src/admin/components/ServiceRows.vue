<script setup lang="ts">
/**
 * A fleet of remote services as a list (MCP servers, API services): each row its name and state, where it is (a URL
 * or a command), its instance and sign-in in a line, a warning badge and its figures when it has them; each opens its
 * page.
 */
import { UiBadge, UiIcon, type IconName } from '../../ui/index.ts';
import type { ServiceRow } from '../logic/service-views.ts';
import StatusBadge from './StatusBadge.vue';

defineProps<{ rows: readonly ServiceRow[]; icon: IconName; testid: string }>();
</script>

<template>
  <ul class="list" :data-testid="testid">
    <li v-for="row in rows" :key="row.key" :data-service="row.key">
      <RouterLink class="open" :to="row.to" data-testid="service-row">
        <span class="mark" aria-hidden="true"><UiIcon :name="icon" :size="16" /></span>
        <span class="main">
          <span class="top">
            <span class="name">{{ row.label }}</span>
            <StatusBadge :look="row.look" />
            <UiBadge v-if="row.warning" tone="warn">{{ row.warning }}</UiBadge>
          </span>
          <code class="where">{{ row.where }}</code>
          <span class="detail">{{ row.detail }}</span>
        </span>
        <span v-if="row.figures" class="figures">{{ row.figures }}</span>
      </RouterLink>
    </li>
  </ul>
</template>

<style scoped>
.list { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); list-style: none; overflow: hidden; }
.list > li + li { border-top: 1px solid var(--border); }
.open { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3) var(--space-4); padding: var(--space-3) var(--space-4); color: var(--text); text-decoration: none; }
.open:hover { background: var(--surface-2); text-decoration: none; }
.open:focus-visible { outline: none; box-shadow: inset var(--ring); }
.mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); background: var(--surface-2); color: var(--text-dim); }
.main { display: grid; gap: 2px; min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); }
.name { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.where { overflow: hidden; color: var(--text-dim); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.detail { color: var(--text-faint); font-size: var(--text-xs); }
.figures { color: var(--text-dim); font-size: var(--text-sm); white-space: nowrap; }
@media (max-width: 559.98px) {
  .open { grid-template-columns: auto minmax(0, 1fr); }
  .figures { grid-column: 2; white-space: normal; }
}
</style>
