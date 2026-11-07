<script setup lang="ts">
/**
 * The list of chats: New chat, search, active or archived, and the rows (newest activity first, live). Loading shows
 * skeleton rows, a problem shows Retry, and an empty list says how to start. "Load more" pages back.
 */
import type { SessionId, SessionSummary } from '@harness/core';
import { ref } from 'vue';
import { UiBanner, UiButton, UiEmpty, UiInput, UiSegmented, UiSkeleton, type SegmentOption } from '../../ui/index.ts';
import SessionRow from './SessionRow.vue';

withDefaults(defineProps<{
  items: readonly SessionSummary[];
  current?: SessionId | undefined;
  search: string;
  archived: boolean;
  loading: boolean;
  loaded: boolean;
  problem?: string;
  hasMore: boolean;
  loadingMore: boolean;
  creating: boolean;
  now: number;
}>(), { current: undefined, problem: '' });

const emit = defineEmits<{
  open: [id: SessionId];
  create: [];
  search: [text: string];
  archived: [archived: boolean];
  rename: [id: SessionId, title: string];
  archive: [id: SessionId, archived: boolean];
  more: [];
  retry: [];
}>();

const VIEWS: readonly SegmentOption<'active' | 'archived'>[] = [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }];
const searchBox = ref<{ focus: () => void } | null>(null);

defineExpose({ focusSearch: () => { searchBox.value?.focus(); } });
</script>

<template>
  <nav class="sessions" aria-label="Chats" data-testid="session-list">
    <div class="top">
      <UiButton variant="primary" icon="plus" block :loading="creating" data-testid="new-chat" @click="emit('create')">New chat</UiButton>
      <UiInput
        ref="searchBox" :model-value="search" type="search" icon="search" label="Search chats" hide-label placeholder="Search chats" clearable size="sm"
        @update:model-value="emit('search', $event)"
      />
      <UiSegmented :model-value="archived ? 'archived' : 'active'" :options="VIEWS" label="Which chats" @update:model-value="emit('archived', $event === 'archived')" />
    </div>
    <UiBanner v-if="problem !== ''" tone="danger" class="problem">
      {{ problem }}
      <template #actions><UiButton size="sm" variant="ghost" @click="emit('retry')">Retry</UiButton></template>
    </UiBanner>
    <ul v-if="loading && !loaded" class="rows" aria-label="Loading chats">
      <li v-for="n in 6" :key="n" class="skeleton"><UiSkeleton shape="lines" :lines="2" /></li>
    </ul>
    <UiEmpty
      v-else-if="loaded && items.length === 0" icon="chat" :title="search !== '' ? 'No chats match' : archived ? 'Nothing archived' : 'No chats yet'"
      :body="search !== '' ? 'Try other words.' : archived ? 'Archived chats show here.' : 'Start one with New chat.'"
    />
    <TransitionGroup v-else tag="ul" name="row" class="rows">
      <SessionRow
        v-for="session in items" :key="session.id" :session="session" :active="session.id === current" :now="now"
        @open="emit('open', session.id)" @rename="emit('rename', session.id, $event)" @archive="emit('archive', session.id, $event)"
      />
    </TransitionGroup>
    <div v-if="hasMore && items.length > 0" class="more">
      <UiButton size="sm" variant="ghost" :loading="loadingMore" @click="emit('more')">Load more</UiButton>
    </div>
  </nav>
</template>

<style scoped>
.sessions { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; min-height: 0; height: 100%; }
.top { display: grid; gap: var(--space-2); padding: var(--space-3) var(--space-3) var(--space-1); }
.top :deep(.ui-segmented) { justify-self: stretch; display: flex; width: 100%; }
.top :deep(.ui-segmented .option) { flex: 1; justify-content: center; }
.problem { margin: 0 var(--space-3); }
.rows { display: grid; align-content: start; gap: 2px; flex: 1; min-height: 0; margin: 0; padding: 0 var(--space-2) var(--space-3); overflow-y: auto; }
.skeleton { padding: var(--space-3); list-style: none; }
.more { display: flex; justify-content: center; padding-bottom: var(--space-3); }
.row-enter-active { transition: opacity var(--medium) var(--ease), transform var(--medium) var(--ease); }
.row-enter-from { opacity: 0; transform: translateY(-4px); }
.row-leave-active { transition: opacity var(--fast) var(--ease); }
.row-leave-to { opacity: 0; }
.row-move { transition: transform var(--medium) var(--ease); }
</style>
