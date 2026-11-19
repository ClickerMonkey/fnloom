<script setup lang="ts">
/**
 * The Data page (build 8): the stored types the person sees (`/data`), grouped by system, each with how it keeps its
 * records and how many there are, searched by words in the URL (`q`) and opening its records; and the saved widgets
 * (`/data/widgets`), each opened in a new chat, where it runs and its controls and row actions work, and (for an admin)
 * on its fn page. Both read the hub's queries a page at a time.
 */
import { SystemName } from '@harness/core';
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import LoadState from '../admin/components/LoadState.vue';
import { fnLabel } from '../chat/logic/labels.ts';
import { bySystem, recordCount, storageWords } from '../data/logic/data.ts';
import { useWidgetOpener } from '../data/state/open-widget.ts';
import { useStores } from '../state/stores.ts';
import { UiButton, UiIcon, UiInput, UiSegmented, relativeTime, type SegmentOption } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

type View = 'stored' | 'widgets';

const { data, session } = useStores();
const route = useRoute();
const router = useRouter();
const now = useNow();
const view = computed<View>({
  get: () => (route.name === ROUTES.dataWidgets ? 'widgets' : 'stored'),
  set: (next) => { void router.push(next === 'widgets' ? links.dataWidgets() : links.data()); },
});
const VIEWS: readonly SegmentOption<View>[] = [{ value: 'stored', label: 'Stored data', icon: 'database' }, { value: 'widgets', label: 'Widgets', icon: 'grid' }];
const setsQuery = useRouteQuery(ROUTES.data);
const widgetsQuery = useRouteQuery(ROUTES.dataWidgets);
const setsWords = setsQuery.draft('q');
const widgetWords = widgetsQuery.draft('q');
const system = setsQuery.text('system');
const words = computed(() => (view.value === 'widgets' ? widgetWords.draft : setsWords.draft));

watch([() => view.value, () => setsWords.value.value, () => system.value], ([shown, text, from]) => {
  if (shown !== 'stored') { return; }
  const parsed = SystemName.safeParse(from);
  void data.sets.load({ text, system: parsed.success ? parsed.data : undefined });
}, { immediate: true });
watch([() => view.value, () => widgetWords.value.value], ([shown, text]) => { if (shown === 'widgets') { void data.widgets.load(text); } }, { immediate: true });

const groups = computed(() => bySystem(data.sets.items.value));

/** A widget opens in a new chat, which runs it; an admin can open its fn page too. */
const { opening, open: openWidget } = useWidgetOpener();
const isAdmin = computed(() => session.user.value?.role === 'admin');
</script>

