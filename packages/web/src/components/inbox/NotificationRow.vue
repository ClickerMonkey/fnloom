<script setup lang="ts">
/**
 * One notification: its reason's icon, title, a short body, when it came and whether it's unread. The row's main
 * button opens what it's about (`open`); beside it, a separate button marks it read without opening it.
 */
import type { Notification } from '@harness/core';
import { computed } from 'vue';
import { UiIcon, UiIconButton, fullTime, relativeTime } from '../../ui/index.ts';
import { lookOf } from './reasons.ts';

const props = withDefaults(defineProps<{ notification: Notification; now: number; compact?: boolean }>(), { compact: false });
defineEmits<{ open: [notification: Notification]; read: [notification: Notification] }>();

const look = computed(() => lookOf(props.notification));
</script>

<template>
  <li class="row" :class="{ unread: !notification.read, resolved: notification.resolved !== undefined, compact }" :data-testid="`notification-${notification.id}`">
    <button type="button" class="open" @click="$emit('open', notification)">
      <span class="mark" :class="`tone-${look.tone}`"><UiIcon :name="look.icon" :size="16" /></span>
      <span class="text">
        <span class="top">
          <span class="title">{{ notification.title }}</span>
          <time class="time" :datetime="new Date(notification.createdAt).toISOString()" :title="fullTime(notification.createdAt)">{{ relativeTime(notification.createdAt, now) }}</time>
        </span>
        <span v-if="notification.body !== ''" class="body">{{ notification.body }}</span>
        <span class="reason" :class="`tone-${look.tone}`" data-testid="notification-reason">
          <span v-if="!notification.read" class="dot" aria-hidden="true" />
          {{ look.label }}<span v-if="!notification.read" class="sr-only">, unread</span>
        </span>
      </span>
    </button>
    <div class="side">
      <UiIconButton v-if="!notification.read" class="read" icon="check" label="Mark as read" size="sm" @click="$emit('read', notification)" />
    </div>
  </li>
</template>

<style scoped>
.row {
  display: flex; align-items: center; gap: var(--space-1); padding-right: var(--space-2); list-style: none; border-radius: var(--radius);
  transition: background-color var(--fast) var(--ease); animation: ui-rise-in var(--medium) var(--ease);
}
.row:hover { background: var(--surface-2); }
.open {
  display: flex; align-items: flex-start; gap: var(--space-3); flex: 1; min-width: 0; padding: var(--space-3) var(--space-2) var(--space-3) var(--space-4);
  border: 0; border-radius: var(--radius); background: transparent; text-align: left;
}
.open:focus-visible { outline: none; box-shadow: inset var(--ring); }
.compact .open { padding: var(--space-2) var(--space-1) var(--space-2) var(--space-3); }
.mark { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius); background: var(--tone-soft); color: var(--tone); }
.text { display: grid; gap: 2px; flex: 1; min-width: 0; }
.top { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.title { flex: 1; min-width: 0; font-weight: var(--weight-medium); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.unread .title { font-weight: var(--weight-strong); }
.time { flex: none; color: var(--text-faint); font-size: var(--text-xs); }
.body { color: var(--text-dim); font-size: var(--text-sm); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.reason { display: flex; align-items: center; gap: 6px; color: var(--text-faint); font-size: var(--text-xs); }
.reason.tone-danger, .reason.tone-warn { color: var(--tone); font-weight: var(--weight-medium); }
.resolved .title { color: var(--text-dim); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.side { display: grid; place-items: center; flex: none; width: var(--control-sm); }
.read { opacity: 0; transition: opacity var(--fast) var(--ease); }
.row:hover .read, .row:focus-within .read { opacity: 1; }
@media (hover: none) { .read { opacity: 1; } }
</style>
