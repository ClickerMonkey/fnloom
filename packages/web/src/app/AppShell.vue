<script setup lang="ts">
/**
 * The app's frame. Wide screens: the sidebar (collapsible to icons) beside the page. Narrow screens: a top bar, with
 * the sidebar in a drawer. It wires the stores to the shell's parts: the bell and its inbox popover, the connection
 * banner, toasts, the tab title, keeping the session fresh, and sending you to sign-in when it ends.
 *
 * Installed on a desktop with its own title bar (`window-controls-overlay`), a thin bar with the hub's name runs
 * along the top beside the window's buttons and drags the window; on phones the shell keeps clear of the notch and
 * the rounded corners (the safe areas).
 */
import type { Notification } from '@harness/core';
import { computed, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import InboxPanel from '../components/inbox/InboxPanel.vue';
import InstallSheet from '../components/InstallSheet.vue';
import { COMPACT_QUERY } from '../state/layout.ts';
import type { NoticeVia } from '../state/push-payload.ts';
import { useStores } from '../state/stores.ts';
import { UiBanner, UiModal, UiPopover, UiToaster, useMediaQuery } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';
import AppSidebar from './AppSidebar.vue';
import AppTopBar from './AppTopBar.vue';
import { navEntries } from './nav.ts';
import { useSignOut } from './signOut.ts';
import { showFavicon } from './favicon.ts';
import { tabTitle } from './title.ts';
import { links, noticeTarget, ROUTES } from './routes.ts';

const { session, identity, keeper, layout, toasts, inbox, connection, admin, chat, pages, outsideImages, install } = useStores();
const signOut = useSignOut();
const route = useRoute();
const router = useRouter();
const compact = useMediaQuery(COMPACT_QUERY);
const now = useNow();

const signedIn = session.signedIn;
const bare = computed(() => route.meta.bare === true || !signedIn.value);
const entries = computed(() => navEntries(route, session.user.value, { inbox: inbox.unread.value, admin: admin.systems.pending.value }, chat.connections.nav.value, pages.nav.value));
/**
 * The page's name: the one thing a detail page is about (`fs`) when it says, else the route's; a connect page takes its
 * system's ("Calendar") once the nav knows it.
 */
const title = computed(() => {
  if (layout.pageTitle.value !== undefined) { return layout.pageTitle.value; }
  const page = route.name === ROUTES.connect ? chat.connections.nav.value.find((entry) => entry.system === route.params['system']) : undefined;
  return page?.title ?? route.meta.title ?? identity.name.value;
});
/** A page with its own header (an open chat) takes the whole height on a compact screen: one header, not two. */
const topBar = computed(() => compact.value && route.meta.ownHeader !== true);
const inboxOpen = shallowRef(false);
const inboxAnchor = shallowRef<HTMLElement | null>(null);

// staying signed in, and leaving when the session ends (the router's guard handles arriving signed out)
watch(signedIn, (isIn, was) => {
  // the hub's name: the sign-in page shows it too, and asking again on sign-in picks up a rename made meanwhile
  void identity.load();
  if (isIn) {
    keeper.start();
    // renames show live while signed in
    identity.start();
    inbox.start();
    // the per-person systems' pages (a calendar to connect) join the nav
    void chat.connections.load(true);
    // the live systems' pages join the nav, and come and go with their systems
    pages.start();
    void pages.load(true);
    // whether chats load images from outside the hub at once (the admin's setting)
    void outsideImages.load();
    return;
  }
  pages.clear();
  outsideImages.clear();
  keeper.stop();
  inbox.stop();
  identity.stop();
  if (was === true && route.meta.public !== true) { void router.replace(links.signIn(route.fullPath)); }
}, { immediate: true });

// the tab says how many things need you, in its title and with a dot on its icon; the hub's name ends it
watch([title, inbox.unread, identity.name], ([page, unread, name]) => {
  document.title = tabTitle(page, unread, name);
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

/** Open a notification where it leads: its main link, or its second (`also`). */
async function openNotification(notification: Notification, via: NoticeVia = 'link'): Promise<void> {
  inboxOpen.value = false;
  if (!notification.read) { void inbox.markRead([notification.id]); }
  await router.push(await noticeTarget(notification, (run) => chat.sessionOfRun(run), via));
}

/** **Install app** from the person's menu: the browser's prompt, or the iPhone sheet. */
async function installApp(): Promise<void> {
  layout.drawerOpen.value = false;
  if (await install.install() === 'accepted') { toasts.ok('Installed'); }
}

async function readAll(): Promise<void> {
  if (await inbox.markAllRead()) { toasts.ok('All caught up'); }
}
</script>

<template>
  <div class="shell" :class="{ bare, compact, 'no-bar': compact && !topBar, collapsed: !compact && layout.collapsed }">
    <div class="titlebar" aria-hidden="true" data-testid="titlebar"><span class="titlebar-name">{{ identity.name.value }}</span></div>
    <template v-if="!bare">
      <AppSidebar
        v-if="!compact" class="side" :brand="identity.name.value" :entries="entries" :user="session.user.value" :unread="inbox.unread.value" :collapsed="layout.collapsed" :installable="install.offered"
        @toggle="layout.toggleSidebar()" @inbox="openInbox" @settings="router.push(links.settings())" @sign-out="signOut" @install="installApp"
      />
      <AppTopBar v-else-if="topBar" :title="title" :unread="inbox.unread.value" @menu="layout.drawerOpen.value = true" @inbox="openInbox" />
      <UiModal v-if="compact" v-model:open="layout.drawerOpen.value" placement="left" label="Navigation" width="300px">
        <AppSidebar
          :brand="identity.name.value" :entries="entries" :user="session.user.value" :unread="inbox.unread.value" :collapsible="false" :installable="install.offered"
          @inbox="openInbox" @settings="router.push(links.settings())" @sign-out="signOut" @navigate="layout.drawerOpen.value = false" @install="installApp"
        />
      </UiModal>
    </template>

    <main class="page" :aria-busy="inbox.loading.value ? 'true' : undefined">
      <div v-if="!bare && connection.state.value !== 'online'" class="connection" data-testid="connection-banner">
        <UiBanner :tone="connection.state.value === 'offline' ? 'warn' : 'ok'" :icon="connection.state.value === 'offline' ? 'offline' : 'success'">
          {{ connection.state.value === 'offline' ? 'Reconnecting to the hub…' : 'Back online' }}
        </UiBanner>
      </div>
      <!-- no <Transition mode="out-in"> here: a route change during its leave unmounted a page Vue had already let go
           of ("Cannot destructure property 'bum'"); the new page fades in by itself (`.routed`'s animation) -->
      <RouterView v-slot="{ Component, route: shown }">
        <component :is="Component" :key="shown.meta.group ?? shown.matched[0]?.path ?? shown.path" class="routed" />
      </RouterView>
    </main>

    <UiPopover v-model:open="inboxOpen" :anchor="inboxAnchor" :side="compact ? 'bottom' : 'right'" align="start" label="Notifications">
      <InboxPanel
        :items="inbox.items.value" :unread="inbox.unread.value" :now="now" :loading="inbox.loading.value" :loaded="inbox.loaded.value"
        :problem="inbox.problem.value" @open="openNotification($event)" @also="openNotification($event, 'also')" @read="inbox.markRead([$event.id])" @read-all="readAll"
        @all="router.push(links.inbox())" @retry="inbox.load('all')"
      />
    </UiPopover>
    <InstallSheet v-model:open="install.sheetOpen.value" :name="identity.name.value" />
    <UiToaster :toasts="toasts.items" @dismiss="toasts.dismiss($event)" @action="toasts.act($event)" @hold="toasts.hold($event)" @release="toasts.release($event)" />
  </div>
</template>

<style scoped>
.shell {
  display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); height: 100vh; height: 100dvh;
  transition: grid-template-columns var(--slow) var(--ease);
}
/* the safe areas at the sides (a phone held sideways) */
.shell { box-sizing: border-box; padding-left: var(--safe-left); padding-right: var(--safe-right); }
/* installed with its own title bar: the bar drags the window, the shell starts below it */
.titlebar { display: none; }
@media (display-mode: window-controls-overlay) {
  .shell { padding-top: env(titlebar-area-height, 0px); }
  .titlebar {
    position: fixed; z-index: var(--z-sticky); top: env(titlebar-area-y, 0px); left: env(titlebar-area-x, 0px); display: flex; align-items: center;
    width: env(titlebar-area-width, 100%); height: env(titlebar-area-height, 0px); padding: 0 var(--space-3); background: var(--surface); border-bottom: 1px solid var(--border);
    color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-medium); app-region: drag; -webkit-app-region: drag; user-select: none;
  }
  .titlebar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.shell.collapsed { grid-template-columns: var(--sidebar-collapsed) minmax(0, 1fr); }
.shell.compact { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
.shell.compact.no-bar { grid-template-rows: minmax(0, 1fr); }
.shell.bare { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
.side { border-right: 1px solid var(--border); }
/* the banner's height comes out of the page's: the page below it shrinks (and scrolls) instead of being pushed off screen */
.page { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; }
.connection { grid-row: 1; z-index: var(--z-sticky); padding: var(--space-2) var(--space-4); }
.routed { grid-row: 2; position: relative; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; animation: page-in var(--medium) var(--ease); }
@keyframes page-in { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) { .routed { animation: none; } }
</style>
