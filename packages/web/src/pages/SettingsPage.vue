<script setup lang="ts">
/** Settings, one URL per section: how the app looks on this device, and the signed-in account. */
import { computed } from 'vue';
import AppPage from '../app/AppPage.vue';
import { SettingsSection } from '../app/routes.ts';
import { useSignOut } from '../app/signOut.ts';
import { useParamChoice } from '../app/url.ts';
import { useStores } from '../state/stores.ts';
import ThemePicker from '../components/ThemePicker.vue';
import { UiAvatar, UiBadge, UiButton, UiCard, UiSwitch, UiTabs, type TabItem } from '../ui/index.ts';

const { theme, layout, session } = useStores();
const signOut = useSignOut();
const section = useParamChoice('section', SettingsSection, 'appearance');

const TABS: readonly TabItem<SettingsSection>[] = [
  { value: 'appearance', label: 'Appearance', icon: 'palette' },
  { value: 'account', label: 'Account', icon: 'user' },
];

const collapsed = computed({ get: () => layout.collapsed, set: (value: boolean) => { layout.collapsed = value; } });
const user = session.user;
</script>

<template>
  <AppPage title="Settings" description="These apply on this device." width="readable">
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
        <div v-else class="stack">
          <UiCard v-if="user" title="Account">
            <div class="person">
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
.person { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4); }
.who { flex: 1; min-width: 0; }
.name { margin: 0; font-weight: var(--weight-strong); }
.email { margin: 0; color: var(--text-dim); overflow-wrap: anywhere; }
</style>
