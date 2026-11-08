<script setup lang="ts">
/**
 * Resources grouped by the hub's facets (type, source, folder or date): a section per group with its count, folding
 * open and closed, showing its first resources as cards, and "Show all" to narrow the browser to that group.
 */
import type { ResourceFacet, ResourcePage, ResourceRecord, ResourceUri } from '@harness/core';
import { ref } from 'vue';
import { UiButton, UiIconButton, UiSkeleton } from '../../ui/index.ts';
import type { Loaded } from '../../state/loaded.ts';
import type { ResourceAction } from '../logic/actions.ts';
import type { Peek } from '../state/browser.ts';
import ResourceCard from './ResourceCard.vue';

defineProps<{
  facets: readonly ResourceFacet[];
  groups: ReadonlyMap<string, Loaded<ResourcePage>>;
  selected: ReadonlySet<ResourceUri>;
  opened: string;
  peek: (record: ResourceRecord) => Peek | undefined;
}>();
const emit = defineEmits<{ open: [uri: ResourceUri]; toggle: [uri: ResourceUri]; action: [action: ResourceAction, record: ResourceRecord]; all: [value: string] }>();

const folded = ref<ReadonlySet<string>>(new Set());
function fold(value: string): void {
  const next = new Set(folded.value);
  if (next.has(value)) { next.delete(value); } else { next.add(value); }
  folded.value = next;
}
</script>

<template>
  <div class="resource-groups" data-testid="resource-groups">
    <section v-for="facet in facets" :key="facet.value" class="group" :data-group="facet.value" data-testid="resource-group">
      <header class="head">
        <UiIconButton
          :icon="folded.has(facet.value) ? 'chevron-right' : 'chevron-down'" size="sm" :label="folded.has(facet.value) ? `Show ${facet.label}` : `Hide ${facet.label}`"
          :pressed="!folded.has(facet.value)" @click="fold(facet.value)"
        />
        <h2 class="title">{{ facet.label }}</h2>
        <span class="count">{{ facet.count.toLocaleString() }}</span>
        <UiButton class="all" size="sm" variant="ghost" icon-right="arrow-right" @click="emit('all', facet.value)">Show all</UiButton>
      </header>
      <template v-if="!folded.has(facet.value)">
        <UiSkeleton v-if="groups.get(facet.value)?.loading.value && !groups.get(facet.value)?.value.value" shape="block" :height="120" />
        <p v-else-if="groups.get(facet.value)?.problem.value" class="problem">{{ groups.get(facet.value)?.problem.value }}</p>
        <ul v-else class="cards">
          <li v-for="record in groups.get(facet.value)?.value.value?.items ?? []" :key="record.uri">
            <ResourceCard
              :record="record" :peek="peek(record)" :selected="selected.has(record.uri)" :opened="opened === record.uri"
              @open="emit('open', record.uri)" @toggle="emit('toggle', record.uri)" @action="emit('action', $event, record)"
            />
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>

<style scoped>
.resource-groups { display: grid; gap: var(--space-5); min-width: 0; }
.group { display: grid; gap: var(--space-3); min-width: 0; }
.head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { padding: 0 6px; border-radius: 999px; background: var(--surface-3); color: var(--text-dim); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.all { margin-left: auto; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 170px), 1fr)); gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
</style>
