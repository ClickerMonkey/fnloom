<script setup lang="ts">
/** The phone's top bar: the menu button (opens the navigation drawer), the page's title and the bell. */
import { UiIconButton, countLabel } from '../ui/index.ts';

defineProps<{ title: string; unread: number }>();
const emit = defineEmits<{ menu: []; inbox: [anchor: HTMLElement] }>();
function openInbox(event: MouseEvent): void {
  if (event.currentTarget instanceof HTMLElement) { emit('inbox', event.currentTarget); }
}
</script>

<template>
  <header class="topbar">
    <UiIconButton icon="menu" label="Open navigation" data-testid="open-nav" @click="$emit('menu')" />
    <h1 class="title">{{ title }}</h1>
    <UiIconButton icon="bell" :label="unread > 0 ? `Notifications, ${countLabel(unread)} unread` : 'Notifications'" :badge="unread" data-testid="open-inbox" @click="openInbox" />
  </header>
</template>

<style scoped>
.topbar {
  position: sticky; top: 0; z-index: var(--z-sticky); display: flex; align-items: center; gap: var(--space-2);
  min-height: calc(var(--topbar) + var(--safe-top)); padding: var(--safe-top) var(--space-2) 0;
  background: color-mix(in oklab, var(--bg) 86%, transparent); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border);
}
.title { flex: 1; min-width: 0; margin: 0; font-size: var(--text-lg); font-weight: var(--weight-strong); text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
