<script setup lang="ts">
/**
 * One chat in the list: its title, when it was last active, and a live status dot (working, paused, idle). Its menu
 * renames, archives or restores it. Renaming happens in place: Enter saves, Escape cancels.
 */
import type { SessionSummary } from '@harness/core';
import { computed, nextTick, ref } from 'vue';
import { UiIconButton, UiMenu, fullTime, relativeTime, type MenuItem } from '../../ui/index.ts';

type RowAction = 'rename' | 'archive' | 'restore';

const props = defineProps<{ session: SessionSummary; active: boolean; now: number }>();
const emit = defineEmits<{ open: []; rename: [title: string]; archive: [archived: boolean] }>();

const editing = ref(false);
const draft = ref('');
const input = ref<HTMLInputElement | null>(null);

const items = computed<MenuItem<RowAction>[]>(() => [
  { value: 'rename', label: 'Rename', icon: 'edit' },
  props.session.archived ? { value: 'restore', label: 'Restore', icon: 'refresh' } : { value: 'archive', label: 'Archive', icon: 'archive' },
]);
const status = computed(() => (props.session.status === 'running' ? 'Working' : props.session.status === 'paused' ? 'Paused' : ''));

async function choose(action: RowAction): Promise<void> {
  if (action === 'rename') {
    draft.value = props.session.title;
    editing.value = true;
    await nextTick();
    input.value?.select();
    return;
  }
  emit('archive', action === 'archive');
}

function save(): void {
  if (!editing.value) { return; }
  editing.value = false;
  const title = draft.value.trim();
  if (title !== '' && title !== props.session.title) { emit('rename', title); }
}
</script>

<template>
  <li class="row" :class="{ active, [session.status]: true }" data-testid="session-row" :data-session="session.id" :data-status="session.status">
    <input
      v-if="editing" ref="input" v-model="draft" class="rename" aria-label="Chat title" maxlength="120"
      @keydown.enter.prevent="save" @keydown.escape.stop.prevent="editing = false" @blur="save"
    />
    <button v-else type="button" class="open" :aria-current="active ? 'page' : undefined" @click="emit('open')">
      <span class="dot" :title="status || 'Idle'" :aria-label="status || 'Idle'" role="img" data-testid="session-dot" />
      <span class="text">
        <span class="title" :title="session.title">{{ session.title || 'New chat' }}</span>
        <span class="when" :title="fullTime(session.updatedAt)">{{ status || relativeTime(session.updatedAt, now) }}</span>
      </span>
    </button>
    <UiMenu v-if="!editing" :items="items" :label="`${session.title} actions`" @select="choose">
      <template #trigger="{ toggle, attrs }">
        <UiIconButton class="menu" size="sm" icon="more" :label="`More for ${session.title}`" v-bind="attrs" @click="toggle" />
      </template>
    </UiMenu>
  </li>
</template>

<style scoped>
.row { position: relative; display: flex; align-items: center; gap: 2px; padding-right: var(--space-1); list-style: none; border-radius: var(--radius); transition: background-color var(--fast) var(--ease); }
.row:hover { background: var(--surface-2); }
.row.active { background: var(--accent-soft); }
.open { display: flex; align-items: center; gap: var(--space-3); flex: 1; min-width: 0; min-height: 48px; padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3); border: 0; border-radius: var(--radius); background: transparent; color: var(--text); text-align: left; }
.open:focus-visible { outline: none; box-shadow: inset var(--ring); }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--border-strong); transition: background-color var(--medium) var(--ease); }
.running .dot { background: var(--accent); animation: ui-pulse 1.4s var(--ease-in-out) infinite; }
.paused .dot { background: var(--warn); }
.text { display: grid; flex: 1; min-width: 0; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: var(--weight-medium); }
.active .title { color: var(--accent); }
.when { color: var(--text-faint); font-size: var(--text-xs); }
.running .when { color: var(--accent); }
.menu { opacity: 0; transition: opacity var(--fast) var(--ease); }
.row:hover .menu, .row:focus-within .menu, .row.active .menu { opacity: 1; }
@media (hover: none) { .menu { opacity: 1; } }
.rename { flex: 1; min-width: 0; height: 40px; margin: 4px; padding: 0 var(--space-3); border: 1px solid var(--accent); border-radius: var(--radius); background: var(--surface); color: var(--text); font: inherit; box-shadow: var(--ring); }
.rename:focus { outline: none; }
</style>
