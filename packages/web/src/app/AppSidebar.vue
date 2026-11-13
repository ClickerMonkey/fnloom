<script setup lang="ts">
/**
 * The sidebar: the mark, the bell, the navigation, room for the chat's session list (default slot), and the person's
 * menu at the foot. Collapses to icons on wide screens; in the phone drawer it is always full. It only draws what it's
 * given and reports what the person does.
 */
import type { UserView } from '@harness/core';
import { UiAvatar, UiIcon, UiIconButton, UiMenu, countLabel, type MenuItem } from '../ui/index.ts';
import AppBrand from './AppBrand.vue';
import type { NavEntry } from './nav.ts';

withDefaults(defineProps<{
  /** The hub's display name, for the mark. */
  brand: string;
  entries: readonly NavEntry[];
  user: UserView | undefined;
  unread: number;
  collapsed?: boolean;
  /** Offer the collapse toggle (wide screens). */
  collapsible?: boolean;
}>(), { collapsed: false, collapsible: true });

const emit = defineEmits<{ toggle: []; inbox: [anchor: HTMLElement]; settings: []; signOut: []; navigate: [] }>();
const slots = defineSlots<{ default?: () => unknown }>();

type UserAction = 'settings' | 'sign-out';
const USER_MENU: readonly MenuItem<UserAction>[] = [
  { value: 'settings', label: 'Settings', icon: 'settings' },
  { kind: 'separator' },
  { value: 'sign-out', label: 'Sign out', icon: 'log-out', danger: true },
];

function openInbox(event: MouseEvent): void {
  if (event.currentTarget instanceof HTMLElement) { emit('inbox', event.currentTarget); }
}

function onUserAction(action: UserAction): void {
  if (action === 'settings') { emit('settings'); } else { emit('signOut'); }
}
</script>

<template>
  <nav class="sidebar" :class="{ collapsed }" aria-label="Main">
    <div class="head">
      <AppBrand :name="brand" :mark-only="collapsed" />
      <div class="head-tools">
        <UiIconButton icon="bell" :label="unread > 0 ? `Notifications, ${countLabel(unread)} unread` : 'Notifications'" :badge="unread" data-testid="open-inbox" @click="openInbox" />
        <UiIconButton v-if="collapsible" icon="sidebar" :label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'" data-testid="toggle-sidebar" @click="$emit('toggle')" />
      </div>
    </div>

    <ul class="entries">
      <li v-for="entry in entries" :key="entry.id">
        <RouterLink
          :to="entry.to" class="entry" :class="{ active: entry.active }" :aria-current="entry.active ? 'page' : undefined"
          :title="collapsed ? entry.label : undefined" :data-testid="`nav-${entry.id}`" @click="$emit('navigate')"
        >
          <UiIcon :name="entry.icon" :size="18" />
          <span class="label">{{ entry.label }}</span>
          <span v-if="entry.count > 0" class="count" :aria-label="`${entry.count} unread`">{{ countLabel(entry.count) }}</span>
        </RouterLink>
      </li>
    </ul>

    <div class="middle">
      <slot v-if="slots.default && !collapsed" />
    </div>

    <div v-if="user" class="foot">
      <UiMenu :items="USER_MENU" label="Account" side="top" align="start" @select="onUserAction">
        <template #trigger="{ toggle, attrs }">
          <button type="button" class="person" v-bind="attrs" :title="collapsed ? user.name : undefined" data-testid="user-menu" @click="toggle">
            <UiAvatar :name="user.name" :size="30" />
            <span class="who">
              <span class="name">{{ user.name }}</span>
              <span class="email">{{ user.email }}</span>
            </span>
            <UiIcon name="chevron-up" :size="16" class="chevron" />
          </button>
        </template>
      </UiMenu>
    </div>
  </nav>
</template>

<style scoped>
.sidebar {
  display: flex; flex-direction: column; gap: var(--space-2); height: 100%; min-height: 0; padding: var(--space-3);
  padding-top: max(var(--space-3), var(--safe-top)); padding-bottom: max(var(--space-3), var(--safe-bottom));
  background: var(--surface); overflow: hidden;
}
.head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-height: var(--control); padding-left: var(--space-2); }
.head-tools { display: flex; gap: 2px; }
.collapsed .head { flex-direction: column; padding-left: 0; gap: var(--space-2); }
.collapsed .head-tools { flex-direction: column; }
.entries { display: grid; gap: 2px; margin: var(--space-2) 0 0; padding: 0; list-style: none; }
.entry {
  display: flex; align-items: center; gap: var(--space-3); height: var(--control); padding: 0 var(--space-3); border-radius: var(--radius);
  color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none;
  transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease);
}
.entry:hover { background: var(--surface-2); color: var(--text); text-decoration: none; }
.entry.active { background: var(--accent-soft); color: var(--text); }
.entry.active :deep(.ui-icon) { color: var(--accent); }
.entry:focus-visible { outline: none; box-shadow: var(--ring); }
.label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { min-width: 20px; padding: 0 6px; border-radius: var(--radius-full); background: var(--accent); color: var(--on-accent); font-size: 11px; font-weight: var(--weight-strong); line-height: 20px; text-align: center; }
.collapsed .entry { justify-content: center; padding: 0; }
.collapsed .label, .collapsed .count { display: none; }
.middle { flex: 1; min-height: 0; overflow: auto; margin: 0 calc(var(--space-3) * -1); padding: 0 var(--space-3); }
.foot { border-top: 1px solid var(--border); padding-top: var(--space-2); }
.foot :deep(.ui-menu-trigger) { display: flex; }
.person {
  display: flex; align-items: center; gap: var(--space-3); width: 100%; min-width: 0; padding: var(--space-2); border: 0; border-radius: var(--radius);
  background: transparent; text-align: left; transition: background-color var(--fast) var(--ease);
}
.person:hover, .person[aria-expanded='true'] { background: var(--surface-2); }
.person:focus-visible { outline: none; box-shadow: var(--ring); }
.who { display: grid; flex: 1; min-width: 0; line-height: var(--leading-tight); }
.name { font-weight: var(--weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.email { color: var(--text-faint); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chevron { color: var(--text-faint); }
.collapsed .person { justify-content: center; padding: var(--space-1); }
.collapsed .who, .collapsed .chevron { display: none; }
</style>
