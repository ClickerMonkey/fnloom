<script setup lang="ts">
/**
 * Context items or types a system declares, as its review lists them: each with its switch, its title and what it is,
 * and whether it was added while running rather than declared in the contract. A row opens its page when it has one.
 */
import type { QualifiedName } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { UiBadge, UiSwitch } from '../../ui/index.ts';
import type { DeclaredItem } from '../logic/review.ts';

withDefaults(defineProps<{
  items: readonly DeclaredItem[];
  busy?: boolean;
  /** An item's page, when it has one. */
  pageOf?: ((name: QualifiedName) => RouteLocationRaw) | undefined;
}>(), { busy: false, pageOf: undefined });
const emit = defineEmits<{ switch: [item: DeclaredItem, on: boolean] }>();
</script>

<template>
  <ul class="list" data-testid="declared-list">
    <li v-for="item in items" :key="item.name" class="row" :class="{ off: !item.on }" :data-item="item.name">
      <UiSwitch :model-value="item.on" :label="`Use ${item.title}`" hide-label :disabled="busy" data-testid="declared-switch" @update:model-value="emit('switch', item, $event)" />
      <span class="main">
        <RouterLink v-if="pageOf" :to="pageOf(item.name)" class="title">{{ item.title }}</RouterLink>
        <span v-else class="title">{{ item.title }}</span>
        <span v-if="item.about !== ''" class="about">{{ item.about }}</span>
      </span>
      <span class="side">
        <code class="name">{{ item.name }}</code>
        <UiBadge v-if="item.runtime" tone="accent">Added while running</UiBadge>
      </span>
    </li>
  </ul>
</template>

<style scoped>
.list { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.list > li + li { border-top: 1px solid var(--border); }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-3); padding: var(--space-2) var(--space-4); }
.off .main { opacity: 0.6; }
.main { display: grid; gap: 2px; min-width: 0; }
.title { font-size: var(--text-sm); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.about { color: var(--text-dim); font-size: var(--text-sm); }
.side { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-1) var(--space-2); }
.name { color: var(--text-faint); font-size: var(--text-xs); overflow-wrap: anywhere; }
@media (max-width: 559.98px) {
  .row { grid-template-columns: auto minmax(0, 1fr); }
  .side { grid-column: 2; justify-content: flex-start; }
}
</style>
