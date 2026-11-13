<script setup lang="ts">
/**
 * The types an instance made (a database's table types): each one's name, what it is, and whether a change to it
 * waits for approval; opening one shows its type. Only one is open at a time. `detailed` (a system's page) also says
 * on every row where it was declared (its contract or while running) and its version. An open type shows its history.
 */
import type { TypeRecord } from '@harness/core';
import { ref } from 'vue';
import GinTypeView from '../../gin/GinTypeView.vue';
import ItemHistory from '../../components/versions/ItemHistory.vue';
import { DECLARED_WORDS } from '../../context/logic/context.ts';
import { UiBadge, UiIcon } from '../../ui/index.ts';

defineProps<{ types: readonly TypeRecord[]; changing: ReadonlySet<string>; detailed?: boolean }>();
const open = ref('');
const toggle = (name: string): void => { open.value = open.value === name ? '' : name; };
</script>

<template>
  <ul class="types" data-testid="instance-types">
    <li v-for="type in types" :key="type.name" class="type" :data-type="type.name">
      <button type="button" class="row" :aria-expanded="open === type.name" @click="toggle(type.name)">
        <UiIcon :name="open === type.name ? 'chevron-down' : 'chevron-right'" :size="14" class="chevron" />
        <span class="main">
          <code class="name">{{ type.name.slice(type.name.indexOf('/') + 1) }}</code>
          <span v-if="type.description !== ''" class="description">{{ type.description }}</span>
        </span>
        <span v-if="detailed" class="declared" data-testid="type-declared">{{ DECLARED_WORDS[type.declaredBy ?? 'contract'] }}<code v-if="type.version !== undefined" class="version" :title="`Version ${type.version}`">{{ type.version.slice(0, 8) }}</code></span>
        <UiBadge v-else-if="type.declaredBy === 'runtime'" tone="accent" :title="type.version === undefined ? undefined : `Version ${type.version.slice(0, 8)}`" data-testid="type-runtime">Added while running</UiBadge>
        <UiBadge v-if="changing.has(type.name)" tone="warn">Change waiting</UiBadge>
      </button>
      <div v-if="open === type.name" class="body">
        <GinTypeView :model-value="type.def" readonly :label="type.name" />
        <ItemHistory :item="{ system: type.system, section: 'types', name: type.name }" />
      </div>
    </li>
  </ul>
</template>

<style scoped>
.types { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.type + .type { border-top: 1px solid var(--border); }
.row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3); width: 100%;
  padding: var(--space-3) var(--space-4); border: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer;
}
.row:hover { background: var(--surface-2); }
.row:focus-visible { outline: none; box-shadow: inset var(--ring); }
.chevron { color: var(--text-faint); }
.main { display: grid; gap: 2px; min-width: 0; }
.name { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.description { color: var(--text-dim); font-size: var(--text-sm); }
.declared { color: var(--text-dim); font-size: var(--text-xs); white-space: nowrap; }
.version { margin-left: var(--space-2); color: var(--text-faint); font-size: var(--text-xs); }
.body { padding: 0 var(--space-4) var(--space-4); min-width: 0; }
</style>