<template>
  <AppPage title="Data" :description="view === 'widgets' ? 'Saved views of data. Open one to run it with its controls and actions.' : 'Records systems keep in the hub, by type. Open one to search, sort and edit its records.'">
    <template #actions><UiSegmented v-model="view" :options="VIEWS" label="Show" data-testid="data-view" /></template>
    <div class="bar">
      <UiInput v-model="words.value" type="search" icon="search" :placeholder="view === 'widgets' ? 'Search widgets' : 'Search stored data'" :label="view === 'widgets' ? 'Search widgets' : 'Search stored data'" hide-label clearable data-testid="data-search" />
    </div>
    <LoadState
      v-if="view === 'stored'" :loading="data.sets.loading.value" :problem="data.sets.problem.value" :ready="data.sets.loaded.value" :empty="data.sets.items.value.length === 0"
      empty-title="No stored data yet" empty-body="Systems that keep records in the hub show them here." empty-icon="database" @retry="data.sets.load()"
    >
      <section v-for="group in groups" :key="group.system" class="group" :data-system="group.system">
        <h2 class="heading">{{ group.system }} <span class="count">{{ group.sets.length }}</span></h2>
        <ul class="list">
          <li v-for="set in group.sets" :key="set.type">
            <RouterLink class="row" :to="links.dataType(set.type)" data-testid="data-set" :data-type="set.type">
              <UiIcon :name="set.storage.shape === 'table' ? 'table' : 'braces'" :size="16" class="lead" />
              <span class="main">
                <span class="name">{{ set.type.slice(set.system.length + 1) }}</span>
                <span v-if="set.description !== ''" class="about">{{ set.description }}</span>
                <span class="how">{{ storageWords(set.storage) }}</span>
              </span>
              <span class="side">
                <span class="records">{{ recordCount(set) }}</span>
                <span v-if="set.updatedAt !== undefined">{{ relativeTime(set.updatedAt, now) }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </section>
      <UiButton v-if="data.sets.hasMore.value" variant="ghost" :loading="data.sets.loadingMore.value" @click="data.sets.more()">More</UiButton>
    </LoadState>
    <LoadState
      v-else :loading="data.widgets.loading.value" :problem="data.widgets.problem.value" :ready="data.widgets.loaded.value" :empty="data.widgets.items.value.length === 0"
      empty-title="No widgets yet" empty-body="Ask in a chat to save a result as a widget, or use Save as widget on any table of rows." empty-icon="grid" @retry="data.widgets.load()"
    >
      <ul class="list">
        <li v-for="widget in data.widgets.items.value" :key="widget.name" class="widget" data-testid="data-widget" :data-widget="widget.name">
          <UiIcon name="grid" :size="16" class="lead" />
          <span class="main">
            <RouterLink v-if="isAdmin" class="name link" :to="links.fn(widget.name)" data-testid="data-widget-page">{{ fnLabel(widget.name) }}</RouterLink>
            <span v-else class="name">{{ fnLabel(widget.name) }}</span>
            <span v-if="widget.description !== ''" class="about">{{ widget.description }}</span>
            <span v-if="widget.blocked !== undefined" class="how">{{ widget.blocked.reason }}</span>
          </span>
          <UiButton size="sm" icon="play" :loading="opening === widget.name" :disabled="!widget.available" data-testid="data-widget-open" @click="openWidget(widget.name)">Open in chat</UiButton>
        </li>
      </ul>
      <UiButton v-if="data.widgets.hasMore.value" variant="ghost" :loading="data.widgets.loadingMore.value" @click="data.widgets.more()">More</UiButton>
    </LoadState>
  </AppPage>
</template>

<style scoped>
.bar { display: flex; gap: var(--space-2); margin-bottom: var(--space-4); max-width: 520px; }
.bar > * { flex: 1; }
.group { display: grid; gap: var(--space-2); margin-bottom: var(--space-5); min-width: 0; }
.heading { display: flex; align-items: baseline; gap: var(--space-2); margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.count { color: var(--text-faint); font-weight: var(--weight-medium); }
.list { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.list > li + li { border-top: 1px solid var(--border); }
.row, .widget {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-3); width: 100%;
  padding: var(--space-3) var(--space-4); color: var(--text); text-decoration: none;
}
.row:hover { background: var(--surface-2); text-decoration: none; }
.row:focus-visible { outline: none; box-shadow: inset var(--ring); }
.lead { color: var(--text-faint); }
.main { display: grid; gap: 2px; min-width: 0; }
.name { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.link { justify-self: start; color: var(--text); text-decoration: none; }
.link:hover { color: var(--accent); }
.about { color: var(--text-dim); font-size: var(--text-sm); }
.how { color: var(--text-faint); font-size: var(--text-xs); }
.side { display: grid; justify-items: end; gap: 2px; color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap; }
.records { color: var(--text-dim); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
@media (max-width: 520px) {
  .row { grid-template-columns: auto minmax(0, 1fr); }
  .side { grid-column: 2; justify-items: start; display: flex; gap: var(--space-2); }
  .widget { grid-template-columns: auto minmax(0, 1fr); }
  .widget > :last-child { grid-column: 2; justify-self: start; }
}
</style>
