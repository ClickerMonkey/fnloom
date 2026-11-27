<script setup lang="ts">
/**
 * Settings, one URL per section: how the app looks on this device, installing it (and using it on a phone),
 * notifications on this device (web push), and the signed-in account; admins also get the hub's own settings. Each
 * section says where its settings apply. A page that isn't secure (http on another device) can't install the app
 * or turn on notifications, and the sections that need it say so.
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
import InstallCard from '../components/InstallCard.vue';
import PhoneCard from '../components/PhoneCard.vue';
import { UiAvatar, UiBadge, UiBanner, UiButton, UiCard, UiSwitch, UiTabs, relativeTime, type TabItem } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

const { theme, layout, session, push, toasts, identity, account, outsideImages, install, https } = useStores();
const signOut = useSignOut();
const section = useParamChoice('section', SettingsSection, 'appearance');

const isAdmin = computed(() => session.user.value?.role === 'admin');
/** The sections; the hub's own settings are for admins. */
const tabs = computed<readonly TabItem<SettingsSection>[]>(() => [
  { value: 'appearance', label: 'Appearance' },
  { value: 'app', label: 'App' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'account', label: 'Account' },
  ...(isAdmin.value ? [{ value: 'hub' as const, label: 'Hub' }] : []),
]);

/** Where each section's settings apply. */
const WHERE = {
  appearance: 'These apply on this device.',
  app: 'Install the app on this device, or use it on your phone.',
  notifications: 'These apply on this device.',
  account: 'Your account on this hub.',
  hub: 'These apply to everyone on this hub.',
} as const satisfies Record<SettingsSection, string>;

/** What a page that isn't secure can't do. */
const INSECURE = 'This page isn’t on a secure address, so the app can’t be installed here and notifications can’t be turned on. Open the hub’s secure address (https) instead: Settings › App shows how.';

/** What the admin's https switch says, by where the certificate comes from. */
const HTTPS_TEXT = {
  own: 'Other devices can open the hub at https on the same port, once they trust the hub’s own certificate (Settings › App shows how). Needed to install the app and get notifications on a phone. http keeps working.',
  files: 'Other devices can open the hub at https on the same port, with the certificate this hub was started with. http keeps working.',
} as const;

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
watch(section, (current) => {
  if (current === 'account') { void account.load(); }
  if (current === 'app' || current === 'hub') { void https.load(); }
}, { immediate: true });

/** Whether this page is secure (https, or this computer): installing and notifications need it. */
const secure = install.secure;

/** The admin's switch: https on the hub's port. */
const httpsOn = computed({
  get: () => https.view.value?.on ?? false,
  set: (on: boolean) => { void https.set(on).then((outcome) => { if (outcome.ok) { toasts.ok(on ? 'Secure address on' : 'Secure address off'); } }); },
});

async function installApp(): Promise<void> {
  if (await install.install() === 'accepted') { toasts.ok('Installed'); }
}

/** The admin's switch: outside images load at once (`always`) or wait for a click (`ask`, the default). */
const loadOutside = computed({
  get: () => outsideImages.value.value === 'always',
  set: (on: boolean) => { void outsideImages.set(on ? 'always' : 'ask').then((outcome) => { if (outcome.ok) { toasts.ok('Saved'); } }); },
});

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
        <div v-else-if="value === 'app'" class="stack">
          <UiBanner v-if="!secure" tone="warn" icon="shield" data-testid="insecure-banner">{{ INSECURE }}</UiBanner>
          <InstallCard :state="install.state.value" :name="identity.name.value" @install="installApp" />
          <PhoneCard :view="https.view.value" :authority="https.authority.value" :loading="https.loading.busy.value" :problem="https.loading.problem.value" />
        </div>
        <div v-else-if="value === 'notifications'" class="stack">
          <UiBanner v-if="!secure" tone="warn" icon="shield">{{ INSECURE }}</UiBanner>
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
          <UiCard title="Secure address (https)" data-testid="https-card">
            <UiSwitch
              v-model="httpsOn" label="Answer on a secure address" :disabled="https.saving.busy.value || https.view.value === undefined" data-testid="https-switch"
              :description="https.view.value?.source === 'files' ? HTTPS_TEXT.files : HTTPS_TEXT.own"
            />
            <UiBanner v-if="!secure" tone="warn" icon="shield">{{ INSECURE }}</UiBanner>
            <UiBanner v-if="https.saving.problem.value !== ''" tone="danger">{{ https.saving.problem.value }}</UiBanner>
          </UiCard>
          <UiCard title="Images in chats" data-testid="outside-images-card">
            <UiSwitch
              v-model="loadOutside" label="Load outside images" :disabled="outsideImages.saving.busy.value" data-testid="outside-images-switch"
              description="Show images from other sites at once. Off: each one waits for a click, so a message can't send data out just by being read."
            />
            <UiBanner v-if="outsideImages.saving.problem.value !== ''" tone="danger">{{ outsideImages.saving.problem.value }}</UiBanner>
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
