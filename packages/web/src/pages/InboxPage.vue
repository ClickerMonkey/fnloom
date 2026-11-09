<script setup lang="ts">
/**
 * The inbox: every notification (or only the unread ones), searched and sorted by the hub (both in the URL), paged. Opening one
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
import ListSearch from '../components/query/ListSearch.vue';
import { InboxFilter } from '../state/inbox.ts';
import { hubListQuery, useListQuery } from '../state/query.ts';
import { useStores } from '../state/stores.ts';
import { UiButton, UiCard, UiSegmented } from '../ui/index.ts';
import type { SegmentOption } from '../ui/types.ts';
import { useNow } from '../ui/now.ts';

const { inbox, toasts, chat } = useStores();
const router = useRouter();
const now = useNow();
const query = useRouteQuery(ROUTES.inbox);
const filter = query.choice('filter', InboxFilter, 'all');
const search = useListQuery('notifications');
const hubQuery = computed(() => hubListQuery(search.value));

const shows = computed<readonly SegmentOption<InboxFilter>[]>(() => [
  { value: 'all', label: 'All' },
  { value: 'unread', label: inbox.unread.value > 0 ? `Unread ${inbox.unread.value}` : 'Unread' },
]);

// keyed by the written query, so a route change that leaves the search alone (`?open=`) doesn't reload
watch([filter, () => JSON.stringify(hubQuery.value)], ([value]) => { void inbox.load(value, hubQuery.value); }, { immediate: true });

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
    <ListSearch v-model="search" list="notifications" label="notifications" :count="inbox.items.value.length" :more="inbox.hasMore.value" :partial="inbox.partial.value">
      <UiSegmented v-model="filter" :options="shows" label="Show" data-testid="inbox-filter" />
    </ListSearch>
    <UiCard flush>
      <NotificationList
        :items="inbox.items.value" :now="now" :loading="inbox.loading.value" :loaded="inbox.loaded.value" :problem="inbox.problem.value"
        :has-more="inbox.hasMore.value" :loading-more="inbox.loadingMore.value"
        :empty-title="Object.keys(hubQuery).length > 0 ? 'Nothing matches' : filter === 'unread' ? 'Nothing unread' : 'All caught up'"
        @open="open" @read="inbox.markRead([$event.id])" @more="inbox.loadMore()" @retry="inbox.load(filter, hubQuery)"
      />
    </UiCard>
  </AppPage>
</template>
