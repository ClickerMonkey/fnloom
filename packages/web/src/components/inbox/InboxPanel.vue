<script setup lang="ts">
/**
 * The bell's popover: the latest notifications, "Mark all read", and a way to the full inbox. Fits its content,
 * up to the viewport.
 */
import type { Notification } from '@harness/core';
import { computed } from 'vue';
import { UiButton } from '../../ui/index.ts';
import NotificationList from './NotificationList.vue';

const props = withDefaults(defineProps<{
  items: readonly Notification[];
  unread: number;
  now: number;
  loading: boolean;
  loaded: boolean;
  problem?: string;
  /** How many to show. */
  limit?: number;
}>(), { problem: '', limit: 6 });

defineEmits<{ open: [notification: Notification]; read: [notification: Notification]; readAll: []; all: []; retry: [] }>();
const shown = computed(() => props.items.slice(0, props.limit));
</script>

<template>
  <div class="panel" data-testid="inbox-panel">
    <header class="head">
      <h2 class="title">Notifications</h2>
      <UiButton v-if="unread > 0" size="sm" variant="ghost" icon="check" @click="$emit('readAll')">Mark all read</UiButton>
    </header>
    <NotificationList
      :items="shown" :now="now" :loading="loading" :loaded="loaded" :problem="problem" compact
      @open="$emit('open', $event)" @read="$emit('read', $event)" @retry="$emit('retry')"
    />
    <footer class="foot">
      <UiButton size="sm" variant="ghost" icon-right="arrow-right" block @click="$emit('all')">Open inbox</UiButton>
    </footer>
  </div>
</template>

<style scoped>
.panel { display: grid; width: min(400px, 100vw - 16px); padding: var(--space-1); }
.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-height: 44px; padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3); }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.foot { padding: var(--space-1); border-top: 1px solid var(--border); margin-top: var(--space-1); }
</style>
