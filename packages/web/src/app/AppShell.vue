<script setup lang="ts">
/**
 * The app's frame. Wide screens: the sidebar (collapsible to icons) beside the page. Narrow screens: a top bar, with
 * the sidebar in a drawer. It wires the stores to the shell's parts: the bell and its inbox popover, the connection
 * banner, toasts, the tab title, keeping the session fresh, and sending you to sign-in when it ends.
 */
import type { Notification } from '@harness/core';
import { computed, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import InboxPanel from '../components/inbox/InboxPanel.vue';
import { COMPACT_QUERY } from '../state/layout.ts';
import { useStores } from '../state/stores.ts';
import { UiBanner, UiModal, UiPopover, UiToaster, useMediaQuery } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';
import AppSidebar from './AppSidebar.vue';
import AppTopBar from './AppTopBar.vue';
import { navEntries } from './nav.ts';
import { useSignOut } from './signOut.ts';
import { showFavicon } from './favicon.ts';
import { links, notificationTarget } from './routes.ts';

const { session, keeper, layout, toasts, inbox, connection, admin, chat } = useStores();
const signOut = useSignOut();
const route = useRoute();
const router = useRouter();
const compact = useMediaQuery(COMPACT_QUERY);
const now = useNow();

const signedIn = session.signedIn;
const bare = computed(() => route.meta.bare === true || !signedIn.value);
const entries = computed(() => navEntries(route, session.user.value, { inbox: inbox.unread.value, admin: admin.systems.pending.value }));
const title = computed(() => route.meta.title ?? 'Harness');
/** A page with its own header (an open chat) takes the whole height on a compact screen: one header, not two. */
const topBar = computed(() => compact.value && route.meta.ownHeader !== true);
const inboxOpen = shallowRef(false);
const inboxAnchor = shallowRef<HTMLElement | null>(null);

// staying signed in, and leaving when the session ends (the router's guard handles arriving signed out)
watch(signedIn, (isIn, was) => {
  if (isIn) {
    keeper.start();
    inbox.start();
    return;
  }
  keeper.stop();
  inbox.stop();
  if (was === true && route.meta.public !== true) { void router.replace(links.signIn(route.fullPath)); }
}, { immediate: true });

// the tab says how many things need you, in its title and with a dot on its icon
watch([title, inbox.unread], ([page, unread]) => {
  document.title = `${unread > 0 ? `(${unread > 99 ? '99+' : unread}) ` : ''}${page} · Harness`;
  showFavicon(document, unread > 0);
}, { immediate: true });

// the drawer and the popover close when the page changes
watch(() => route.fullPath, () => {
  layout.drawerOpen.value = false;
  inboxOpen.value = false;
});

function openInbox(anchor: HTMLElement): void {
  if (inboxOpen.value && inboxAnchor.value === anchor) { inboxOpen.value = false; return; }
  inboxAnchor.value = anchor;
  layout.drawerOpen.value = false;
  inboxOpen.value = true;
  void inbox.load('all');
}

async function openNotification(notification: Notification): Promise<void> {
  inboxOpen.value = false;
  if (!notification.read) { void inbox.markRead([notification.id]); }
  await router.push(await notificationTarget(notification.link, (run) => chat.sessionOfRun(run)));
}

async function readAll(): Promise<void> {
  if (await inbox.markAllRead()) { toasts.ok('All caught up'); }
}
</script>

<template>
  <div class="shell" :class="{ bare, compact, 'no-bar': compact && !topBar, collapsed: !compact && layout.collapsed }">
    <template v-if="!bare">
      <AppSidebar
        v-if="!compact" class="side" :entries="entries" :user="session.user.value" :unread="inbox.unread.value" :collapsed="layout.collapsed"
        @toggle="layout.toggleSidebar()" @inbox="openInbox" @settings="router.push(links.settings())" @sign-out="signOut"
      />
      <AppTopBar v-else-if="topBar" :title="title" :unread="inbox.unread.value" @menu="layout.drawerOpen.value = true" @inbox="openInbox" />
      <UiModal v-if="compact" v-model:open="layout.drawerOpen.value" placement="left" label="Navigation" width="300px">
        <AppSidebar
          :entries="entries" :user="session.user.value" :unread="inbox.unread.value" :collapsible="false"
          @inbox="openInbox" @settings="router.push(links.settings())" @sign-out="signOut" @navigate="layout.drawerOpen.value = false"
        />
      </UiModal>
    </template>

    <main class="page" :aria-busy="inbox.loading.value ? 'true' : undefined">
      <div v-if="!bare && connection.state.value !== 'online'" class="connection" data-testid="connection-banner">
        <UiBanner :tone="connection.state.value === 'offline' ? 'warn' : 'ok'" :icon="connection.state.value === 'offline' ? 'offline' : 'success'">
          {{ connection.state.value === 'offline' ? 'Reconnecting to the hub…' : 'Back online' }}
        </UiBanner>
      </div>
      <RouterView v-slot="{ Component, route: shown }">
        <Transition name="page" mode="out-in">
          <component :is="Component" :key="shown.meta.group ?? shown.matched[0]?.path ?? shown.path" />
        </Transition>
      </RouterView>
    </main>

    <UiPopover v-model:open="inboxOpen" :anchor="inboxAnchor" :side="compact ? 'bottom' : 'right'" align="start" label="Notifications">
      <InboxPanel
        :items="inbox.items.value" :unread="inbox.unread.value" :now="now" :loading="inbox.loading.value" :loaded="inbox.loaded.value"
        :problem="inbox.problem.value" @open="openNotification" @read="inbox.markRead([$event.id])" @read-all="readAll"
        @all="router.push(links.inbox())" @retry="inbox.load('all')"
      />
    </UiPopover>
    <UiToaster :toasts="toasts.items" @dismiss="toasts.dismiss($event)" @action="toasts.act($event)" @hold="toasts.hold($event)" @release="toasts.release($event)" />
  </div>
</template>

<style scoped>
.shell {
  display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); height: 100vh; height: 100dvh;
  transition: grid-template-columns var(--slow) var(--ease);
}
.shell.collapsed { grid-template-columns: var(--sidebar-collapsed) minmax(0, 1fr); }
.shell.compact { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
.shell.compact.no-bar { grid-template-rows: minmax(0, 1fr); }
.shell.bare { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
.side { border-right: 1px solid var(--border); }
.page { position: relative; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.connection { position: sticky; top: 0; z-index: var(--z-sticky); padding: var(--space-2) var(--space-4) 0; }
.page-enter-active, .page-leave-active { transition: opacity var(--fast) var(--ease), transform var(--medium) var(--ease); }
.page-enter-from { opacity: 0; transform: translateY(6px); }
.page-leave-to { opacity: 0; }
</style>
