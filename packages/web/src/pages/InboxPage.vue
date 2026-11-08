<script setup lang="ts">
/**
 * The inbox: every notification (or only the unread ones; the filter is in the URL), newest first, paged. Opening one
 * marks it read and goes where it leads. A push's click lands here with `?open=<id>`, which opens that notification
 * the same way once the list has it.
 */
import type { Notification } from '@harness/core';
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { ROUTES, notificationTarget } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import { OPEN_KEY } from '../state/push-payload.ts';
import NotificationList from '../components/inbox/NotificationList.vue';
import { InboxFilter } from '../state/inbox.ts';
import { useStores } from '../state/stores.ts';
import { UiButton, UiCard, UiTabs, type TabItem } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

const { inbox, toasts, chat } = useStores();
const router = useRouter();
const now = useNow();
const query = useRouteQuery(ROUTES.inbox);
const filter = query.choice('filter', InboxFilter, 'all');

const tabs = computed<readonly TabItem<InboxFilter>[]>(() => [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread', count: inbox.unread.value },
]);

watch(filter, (value) => { void inbox.load(value); }, { immediate: true });

const opening = query.text(OPEN_KEY);
watch([opening, inbox.items], ([id, items]) => {
  const found = id === '' ? undefined : items.find((n) => n.id === id);
  if (found !== undefined) { void open(found); }
}, { immediate: true });

async function open(notification: Notification): Promise<void> {
  if (!notification.read) { void inbox.markRead([notification.id]); }
  await router.push(await notificationTarget(notification.link, (run) => chat.sessionOfRun(run)));
}

async function readAll(): Promise<void> {
  if (await inbox.markAllRead()) { toasts.ok('All caught up'); }
}
</script>

<template>
  <AppPage title="Inbox" description="What needs you, and what happened while you were away.">
    <template #actions>
      <UiButton v-if="inbox.unread.value > 0" icon="check" data-testid="read-all" @click="readAll">Mark all read</UiButton>
    </template>
    <UiTabs v-model="filter" :tabs="tabs" label="Show" />
    <UiCard flush>
      <NotificationList
        :items="inbox.items.value" :now="now" :loading="inbox.loading.value" :loaded="inbox.loaded.value" :problem="inbox.problem.value"
        :has-more="inbox.hasMore.value" :loading-more="inbox.loadingMore.value"
        :empty-title="filter === 'unread' ? 'Nothing unread' : 'All caught up'"
        @open="open" @read="inbox.markRead([$event.id])" @more="inbox.loadMore()" @retry="inbox.load(filter)"
      />
    </UiCard>
  </AppPage>
</template>
