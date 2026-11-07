<script setup lang="ts">
/**
 * Settings, one URL per section: how the app looks on this device, notifications on this device (web push), and the
 * signed-in account. Each section says where its settings apply.
 */
import { computed, onMounted } from 'vue';
import AppPage from '../app/AppPage.vue';
import { SettingsSection } from '../app/routes.ts';
import { useSignOut } from '../app/signOut.ts';
import { useParamChoice } from '../app/url.ts';
import { useStores } from '../state/stores.ts';
import type { PushState } from '../state/push.ts';
import ThemePicker from '../components/ThemePicker.vue';
import { UiAvatar, UiBadge, UiBanner, UiButton, UiCard, UiSwitch, UiTabs, type TabItem } from '../ui/index.ts';

const { theme, layout, session, push, toasts } = useStores();
const signOut = useSignOut();
const section = useParamChoice('section', SettingsSection, 'appearance');

const TABS: readonly TabItem<SettingsSection>[] = [
  { value: 'appearance', label: 'Appearance' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'account', label: 'Account' },
];

/** Where each section's settings apply. */
const WHERE = {
  appearance: 'These apply on this device.',
  notifications: 'These apply on this device.',
  account: 'Your account on this hub.',
} as const satisfies Record<SettingsSection, string>;

/** What the push card says for each state. */
const PUSH_TEXT = {
  unsupported: "This browser can't show notifications from the hub here. They need a secure page (https or localhost).",
  off: 'Get a notification when something needs you while the app is closed.',
  on: 'This device gets a notification when something needs you.',
  blocked: 'Notifications are blocked for this site. Allow them in the browser’s site settings, then turn them on here.',
} as const satisfies Record<PushState, string>;

const collapsed = computed({ get: () => layout.collapsed, set: (value: boolean) => { layout.collapsed = value; } });
const user = session.user;
const pushOn = computed({
  get: () => push.state.value === 'on',
  set: (on: boolean) => { void (on ? push.enable().then((ok) => { if (ok) { toasts.ok('Notifications on'); } }) : push.disable()); },
});

onMounted(() => { void push.check(); });
</script>

<template>
  <AppPage title="Settings" :description="WHERE[section]">
    <UiTabs v-model="section" :tabs="TABS" label="Settings sections">
      <template #default="{ value }">
        <div v-if="value === 'appearance'" class="stack">
          <UiCard title="Theme" subtitle="Follow your device, or pick one.">
            <ThemePicker v-model="theme.choice.value" />
          </UiCard>
          <UiCard title="Layout">
            <UiSwitch v-model="collapsed" label="Compact sidebar" description="Show only icons in the sidebar on wide screens." />
          </UiCard>
        </div>
        <div v-else-if="value === 'notifications'" class="stack">
          <UiCard title="Notifications" data-testid="push-card">
            <UiSwitch
              v-model="pushOn" label="Notify this device" :description="PUSH_TEXT[push.state.value]"
              :disabled="push.busy.value || push.state.value === 'unsupported' || push.state.value === 'blocked'" data-testid="push-switch"
            />
            <UiBanner v-if="push.problem.value !== ''" tone="danger">{{ push.problem.value }}</UiBanner>
          </UiCard>
        </div>
        <div v-else class="stack">
          <UiCard v-if="user" title="Account">
            <div class="account">
              <UiAvatar :name="user.name" :size="48" />
              <div class="who">
                <p class="name">{{ user.name }}</p>
                <p class="email">{{ user.email }}</p>
              </div>
              <UiBadge :tone="user.role === 'admin' ? 'accent' : 'neutral'">{{ user.role === 'admin' ? 'Admin' : 'Member' }}</UiBadge>
            </div>
            <template #footer>
              <UiButton icon="log-out" variant="danger" data-testid="sign-out" @click="signOut">Sign out</UiButton>
            </template>
          </UiCard>
        </div>
      </template>
    </UiTabs>
  </AppPage>
</template>

<style scoped>
.stack { display: grid; gap: var(--space-4); }
.account { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4); }
.who { flex: 1; min-width: 0; }
.name { margin: 0; font-weight: var(--weight-strong); }
.email { margin: 0; color: var(--text-dim); overflow-wrap: anywhere; }
</style>
