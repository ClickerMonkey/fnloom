<script setup lang="ts">
/**
 * A per-person system's page (`/connect/<system>`, a calendar): connect your own account, then choose the settings,
 * which of its fns the chat may use and which ask you first, and, on a hub with more than one person, who else may
 * use it. Until an admin has configured the system the page says so. An instance-scoped system (build 9: MCP servers,
 * API services) lists its instances instead, each connected to on its own card. The hub's redirect back from the
 * provider lands here, with `?problem=` when connecting failed.
 */
import { SystemName, type ConnectionFnOption, type ConnectionView, type Json, type ShareRule } from '@harness/core';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import ConnectionFns from '../connect/ConnectionFns.vue';
import ConnectionSettingsPicks from '../connect/ConnectionSettingsPicks.vue';
import InstanceConnectCard from '../connect/InstanceConnectCard.vue';
import { fnRows, instanceCards, pageConnections, pageIcon, settingsPicks, STATUS_WORDS, withFnOption, type InstanceCard } from '../connect/logic.ts';
import GinForm from '../gin/GinForm.vue';
import { useStores } from '../state/stores.ts';
import { UiBadge, UiBanner, UiButton, UiCard, UiEmpty, UiIcon, UiSkeleton, UiVisibility, relativeTime } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

const { chat, session, toasts } = useStores();
const store = chat.connections;
const route = useRoute();
const router = useRouter();
const now = useNow();
const problem = useRouteQuery(ROUTES.connect).text('problem');

const system = computed(() => { const read = SystemName.safeParse(route.params['system']); return read.success ? read.data : undefined; });
const page = computed(() => (system.value === undefined ? undefined : store.page(system.value)));
/** Build 9: the page of an instance-scoped system, connected to an instance at a time. */
const scoped = computed(() => page.value?.decl.scope === 'instance');
const mine = computed(() => (page.value === undefined || scoped.value ? undefined : pageConnections(page.value, session.user.value?.id)));
const own = computed(() => mine.value?.own);
const connected = computed(() => own.value?.status === 'connected');
const rows = computed(() => (page.value === undefined ? [] : fnRows(page.value, own.value)));
const isAdmin = computed(() => session.user.value?.role === 'admin');
const cards = computed(() => (page.value === undefined ? [] : instanceCards(page.value, session.user.value?.id, isAdmin.value)));
/** The account's detail and how long it has been connected, in one line. */
const accountDetail = computed(() => (own.value === undefined ? '' : [own.value.account?.detail, `since ${relativeTime(own.value.createdAt, now.value)}`].filter((part) => part !== undefined && part !== '').join(' · ')));
/** The settings as pickers over the account's own values (its calendars), when it offered them. */
const picks = computed(() => (page.value === undefined ? undefined : settingsPicks(page.value.decl.settings, own.value?.account?.choices)));
const formFlow = computed(() => (page.value?.decl.how.flow === 'form' ? page.value.decl.how.form : undefined));

/** What each fn does and who shared a connection, read from the pickers once the page knows them. */
const hints = ref<Readonly<Record<string, string>>>({});
const owners = ref<Readonly<Record<string, string>>>({});
watch(rows, async (list) => {
  if (list.length === 0) { return; }
  const found = await chat.pickers.source('fn').label(list.map((r) => r.name)).catch(() => []);
  hints.value = Object.fromEntries(found.flatMap((o) => (o.hint === undefined || o.missing === true ? [] : [[o.value, o.hint]])));
}, { immediate: true });
watch(() => [...(mine.value?.shared ?? []), ...cards.value.flatMap((card) => card.shared)], async (list: readonly ConnectionView[]) => {
  if (list.length === 0) { return; }
  const found = await chat.pickers.people().label(list.map((c) => c.owner)).catch(() => []);
  owners.value = Object.fromEntries(found.map((o) => [o.value, o.label]));
}, { immediate: true });

onMounted(() => {
  void store.load(store.pages.value.value !== undefined);
  void chat.access.load();
});

