<script setup lang="ts">
/**
 * A page a system adds (item 9), at `/s/<system>/<page>/<path…>`. It finds the page among the live systems' pages
 * the hub lists for this person, loads the system's client build (once per build), and mounts the page's component with
 * its host (`PageHost`: the person, the hub client, the URL's query, links to the system's other pages and the app's
 * shared components) and its system's client. A link to a page whose system isn't installed and live, or that this
 * person can't use, keeps its URL and says so; it draws the page again as soon as the system comes back. A page that
 * fails while drawing shows the problem here instead of taking the app down.
 */
import { PAGE_HOST } from '@harness/sdk';
import { computed, onBeforeUnmount, onErrorCaptured, provide, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useLive } from '../app/live.ts';
import { links } from '../app/routes.ts';
import { openChat } from '../chat/state/open-chat.ts';
import { useStores } from '../state/stores.ts';
import { UiBanner, UiButton, UiEmpty, UiSkeleton, UiSpinner } from '../ui/index.ts';
import { missingPage, pageAddress, pageHost, queryValues, type PageHere } from './logic.ts';
import { ChatRuns, pageInbox } from './runs.ts';
import { PAGE_FORMAT, SHARED_COMPONENTS } from './shared.ts';

const { pages, chat, session, layout, toasts } = useStores();
const route = useRoute();
const router = useRouter();

const address = computed(() => pageAddress(route.params));
const entry = computed(() => (address.value === undefined ? undefined : pages.page(address.value.system, address.value.page)));
const listed = computed(() => pages.list.value.value);
const isAdmin = computed(() => session.user.value?.role === 'admin');

const here = (): PageHere => {
  const at = address.value;
  if (at === undefined) { throw new Error('a system page needs a system and a page in its URL'); }
  return { ...at, query: queryValues(route.query) };
};
const host = pageHost({
  here,
  navigate: (to, replace) => { void (replace ? router.replace(to) : router.push(to)); },
  resolve: (to) => router.resolve(to).href,
  user: () => {
    const user = session.user.value;
    if (user === undefined) { throw new Error('a system page is only drawn signed in'); }
    return user;
  },
  hub: pages.hub,
  components: SHARED_COMPONENTS,
  openChat: async (start) => { await openChat({ chat, push: (to) => router.push(to) }, start); },
  runs: (options) => new ChatRuns(chat, options),
  inbox: pageInbox(chat.approvals),
  notify: { ok: (title, detail) => { toasts.ok(title, detail); }, error: (title, detail) => { toasts.error(title, detail); } },
  format: PAGE_FORMAT,
  live: useLive,
  chatHref: (id) => router.resolve(links.session(id)).href,
  goChat: (id) => { void router.push(links.session(id)); },
  runHref: (run) => router.resolve(links.run(run)).href,
  goRun: (run) => { void router.push(links.run(run)); },
});
provide(PAGE_HOST, host);

// the list is read with the nav when signed in; a page opened first (a shared link) reads it itself
if (listed.value === undefined && !pages.list.loading.value) { void pages.load(); }

// the system's client build: loaded once per build hash, again when a newer build is listed
watch(() => entry.value?.client.hash, () => {
  const page = entry.value;
  if (page !== undefined) { void chat.renderers.sync([{ system: page.system, url: page.client.url, hash: page.client.hash }]); }
}, { immediate: true });
const build = computed(() => (entry.value === undefined ? undefined : chat.renderers.status.value.get(entry.value.system)));

/** The page's component and props, once its build is loaded. */
const mount = computed(() => {
  const at = address.value;
  const page = entry.value;
  if (at === undefined || page === undefined || session.user.value === undefined) { return undefined; }
  return chat.renderers.pageView(page.system, page.segment, { path: at.path, host });
});

const missing = computed(() => (address.value === undefined ? undefined : missingPage(address.value, listed.value ?? [])));

// the tab and the top bar take the page's own title
watch(() => entry.value?.title, (title) => { layout.pageTitle.value = title; }, { immediate: true });
onBeforeUnmount(() => { if (layout.pageTitle.value === entry.value?.title) { layout.pageTitle.value = undefined; } });

/** What the page threw while drawing, shown instead of it. */
const crashed = shallowRef('');
watch(() => route.fullPath, () => { crashed.value = ''; });
onErrorCaptured((error) => {
  console.error('system-page.failed', { system: address.value?.system, page: address.value?.page, error });
  crashed.value = error instanceof Error ? error.message : String(error);
  return false;
});
</script>

<template>
  <div class="system-page" data-testid="system-page">
    <div v-if="listed === undefined && pages.list.problem.value === ''" class="waiting" data-testid="system-page-loading">
      <UiSkeleton :lines="6" />
    </div>
    <div v-else-if="listed === undefined" class="centre">
      <UiBanner tone="danger">
        {{ pages.list.problem.value }}
        <template #actions><UiButton size="sm" @click="pages.load()">Retry</UiButton></template>
      </UiBanner>
    </div>
    <div v-else-if="entry === undefined" class="centre" data-testid="system-page-missing">
      <UiEmpty icon="server" :title="missing?.title ?? 'Nothing here'" :body="missing?.body ?? ''">
        <template #actions>
          <UiButton v-if="isAdmin" variant="primary" icon="server" @click="router.push(links.systems())">Systems</UiButton>
          <UiButton :variant="isAdmin ? 'secondary' : 'primary'" icon="arrow-right" @click="router.push(links.chat())">Go to chat</UiButton>
        </template>
      </UiEmpty>
    </div>
    <div v-else-if="build === 'failed'" class="centre" data-testid="system-page-failed">
      <UiEmpty icon="error" tone="danger" :title="`Couldn’t load ${entry.title}`" :body="`${entry.system}’s client build didn’t load. Reload the page, or ask an admin to look at the system.`" />
    </div>
    <div v-else-if="crashed !== ''" class="centre" data-testid="system-page-crashed">
      <UiEmpty icon="error" tone="danger" :title="`${entry.title} stopped working`" :body="crashed">
        <template #actions><UiButton variant="primary" @click="crashed = ''">Try again</UiButton></template>
      </UiEmpty>
    </div>
    <component :is="mount.component" v-else-if="mount !== undefined" v-bind="mount.props" :key="`${entry.system}/${entry.segment}`" />
    <div v-else-if="build === 'loading' || build === undefined" class="centre" data-testid="system-page-loading">
      <UiSpinner :size="24" :label="`Loading ${entry.title}`" />
    </div>
    <div v-else class="centre" data-testid="system-page-missing">
      <UiEmpty icon="server" title="No such page" :body="`${entry.system}’s client build has no page called “${entry.segment}”.`" />
    </div>
  </div>
</template>

<style scoped>
.system-page { min-height: 100%; display: flex; flex-direction: column; }
.system-page > * { flex: 1 1 auto; min-width: 0; }
.waiting { padding: var(--space-5); max-width: 960px; width: 100%; margin: 0 auto; }
.centre { display: grid; place-items: center; padding: var(--space-5); }
</style>
