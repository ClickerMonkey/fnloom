<script setup lang="ts">
/**
 * The bar over the thread: the chats button (phones), the editable title, what the chat is doing, the people and
 * agents in it, whether it is still catching up after a reconnect, and its tools: the last turn's run tree, Undo, settings and an overflow menu (rename, archive,
 * shortcuts). On a phone it stays one row: the less-used tools move into the overflow menu instead of shrinking.
 */
import type { SessionStatus } from '@harness/core';
import { computed, ref } from 'vue';
import { UiAvatar, UiBadge, UiIconButton, UiMenu, type MenuItem } from '../../ui/index.ts';
import EditableTitle from './EditableTitle.vue';
import type { HeaderAction, TitleHandle } from './types.ts';

const props = withDefaults(defineProps<{
  title: string;
  status: SessionStatus | undefined;
  people: readonly { readonly name: string; readonly agent: boolean }[];
  compact: boolean;
  canUndo: boolean;
  hasTurn: boolean;
  archived: boolean;
  /** Something waits on the person here. */
  waiting?: number;
  /** The app's own top bar is hidden (a phone): this header carries the navigation button. */
  nav?: boolean;
  /** What is shown may be behind (a reconnect's catch-up is still being retried). */
  stale?: boolean;
  /** Debug mode is on: the thread shows the messages and parts it hides. */
  debug?: boolean;
}>(), { waiting: 0, nav: false, stale: false, debug: false });

const emit = defineEmits<{ sessions: []; nav: []; rename: [title: string]; action: [action: HeaderAction] }>();
const titleBox = ref<TitleHandle | null>(null);

const overflow = computed<MenuItem<HeaderAction>[]>(() => [
  { value: 'rename', label: 'Rename', icon: 'edit' },
  ...(props.compact ? [
    { value: 'tree' as const, label: 'Last turn’s run tree', icon: 'tree' as const, disabled: !props.hasTurn },
    { value: 'undo' as const, label: 'Undo last turn', icon: 'undo' as const, disabled: !props.canUndo },
    { value: 'people' as const, label: 'People', icon: 'users' as const },
    { value: 'settings' as const, label: 'Chat settings', icon: 'settings' as const },
  ] : []),
  { kind: 'separator' },
  { value: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?' },
  { value: 'debug', label: props.debug ? 'Leave debug mode' : 'Debug: show hidden messages', icon: 'code' },
  { value: 'archive', label: props.archived ? 'Restore' : 'Archive', icon: 'archive' },
  { value: 'delete', label: 'Delete chat…', icon: 'trash', danger: true },
]);

function choose(action: HeaderAction): void {
  if (action === 'rename') { void titleBox.value?.start(); return; }
  emit('action', action);
}
</script>

<template>
  <header class="chat-header" :class="{ compact }" data-testid="chat-header">
    <UiIconButton v-if="nav" icon="menu" label="Open navigation" data-testid="open-nav" @click="emit('nav')" />
    <UiIconButton v-if="compact" icon="sidebar" label="Chats" data-testid="open-sessions" @click="emit('sessions')" />
    <div class="title-wrap">
      <EditableTitle ref="titleBox" :value="title" @save="emit('rename', $event)" />
      <UiBadge v-if="status === 'running'" tone="accent" live data-testid="session-status">Working</UiBadge>
      <UiBadge v-else-if="status === 'paused'" tone="warn" data-testid="session-status">Paused</UiBadge>
      <UiBadge v-if="waiting > 0" tone="warn" data-testid="needs-you">{{ waiting }} waiting</UiBadge>
      <UiBadge v-if="debug" tone="accent" data-testid="debug-badge" title="Hidden messages and parts are shown">Debug</UiBadge>
      <UiBadge v-if="stale" live data-testid="catching-up" title="Some updates may have been missed while offline; fetching them again.">Catching up…</UiBadge>
    </div>
    <div class="tools">
      <button v-if="!compact && people.length > 0" type="button" class="people" :aria-label="`${people.length} in this chat`" data-testid="participants" @click="emit('action', 'people')">
        <UiAvatar v-for="(person, i) in people.slice(0, 3)" :key="i" class="face" :name="person.name" :kind="person.agent ? 'agent' : 'person'" :size="24" />
        <span v-if="people.length > 3" class="extra">+{{ people.length - 3 }}</span>
      </button>
      <template v-if="!compact">
        <UiIconButton icon="tree" label="Last turn’s run tree" :disabled="!hasTurn" data-testid="open-tree" @click="emit('action', 'tree')" />
        <UiIconButton icon="undo" label="Undo last turn" :disabled="!canUndo" data-testid="undo-last" @click="emit('action', 'undo')" />
        <UiIconButton icon="settings" label="Chat settings" data-testid="open-settings" @click="emit('action', 'settings')" />
      </template>
      <UiMenu :items="overflow" label="Chat actions" @select="choose">
        <template #trigger="{ toggle, attrs }">
          <UiIconButton icon="more" label="More" v-bind="attrs" data-testid="chat-menu" @click="toggle" />
        </template>
      </UiMenu>
    </div>
  </header>
</template>

<style scoped>
.chat-header {
  display: flex; align-items: center; gap: var(--space-2); min-width: 0; min-height: var(--topbar); padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border); background: color-mix(in oklch, var(--bg) 88%, transparent); backdrop-filter: blur(8px);
}
.compact { padding: var(--space-1) var(--space-2); }
.title-wrap { display: flex; align-items: center; gap: var(--space-2); flex: 1; min-width: 0; }
.tools { display: flex; align-items: center; gap: 2px; flex: none; }
.people { display: flex; align-items: center; height: 36px; padding: 0 var(--space-2); margin-right: var(--space-1); border: 0; border-radius: var(--radius-full); background: transparent; }
.people:hover { background: var(--surface-2); }
.people:focus-visible { outline: none; box-shadow: var(--ring); }
.face { margin-left: -6px; box-shadow: 0 0 0 2px var(--bg); border-radius: 50%; }
.face:first-child { margin-left: 0; }
.extra { margin-left: 4px; color: var(--text-faint); font-size: var(--text-xs); }
</style>