async function connect(form?: Json, card?: InstanceCard): Promise<void> {
  if (system.value === undefined) { return; }
  const started = await store.connect(system.value, form, card?.instance);
  if (!started.ok) { return; }
  if ('url' in started.value) { window.location.assign(started.value.url); return; }
  problem.value = '';
  toasts.ok('Connected');
}

async function disconnect(connection: ConnectionView | undefined = own.value): Promise<void> {
  if (connection === undefined) { return; }
  const done = await store.disconnect(connection.id);
  if (done.ok) { toasts.ok('Disconnected', 'Its credentials were deleted.'); }
}

async function setFn(local: string, change: Partial<ConnectionFnOption>): Promise<void> {
  if (own.value === undefined) { return; }
  await store.update({ connection: own.value.id, fns: withFnOption(rows.value, local, change) });
}

async function saveSettings(settings: Json, quiet = false): Promise<void> {
  if (own.value === undefined) { return; }
  const done = await store.update({ connection: own.value.id, settings });
  if (done.ok && !quiet) { toasts.ok('Settings saved'); }
}

const share = computed({
  get: (): ShareRule | undefined => own.value?.share,
  set: (next: ShareRule | undefined) => { if (next !== undefined && own.value !== undefined) { void store.update({ connection: own.value.id, share: next }); } },
});
</script>

<template>
  <AppPage :title="page?.decl.title ?? 'Connect'" :description="page?.decl.description ?? ''" keep-title>
    <UiSkeleton v-if="page === undefined && store.pages.loading.value" :lines="6" />
    <UiBanner v-else-if="store.pages.problem.value !== '' && page === undefined" tone="danger">{{ store.pages.problem.value }}</UiBanner>
    <UiEmpty v-else-if="page === undefined" icon="link" title="Nothing to connect here" body="No system offers this page." />
    <div v-else class="connect" data-testid="connect-page">
      <UiBanner v-if="problem !== ''" tone="danger" data-testid="connect-problem">
        Connecting didn't work: {{ problem }}
        <template #actions><UiButton size="sm" variant="ghost" @click="problem = ''">Dismiss</UiButton></template>
      </UiBanner>
      <UiBanner v-if="!page.ready" tone="warn" data-testid="connect-not-ready">
        An admin hasn't set up {{ page.decl.title }} yet. Once they add its sign-in details, you can connect here.
        <template v-if="isAdmin" #actions>
          <UiButton size="sm" data-testid="connect-configure" @click="router.push(links.system(page.system, 'config'))">Set it up</UiButton>
        </template>
      </UiBanner>

      <UiCard v-if="scoped" :title="`${page.decl.title} to connect`" subtitle="Each has its own sign-in; its fns act as you once you connect." compact flush data-testid="connection-instances">
        <ul v-if="cards.length > 0" class="instances">
          <InstanceConnectCard
            v-for="card in cards" :key="card.instance" :card="card" :owners="owners" :busy="store.saving.busy.value"
            @connect="connect($event, card)" @disconnect="disconnect(card.own)"
          />
        </ul>
        <p v-else class="none">Nothing has been added yet.</p>
        <p v-if="store.saving.problem.value !== ''" class="problem pad" role="alert">{{ store.saving.problem.value }}</p>
      </UiCard>

      <UiCard v-else class="account" compact data-testid="connection-account">
        <div class="account-row">
          <span class="mark" aria-hidden="true"><UiIcon :name="pageIcon(page)" :size="20" /></span>
          <div class="who">
            <template v-if="own !== undefined">
              <span class="label">{{ own.account?.label ?? 'Your account' }}</span>
              <span class="detail">
                <UiBadge :tone="STATUS_WORDS[own.status].tone" dot>{{ STATUS_WORDS[own.status].label }}</UiBadge>
                <span>{{ accountDetail }}</span>
              </span>
            </template>
            <template v-else>
              <span class="label">Not connected</span>
              <span class="detail">Connect your own account; nobody else sees it unless you share it.</span>
            </template>
          </div>
          <div class="actions">
            <UiButton
              v-if="formFlow === undefined && !connected" variant="primary" icon="link" :disabled="!page.ready" :loading="store.saving.busy.value"
              data-testid="connect-start" @click="connect()"
            >
              {{ own === undefined ? 'Connect' : 'Reconnect' }}
            </UiButton>
            <UiButton v-if="own !== undefined" variant="ghost" icon="x" :loading="store.saving.busy.value" data-testid="connect-remove" @click="disconnect()">Disconnect</UiButton>
          </div>
        </div>
        <p v-if="own?.problem" class="problem">{{ own.problem }}</p>
        <GinForm
          v-if="formFlow !== undefined && !connected && page.ready" :type="formFlow" submit-label="Connect" :busy="store.saving.busy.value" :cancellable="false" label="Sign-in"
          @submit="connect($event)"
        />
        <p v-if="store.saving.problem.value !== ''" class="problem" role="alert">{{ store.saving.problem.value }}</p>
        <ul v-if="(mine?.shared.length ?? 0) > 0" class="shared" aria-label="Shared with you">
          <li v-for="other in mine?.shared ?? []" :key="other.id">
            <UiIcon name="users" :size="14" /> {{ other.account?.label ?? 'An account' }} · shared by {{ owners[other.owner] ?? 'someone' }}
          </li>
        </ul>
      </UiCard>

      <div v-if="!scoped" class="columns" :class="{ split: connected }">
        <UiCard title="What it may do" :subtitle="connected ? 'Fns that are off are hidden from the chat. Ask first waits for your approval each time.' : 'Connect first to change these.'" compact>
          <ConnectionFns :rows="rows" :hints="hints" :disabled="!connected || store.saving.busy.value" @change="setFn" />
        </UiCard>

        <div v-if="connected && own !== undefined" class="side">
          <UiCard title="Settings" compact>
            <ConnectionSettingsPicks v-if="picks !== undefined" :picks="picks" :settings="own.settings" @save="saveSettings($event, true)" />
            <GinForm v-else :key="own.id" :type="page.decl.settings" :initial="own.settings" submit-label="Save settings" :busy="store.saving.busy.value" :cancellable="false" label="Settings" @submit="saveSettings" />
          </UiCard>
          <UiCard v-if="chat.access.multiUser.value && share !== undefined" title="Sharing" subtitle="People you share with act as you through these fns." compact data-testid="connection-sharing">
            <UiVisibility v-model="share" :people="chat.pickers.people()" label="Who can use it" />
          </UiCard>
        </div>
      </div>
    </div>
  </AppPage>
