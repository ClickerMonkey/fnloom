<script setup lang="ts">
/**
 * A list of notifications with its states: loading (skeleton rows), a problem (with Retry), empty, and the list with
 * "Load older" when there is more. Draws only what it's given and reports what the person does.
 */
import type { Notification } from '@harness/core';
import { UiBanner, UiButton, UiEmpty, UiSkeleton } from '../../ui/index.ts';
import NotificationRow from './NotificationRow.vue';

withDefaults(defineProps<{
  items: readonly Notification[];
  now: number;
  loading: boolean;
  loaded: boolean;
  problem?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  compact?: boolean;
  /** What to say when there is nothing. */
  emptyTitle?: string;
  emptyBody?: string;
}>(), { problem: '', hasMore: false, loadingMore: false, compact: false, emptyTitle: 'All caught up', emptyBody: 'Approvals, replies and finished work show up here.' });

defineEmits<{ open: [notification: Notification]; also: [notification: Notification]; read: [notification: Notification]; more: []; retry: [] }>();
</script>

<template>
  <div class="list" :class="{ compact }" :aria-busy="loading ? 'true' : 'false'">
    <UiBanner v-if="problem !== ''" tone="danger" class="problem">
      {{ problem }}
      <template #actions><UiButton size="sm" variant="ghost" @click="$emit('retry')">Retry</UiButton></template>
    </UiBanner>
    <ul v-if="loading && !loaded" class="skeletons" aria-label="Loading notifications">
      <li v-for="n in compact ? 3 : 5" :key="n" class="skeleton">
        <UiSkeleton shape="circle" :size="32" />
        <UiSkeleton shape="lines" :lines="2" class="lines" />
      </li>
    </ul>
    <UiEmpty v-else-if="loaded && items.length === 0" icon="inbox" :title="emptyTitle" :body="emptyBody" />
    <TransitionGroup v-else tag="ul" name="row" class="rows">
      <NotificationRow
        v-for="item in items" :key="item.id" :notification="item" :now="now" :compact="compact"
        @open="$emit('open', $event)" @also="$emit('also', $event)" @read="$emit('read', $event)"
      />
    </TransitionGroup>
    <div v-if="hasMore && items.length > 0" class="more">
      <UiButton variant="ghost" size="sm" :loading="loadingMore" @click="$emit('more')">Load older</UiButton>
    </div>
  </div>
</template>

<style scoped>
.list { display: grid; gap: var(--space-2); min-width: 0; }
.rows, .skeletons { display: grid; gap: 2px; margin: 0; padding: 0; }
.skeleton { display: flex; gap: var(--space-3); padding: var(--space-3) var(--space-4); list-style: none; }
.lines { flex: 1; padding-top: 4px; }
.more { display: flex; justify-content: center; padding: var(--space-2); }
.compact .problem { margin: var(--space-2); }
.row-leave-active { transition: opacity var(--fast) var(--ease); }
.row-leave-to { opacity: 0; }
.row-move { transition: transform var(--medium) var(--ease); }
</style>
