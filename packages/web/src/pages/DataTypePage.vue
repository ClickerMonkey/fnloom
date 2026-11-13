<script setup lang="ts">
/**
 * One stored type's records (`/data/notes/Note`), drawn by the widget view (data-grid "one view"): the same visuals,
 * pager and export as any widget, over `hub/records_table`. Searched by words (`q`), filtered (`where`) and sorted
 * (`sort`) by the hub, with the visual picked (`view`), all in the URL; the view reads the next window only when a page
 * needs it. Editable fields are edited in place: changes are staged, then "Save N changes" asks once and saves each
 * record. Opening a row shows the record (`/data/notes/Note/rec_…`) beside it with its value, Edit, Remove and history;
 * New record adds one. "Show as widget" asks the agent, in a new chat, to make a widget of these records.
 */
import { RecordId, type Filter, type Json, type ResultSort } from '@harness/core';
import { computed, onBeforeUnmount, provide, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import LoadState from '../admin/components/LoadState.vue';
import PanelFrame from '../chat/components/PanelFrame.vue';
import PanelHost from '../chat/components/PanelHost.vue';
import { RESULTS_HOST, type ResultsHost } from '../components/results/builtin.ts';
import type { RowOpener } from '../components/results/visuals.ts';
import WidgetView from '../components/widgets/WidgetView.vue';
import { WIDGET_HOST } from '../components/widgets/widgets.ts';
import RecordFilters from '../data/components/RecordFilters.vue';
import RecordPanel from '../data/components/RecordPanel.vue';
import { choiceOf, choiceParam, filtersOf, filtersParam, recordIdOf, recordsFrame, recordTableQuery, sortParam, typeOf, type RecordsUrl } from '../data/logic/data.ts';
import { RecordsWidgetSource, recordsWidgetHost } from '../data/state/records-widget.ts';
import { COMPACT_QUERY } from '../state/layout.ts';
import { useActorNames } from '../state/actor-names.ts';
import { useStores } from '../state/stores.ts';
import { UiButton, UiIcon, UiInput, useMediaQuery } from '../ui/index.ts';

/** The id that opens the form for a new record. */
const NEW = 'new';

const { data, chat, toasts } = useStores();
const route = useRoute();
const router = useRouter();
const phone = useMediaQuery(COMPACT_QUERY);
const records = data.records();
const query = useRouteQuery(ROUTES.dataType);
const words = query.draft('q');
const where = query.text('where');
const sort = query.text('sort');
const view = query.text('view');

const param = (name: string): string => { const value = route.params[name]; return typeof value === 'string' ? value : ''; };
const type = computed(() => typeOf(param('system'), param('local')));
const opened = computed(() => param('id'));
const url = computed((): RecordsUrl => ({
  ...(words.value.value === '' ? {} : { q: words.value.value }), ...(where.value === '' ? {} : { where: where.value }),
  ...(sort.value === '' ? {} : { sort: sort.value }), ...(view.value === '' ? {} : { view: view.value }),
}));
/** The hub query of the records shown (the visual picked doesn't change it). */
const tableQuery = computed(() => (type.value === undefined ? undefined : recordTableQuery(type.value, url.value)));
const filters = computed(() => filtersOf(where.value));
const ref_ = computed(() => (type.value === undefined ? undefined : { name: type.value }));

watch(() => JSON.stringify(tableQuery.value), () => { if (tableQuery.value !== undefined) { void records.show(tableQuery.value); } }, { immediate: true });
watch([type, opened], () => {
  const id = RecordId.safeParse(opened.value);
  if (type.value !== undefined && id.success) { void records.open(type.value, id.data); } else { records.close(); }
}, { immediate: true });
onBeforeUnmount(() => { records.close(); });

const table = computed(() => records.table.value.value);
/** How many records there are, under the heading (the heading already names the type). */
const description = computed(() => {
  const total = table.value?.total;
  return total === undefined ? '' : `${String(total)} ${total === 1 ? 'record' : 'records'}${words.value.value !== '' || filters.value.length > 0 ? ' found' : ''}`;
});
/** People's names for the record's history. */
const { nameOf } = useActorNames(chat.pickers.source('person'), () => records.versions.value.flatMap((version) => (version.by === undefined ? [] : [version.by])));

// the widget view: the records as a widget's frame, read again through hub/records_table, with the visual picked in the URL
provide(WIDGET_HOST, recordsWidgetHost({ data, records }));
const results: ResultsHost = {
  visuals: (registry, shown, facts) => chat.visuals.visuals(registry, shown, facts),
  prepare: (registry) => chat.visuals.prepare(registry),
  choice: () => choiceOf(view.value),
  choose: (_key, picked) => { view.value = choiceParam(picked); },
};
provide(RESULTS_HOST, results);
const frame = computed(() => (table.value === undefined || tableQuery.value === undefined ? undefined : recordsFrame(table.value, tableQuery.value, param('local'))));
const source = computed(() => (tableQuery.value === undefined ? undefined : new RecordsWidgetSource(records, tableQuery.value, param('local'))));
/** Each load of the page's records draws afresh (a new query, a record saved beside it). */
const loads = ref(0);
watch(table, () => { loads.value++; });

/** Another order of records: the hub sorts them, the URL follows. */
function sortBy(next: ResultSort | undefined): void {
  sort.value = sortParam(next === undefined ? undefined : { field: next.column, dir: next.dir });
}

function setFilters(next: Filter[]): void {
  where.value = filtersParam(next);
}

function open(id: string | undefined): void {
  if (type.value === undefined) { return; }
  void router.push(links.dataType(type.value, url.value, id));
}

const opener = computed((): RowOpener | undefined => {
  const shown = table.value;
  return shown === undefined ? undefined : { label: 'Open', has: (row) => recordIdOf(shown, row) !== undefined, open: (row) => { open(recordIdOf(shown, row)); } };
});

const panelOpen = computed({ get: () => opened.value !== '', set: (isOpen: boolean) => { if (!isOpen) { open(undefined); } } });
const record = computed(() => records.record.value.value);
const panelTitle = computed(() => (opened.value === NEW ? 'New record' : record.value?.title || 'Record'));

async function save(value: Json): Promise<void> {
  if (type.value === undefined) { return; }
  const saved = await records.save(type.value, value, record.value?.id, record.value?.version);
  if (saved === undefined) { return; }
  toasts.ok(opened.value === NEW ? 'Record added' : 'Record saved');
  if (opened.value === NEW) { open(saved.id); }
}

async function remove(): Promise<void> {
  const current = record.value;
  if (type.value === undefined || current === undefined) { return; }
  if (await records.remove(type.value, current.id)) { toasts.ok('Record removed'); open(undefined); }
}

/** Ask the agent, in a new chat, to make a widget of these records. */
const asking = ref(false);
async function showAsWidget(): Promise<void> {
  if (type.value === undefined) { return; }
  asking.value = true;
  try {
    const session = await chat.sessions.create({ title: `${param('local')} widget` });
    if (session === undefined) { toasts.error("Couldn't start a chat", chat.sessions.problem.value); return; }
    const text = `Make a widget of the ${type.value} records (use widgets/make_widget with hub/records_table as its source and type pinned to ${type.value}).`;
    await chat.thread(session).send({ parts: [{ type: 'text', text }] });
    await router.push(links.session(session));
  } finally {
    asking.value = false;
  }
}
</script>

<template>
  <AppPage :title="param('local')" :description="description" keep-title>
    <template #crumb>
      <RouterLink :to="links.data()" class="crumb" data-testid="back-to-data"><UiIcon name="chevron-left" :size="14" />Data</RouterLink>
    </template>
    <template #actions>
      <UiButton size="sm" variant="ghost" icon="grid" :loading="asking" data-testid="show-as-widget" @click="showAsWidget">Show as widget</UiButton>
      <UiButton size="sm" variant="primary" icon="plus" data-testid="record-new" @click="open(NEW)">New record</UiButton>
    </template>
    <LoadState
      :loading="records.table.loading.value" :problem="records.table.problem.value" :ready="table !== undefined" :empty="table?.rows.length === 0 && words.value.value === '' && filters.length === 0"
      empty-title="No records yet" empty-body="Add one with New record, or let a system add them." empty-icon="database" :lines="8" @retry="type && records.show(recordTableQuery(type, url))"
    >
      <WidgetView
        v-if="frame && source" :key="loads" :frame="frame" :source="source" :opener="opener" :sort="sortBy" :view-key="`data:${type ?? ''}`" :show-title="false"
        data-testid="records-widget"
      >
        <template #lead>
          <UiInput v-model="words.draft.value" type="search" icon="search" placeholder="Search records" label="Search records" hide-label clearable class="search" data-testid="records-search" />
          <RecordFilters :columns="frame.table.columns" :filters="filters" @change="setFilters" />
        </template>
      </WidgetView>
    </LoadState>
    <PanelHost v-model:open="panelOpen" :inline="false" :phone="phone" :label="panelTitle">
      <PanelFrame :title="panelTitle" @close="open(undefined)">
        <RecordPanel
          v-if="ref_ && (opened === NEW || record)" :key="opened" :type="ref_" :record="opened === NEW ? undefined : record" :versions="records.versions.value"
          :more-versions="records.versionsNext.value !== undefined" :versions-loading="records.versionsLoading.value" :versions-problem="records.versionsProblem.value"
          :name-of="nameOf" :busy="records.saving.busy.value" :problem="records.saving.problem.value || records.record.problem.value" @save="save" @remove="remove" @more="records.moreVersions()" @cancel="open(undefined)"
        />
        <p v-else-if="records.record.loading.value" class="dim">Loading…</p>
        <p v-else class="dim" data-testid="record-missing">{{ records.record.problem.value || 'No record by that id, or you may not see it.' }}</p>
      </PanelFrame>
    </PanelHost>
  </AppPage>
</template>

<style scoped>
.crumb { display: inline-flex; align-items: center; gap: 2px; color: var(--text-dim); font-size: var(--text-sm); text-decoration: none; }
.crumb:hover { color: var(--text); }
.search { flex: 1 1 8rem; min-width: 0; max-width: 420px; }
.dim { margin: 0; color: var(--text-dim); }
</style>