</template>

<style scoped>
.connect { display: grid; gap: var(--space-4); min-width: 0; max-width: 72rem; container-type: inline-size; }
/* the switches beside the settings and sharing where there is room; one column on a phone */
.columns { display: grid; gap: var(--space-4); align-items: start; }
.side { display: grid; gap: var(--space-4); align-items: start; }
@container (min-width: 760px) { .columns.split { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); } }
.account-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.mark { display: grid; place-items: center; width: 2.5rem; height: 2.5rem; border-radius: var(--radius); background: var(--surface-2); color: var(--accent); flex: none; }
.who { display: grid; gap: 2px; flex: 1 1 12rem; min-width: 0; }
.label { font-weight: var(--weight-strong); overflow-wrap: anywhere; }
.detail { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); color: var(--text-dim); font-size: var(--text-sm); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.problem { margin: var(--space-2) 0 0; color: var(--danger); font-size: var(--text-sm); }
.shared { margin: var(--space-3) 0 0; padding: var(--space-2) 0 0; list-style: none; border-top: 1px solid var(--border); display: grid; gap: var(--space-1); color: var(--text-dim); font-size: var(--text-sm); }
.instances { display: grid; margin: 0; padding: 0; list-style: none; }
.instances > li + li { border-top: 1px solid var(--border); }
.none { margin: 0; padding: var(--space-3) var(--space-4); color: var(--text-dim); font-size: var(--text-sm); }
.pad { padding: 0 var(--space-4) var(--space-3); }
.shared li { display: flex; align-items: center; gap: var(--space-2); }
</style>
