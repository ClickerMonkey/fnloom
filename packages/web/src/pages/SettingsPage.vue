<script setup lang="ts">
/**
 * Settings, one URL per section: how the app looks on this device, notifications on this device (web push), and the
 * signed-in account. Each section says where its settings apply.
 */
import { computed, onMounted, watch } from 'vue';
import AppPage from '../app/AppPage.vue';
import { SettingsSection } from '../app/routes.ts';
import { useSignOut } from '../app/signOut.ts';
import { useParamChoice } from '../app/url.ts';
import { useStores } from '../state/stores.ts';
import type { PushState } from '../state/push.ts';
import HubNameCard from '../components/HubNameCard.vue';
import ThemePicker from '../components/ThemePicker.vue';
import { UiAvatar, UiBadge, UiBanner, UiButton, UiCard, UiSwitch, UiTabs, relativeTime, type TabItem } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

const { theme, layout, session, push, toasts, identity, account } = useStores();
const signOut = useSignOut();
const section = useParamChoice('section', SettingsSection, 'appearance');

const isAdmin = computed(() => session.user.value?.role === 'admin');
/** The sections; the hub's own settings are for admins. */
const tabs = computed<readonly TabItem<SettingsSection>[]>(() => [
  { value: 'appearance', label: 'Appearance' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'account', label: 'Account' },
  ...(isAdmin.value ? [{ value: 'hub' as const, label: 'Hub' }] : []),
]);

/** Where each section's settings apply. */
const WHERE = {
  appearance: 'These apply on this device.',
  notifications: 'These apply on this device.',
  account: 'Your account on this hub.',
  hub: 'These apply to everyone on this hub.',
} as const satisfies Record<SettingsSection, string>;

/** What the push card says for each state. */
const PUSH_TEXT = {
  unsupported: "This browser can't show notifications from the hub here. They need a secure page (https or localhost).",
  off: 'Get a notification when something needs you while the app is closed.',
  on: 'This device gets a notification when something needs you.',
  blocked: 'Notifications are blocked for this site. Allow them in the browser’s site settings, then turn them on here.',
} as const satisfies Record<PushState, string>;

const collapsed = computed({ get: () => layout.collapsed, set: (value: boolean) => { layout.collapsed = value; } });
const groupRuns = computed({ get: () => layout.groupRuns, set: (value: boolean) => { layout.groupRuns = value; } });
const user = session.user;
const pushOn = computed({
  get: () => push.state.value === 'on',
  set: (on: boolean) => { void (on ? push.enable().then((ok) => { if (ok) { toasts.ok('Notifications on'); } }) : push.disable()); },
});

const now = useNow(60_000);
/** How you sign in and your groups, from the hub. */
const mine = computed(() => account.view.value.value);

onMounted(() => { void push.check(); });
watch(section, (current) => { if (current === 'account') void account.load(); }, { immediate: true });

async function rename(name: string | null): Promise<void> {
  const outcome = await identity.rename(name);
  if (outcome.ok) { toasts.ok(name === null ? 'Back to the default name' : 'Hub name saved'); }
}
</script>

<template>
  <AppPage title="Settings" :description="WHERE[section]">
    <UiTabs v-model="section" :tabs="tabs" label="Settings sections">
      <template #default="{ value }">
        <div v-if="value === 'appearance'" class="stack">
          <UiCard title="Theme" subtitle="Follow your device, or pick one.">
            <ThemePicker v-model="theme.choice.value" />
          </UiCard>
          <UiCard title="Layout">
            <UiSwitch v-model="collapsed" label="Compact sidebar" description="Show only icons in the sidebar on wide screens." />
          </UiCard>
          <UiCard title="Chat">
            <UiSwitch
              v-model="groupRuns" label="Group fn calls" description="Fn calls made one after another fold into one section that lists them by fn, the latest first."
              data-testid="group-runs-switch"
            />
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
        <div v-else-if="value === 'hub' && isAdmin" class="stack">
          <HubNameCard
            :name="identity.name.value" :source="identity.source.value" :busy="identity.saving.busy.value" :problem="identity.saving.problem.value" @save="rename"
          />
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
            <dl v-if="mine" class="facts" data-testid="account-facts">
              <dt>Signs in with</dt>
              <dd>
                <span v-if="mine.identities.length === 0 && !mine.password" class="dim">Nothing yet</span>
                <span v-for="way in mine.identities" :key="way.provider" class="way">
                  {{ way.label }}<span class="dim"> · last {{ relativeTime(way.lastSignInAt, now) }}</span>
                </span>
                <span v-if="mine.password" class="way">{{ mine.breakGlass ? 'Break-glass password' : 'Password' }}</span>
              </dd>
              <dt>Groups</dt>
              <dd>
                <span v-if="mine.groups.length === 0" class="dim">None</span>
                <UiBadge v-for="group in mine.groups" :key="group.id" :title="group.synced ? 'From your sign-in provider' : 'Set by an admin'">{{ group.name }}</UiBadge>
              </dd>
            </dl>
            <p v-if="mine && mine.groups.some((g) => g.synced)" class="dim note">Groups from your sign-in provider update each time you sign in.</p>
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
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--space-2) var(--space-4); margin: var(--space-4) 0 0; font-size: var(--text-sm); }
.facts dt { color: var(--text-dim); }
.facts dd { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); min-width: 0; margin: 0; }
.way { overflow-wrap: anywhere; }
.dim { color: var(--text-dim); }
.note { margin: var(--space-2) 0 0; font-size: var(--text-xs); }
@media (max-width: 420px) { .facts { grid-template-columns: minmax(0, 1fr); } .facts dt { margin-top: var(--space-1); } }
</style>
