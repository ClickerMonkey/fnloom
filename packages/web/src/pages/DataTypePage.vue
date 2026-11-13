<script setup lang="ts">
/**
 * One stored type's records (build 8, `/data/notes/Note`): the result grid of a page of them, searched by words (`q`),
 * filtered (`where`), sorted (`sort`) and paged (`at`) by the hub, all in the URL. Opening a row shows the record
 * (`/data/notes/Note/rec_…`) beside the grid with its value, Edit, Remove and history; New record adds one. "Show as
 * widget" asks the agent, in a new chat, to make a widget of these records.
 */
import { HUB_VISUALS, QualifiedName, RecordId, type Filter, type Json } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import LoadState from '../admin/components/LoadState.vue';
import PanelFrame from '../chat/components/PanelFrame.vue';
import PanelHost from '../chat/components/PanelHost.vue';
import ResultBlock from '../components/results/ResultBlock.vue';
import type { PageRequest } from '../components/results/table.ts';
import type { RowOpener } from '../components/results/visuals.ts';
import RecordFilters from '../data/components/RecordFilters.vue';
import RecordPanel from '../data/components/RecordPanel.vue';
import { filtersOf, filtersParam, recordIdOf, recordTableQuery, sortParam, typeOf, type RecordsUrl } from '../data/logic/data.ts';
import { COMPACT_QUERY } from '../state/layout.ts';
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
const at = query.text('at');

const param = (name: string): string => { const value = route.params[name]; return typeof value === 'string' ? value : ''; };
const type = computed(() => typeOf(param('system'), param('local')));
const opened = computed(() => param('id'));
const url = computed((): RecordsUrl => ({
  ...(words.value.value === '' ? {} : { q: words.value.value }), ...(where.value === '' ? {} : { where: where.value }),
  ...(sort.value === '' ? {} : { sort: sort.value }), ...(at.value === '' ? {} : { at: at.value }),
}));
const filters = computed(() => filtersOf(where.value));
const ref_ = computed(() => (type.value === undefined ? undefined : { name: type.value }));

watch([type, () => JSON.stringify(url.value)], () => { if (type.value !== undefined) { void records.show(recordTableQuery(type.value, url.value)); } }, { immediate: true });
watch([type, opened], () => {
  const id = RecordId.safeParse(opened.value);
  if (type.value !== undefined && id.success) { void records.open(type.value, id.data); } else { records.close(); }
}, { immediate: true });
onBeforeUnmount(() => { records.close(); });

const table = computed(() => records.table.value.value);
const registry = QualifiedName.parse(HUB_VISUALS);

/** Go to another page or order of records: the URL follows, and the grid with it. */
function page(request: PageRequest): void {
  if (type.value === undefined) { return; }
  const first = request.sort[0];
  void router.push(links.dataType(type.value, {
    ...url.value, at: request.offset === 0 ? undefined : String(request.offset), sort: first === undefined ? undefined : sortParam({ field: first.column, dir: first.dir }),
  }));
}

function setFilters(next: Filter[]): void {
  where.value = filtersParam(next);
  at.value = '';
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
    const text = `Make a widget of the ${type.value} records (use hub/make_widget with hub/records_table as its source and type pinned to ${type.value}).`;
    await chat.thread(session).send({ parts: [{ type: 'text', text }] });
    await router.push(links.session(session));
  } finally {
    asking.value = false;
  }
}
</script>

<template>
  <AppPage :title="param('local')" :description="type ? `Records of ${type}, kept by the hub.` : ''" keep-title>
    <template #crumb>
      <RouterLink :to="links.data()" class="crumb" data-testid="back-to-data"><UiIcon name="chevron-left" :size="14" />Data</RouterLink>
    </template>
    <template #actions>
      <UiButton size="sm" variant="ghost" icon="grid" :loading="asking" data-testid="show-as-widget" @click="showAsWidget">Show as widget</UiButton>
      <UiButton size="sm" variant="primary" icon="plus" data-testid="record-new" @click="open(NEW)">New record</UiButton>
    </template>
    <div class="bar">
      <UiInput v-model="words.draft.value" type="search" icon="search" placeholder="Search records" label="Search records" hide-label clearable class="search" data-testid="records-search" />
      <RecordFilters :columns="table?.columns ?? []" :filters="filters" @change="setFilters" />
    </div>
    <LoadState
      :loading="records.table.loading.value" :problem="records.table.problem.value" :ready="table !== undefined" :empty="table?.rows.length === 0 && words.value.value === '' && filters.length === 0"
      empty-title="No records yet" empty-body="Add one with New record, or let a system add them." empty-icon="database" :lines="8" @retry="type && records.show(recordTableQuery(type, url))"
    >
      <ResultBlock v-if="table" :table="table" :title="param('local')" :registry="registry" :view-key="`data:${type ?? ''}`" :pager="page" :opener="opener" />
    </LoadState>
    <PanelHost v-model:open="panelOpen" :inline="false" :phone="phone" :label="panelTitle">
      <PanelFrame :title="panelTitle" :subtitle="type ?? ''" @close="open(undefined)">
        <RecordPanel
          v-if="ref_ && (opened === NEW || record)" :key="opened" :type="ref_" :record="opened === NEW ? undefined : record" :versions="records.versions.value"
          :more-versions="records.versionsNext.value !== undefined" :versions-loading="records.versionsLoading.value" :versions-problem="records.versionsProblem.value"
          :busy="records.saving.busy.value" :problem="records.saving.problem.value || records.record.problem.value" @save="save" @remove="remove" @more="records.moreVersions()" @cancel="open(undefined)"
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
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); min-width: 0; }
.search { flex: 1 1 240px; max-width: 420px; }
.dim { margin: 0; color: var(--text-dim); }
</style>
