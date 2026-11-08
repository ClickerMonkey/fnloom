<script setup lang="ts">
/** Resources as a grid of cards, as many columns as fit the card size (small, medium, large). */
import type { ResourceRecord, ResourceUri } from '@harness/core';
import type { ResourceAction } from '../logic/actions.ts';
import type { CardSize } from '../logic/browse.ts';
import type { Peek } from '../state/browser.ts';
import ResourceCard from './ResourceCard.vue';

withDefaults(defineProps<{
  records: readonly ResourceRecord[];
  selected: ReadonlySet<ResourceUri>;
  opened?: string;
  size: CardSize;
  /** What a card shows of a resource (asked for as each card draws). */
  peek: (record: ResourceRecord) => Peek | undefined;
}>(), { opened: '' });

const emit = defineEmits<{ open: [uri: ResourceUri]; toggle: [uri: ResourceUri]; action: [action: ResourceAction, record: ResourceRecord] }>();
</script>

<template>
  <ul class="resource-grid" :class="`size-${size}`" aria-label="Resources" data-testid="resource-grid">
    <li v-for="record in records" :key="record.uri">
      <ResourceCard
        :record="record" :peek="peek(record)" :selected="selected.has(record.uri)" :opened="opened === record.uri"
        @open="emit('open', record.uri)" @toggle="emit('toggle', record.uri)" @action="emit('action', $event, record)"
      />
    </li>
  </ul>
</template>

<style scoped>
.resource-grid { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
.size-s { grid-template-columns: repeat(auto-fill, minmax(min(100%, 140px), 1fr)); }
.size-m { grid-template-columns: repeat(auto-fill, minmax(min(100%, 190px), 1fr)); }
.size-l { grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); }
</style>
