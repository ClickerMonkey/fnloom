<script setup lang="ts">
/**
 * The resource browser (`/resources`), every part of it in the URL: a list (sortable), a grid of thumbnails (three
 * card sizes), or groups made by the hub by type, source, folder or date ("Show all" narrows to one); a folder tree
 * beside them on wide screens; the list's search bar (words, filter pills, the sort, which the hub applies) on one row;
 * the folder trail; bulk select with the actions every
 * selected resource allows; the uploader (files, a pasted image, a web address); and the opened resource in the
 * viewer beside the list on roomy screens or in a sheet, with its mode, page and line in the URL too. Live: resource
 * changes refresh what is shown.
 */
import { ResourceUri, sortOf, type QualifiedName, type ResourceRecord, type ResourceStat } from '@harness/core';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import ListSearch from '../components/query/ListSearch.vue';
import { fieldsOf, useListQuery } from '../state/query.ts';
import { withSort } from '../ui/search.ts';
import AppPage from '../app/AppPage.vue';
import { links } from '../app/routes.ts';
import { toastContextMade } from '../context/made.ts';
import ConfirmDialog from '../admin/components/ConfirmDialog.vue';
import LoadState from '../admin/components/LoadState.vue';
import PanelFrame from '../chat/components/PanelFrame.vue';
import PanelHost from '../chat/components/PanelHost.vue';
import { formatBytes } from '../chat/logic/format.ts';
import { COMPACT_QUERY } from '../state/layout.ts';
import { useStores } from '../state/stores.ts';
import {
  copyText, UiButton, UiDialog, UiInput, UiSegmented, UiSelect, useMediaQuery, type SegmentOption, type SelectOption,
} from '../ui/index.ts';
import { useNow } from '../ui/now.ts';
import ResourceViewer from '../resources/ResourceViewer.vue';
import FolderTree from '../resources/browser/FolderTree.vue';
import ResourceGrid from '../resources/browser/ResourceGrid.vue';
import ResourceGroups from '../resources/browser/ResourceGroups.vue';
import ResourceList from '../resources/browser/ResourceList.vue';
import ResourceUploader from '../resources/browser/ResourceUploader.vue';
import { bulkActions, contextConfirm, isMake, madeBy, type ResourceAction } from '../resources/logic/actions.ts';
import { columnSort, crumbsOf, DEFAULTS, isFiltered, isHubResource, nameOf, SORT_FIELDS, type BrowserSort, type BrowserView, type CardSize } from '../resources/logic/browse.ts';
import { FORM_LABEL, typeWord } from '../resources/logic/formats.ts';
import { useBrowserUrl } from '../resources/state/url.ts';

const { resources, toasts } = useStores();
const router = useRouter();
const browser = resources.browser;
const url = useBrowserUrl();
const query = url.query;
const now = useNow();
const roomy = useMediaQuery('(min-width: 1360px)');
const wide = useMediaQuery('(min-width: 1100px)');
const spacious = useMediaQuery('(min-width: 1720px)');
const phone = useMediaQuery(COMPACT_QUERY);

const VIEWS: readonly SegmentOption<BrowserView>[] = [{ value: 'list', label: 'List', icon: 'list' }, { value: 'grid', label: 'Grid', icon: 'grid' }, { value: 'groups', label: 'Groups', icon: 'layers' }];
const GROUPS = [{ value: 'type', label: 'By type' }, { value: 'source', label: 'By source' }, { value: 'path', label: 'By folder' }, { value: 'date', label: 'By date' }] as const satisfies readonly SelectOption<string>[];
const SIZES: readonly SegmentOption<CardSize>[] = [{ value: 's', label: 'S' }, { value: 'm', label: 'M' }, { value: 'l', label: 'L' }];

const view = computed({ get: () => query.value.view ?? DEFAULTS.view, set: (next: BrowserView) => { url.set({ view: next, in: '' }); } });
const group = computed({ get: () => query.value.group ?? DEFAULTS.group, set: (next: string) => { const parsed = GROUPS.find((g) => g.value === next); if (parsed) { url.set({ group: parsed.value, in: '' }); } } });
const size = computed({ get: () => query.value.size ?? DEFAULTS.size, set: (next: CardSize) => { url.set({ size: next }); } });

/** The list's query (words, filters, sort) in `q`. */
const search = useListQuery('resources');

/** What the list shows: everything but the opened resource's mode, page and line. */
const listKey = computed(() => JSON.stringify({ ...query.value, uri: undefined, mode: undefined, page: undefined, section: undefined, size: undefined }));
watch(listKey, () => { void browser.show(query.value); }, { immediate: true });
watch(() => [query.value.group, query.value.q] as const, () => { void browser.openFolder('', true); }, { immediate: true });
onMounted(() => { browser.start(); });
onBeforeUnmount(() => { browser.stop(); });

/** The column the hub sorted by (the list's sort, its default when none is chosen): the headers show it and change it. */
const column = computed(() => columnSort(query.value));
const records = computed(() => browser.list.items.value);
function sortBy(next: BrowserSort): void {
  search.value = { ...search.value, sort: withSort(fieldsOf('resources'), sortOf('resources', search.value), SORT_FIELDS[next]) };
}
const showGroups = computed(() => view.value === 'groups' && query.value.in === undefined);
const inLabel = computed(() => browser.facets.value.find((f) => f.value === query.value.in)?.label ?? query.value.in ?? '');
const crumbs = computed(() => crumbsOf(query.value.under ?? ''));
const peek = (record: ResourceRecord) => browser.peek(record).value.value;

// ─── The opened resource ──────────────────────────────────────────────────
const opened = computed(() => query.value.uri ?? '');
/** What the viewer loaded about the opened resource: its own stat, whatever the list holds (a deep link, a reload). */
const openedStat = shallowRef<ResourceStat | undefined>(undefined);
const shownStat = computed(() => (openedStat.value?.uri === opened.value ? openedStat.value : browser.list.items.value.find((r) => r.uri === opened.value)?.stat));
const panelTitle = computed(() => nameOf({ uri: opened.value, stat: shownStat.value ?? { name: '' } }) || 'Resource');
/** The opened resource's type and size; its address until those are known. */
const panelSubtitle = computed(() => {
  const stat = shownStat.value;
  if (stat === undefined) { return opened.value; }
  return stat.size === undefined ? typeWord(stat) : `${typeWord(stat)} · ${formatBytes(stat.size)}`;
});
const panel = computed({ get: () => opened.value !== '', set: (open: boolean) => { if (!open) { url.set({ uri: '', mode: '', page: '', section: '' }); } } });
/** The folder tree shows on wide screens, and beside an open resource only where there is room for all three. */
const rail = computed(() => wide.value && (!panel.value || !roomy.value || spacious.value));
function open(uri: string): void {
  const parsed = ResourceUri.safeParse(uri);
  if (parsed.success) { url.set({ uri: parsed.data, mode: '', page: '', section: '' }, { push: true }); }
}
const mode = computed({ get: () => query.value.mode ?? '', set: (next: string) => { url.set({ mode: next, page: '' }); } });
const page = computed({ get: () => Number(query.value.page ?? '1'), set: (next: number) => { url.set({ page: next <= 1 ? '' : String(next) }); } });
const line = ref(0);
watch(opened, () => { line.value = 0; });

// ─── Actions ──────────────────────────────────────────────────────────────
const uploading = ref(false);
const renaming = shallowRef<ResourceRecord | undefined>(undefined);
const newName = ref('');
const renameOpen = computed({ get: () => renaming.value !== undefined, set: (show: boolean) => { if (!show) { renaming.value = undefined; } } });
const deleting = shallowRef<readonly ResourceRecord[]>([]);
const deleteOpen = computed({ get: () => deleting.value.length > 0, set: (show: boolean) => { if (!show) { deleting.value = []; } } });
const deleteTitle = computed(() => { const [only] = deleting.value; return deleting.value.length === 1 && only !== undefined ? `Delete ${nameOf(only)}?` : `Delete ${deleting.value.length} resources?`; });
const selectedRecords = computed(() => browser.list.items.value.filter((r) => browser.selected.value.has(r.uri)));
const bulk = computed(() => bulkActions(selectedRecords.value));
/** The resources "Make context" waits to confirm for. */
const contexting = shallowRef<readonly ResourceRecord[]>([]);
const contextOpen = computed({ get: () => contexting.value.length > 0, set: (show: boolean) => { if (!show) { contexting.value = []; } } });
const contextText = computed(() => contextConfirm(contexting.value.map(nameOf)));
async function makeContext(): Promise<void> {
  const targets = contexting.value;
  contexting.value = [];
  const made = await browser.makeContext(targets.map((r) => r.uri));
  if (made === undefined) { toasts.error("Couldn't make context", browser.acting.problem.value); return; }
  toastContextMade(toasts, made, openContext);
}

async function act(action: ResourceAction, targets: readonly ResourceRecord[]): Promise<void> {
  const first = targets[0];
  if (first === undefined) { return; }
  if (isMake(action)) {
    const made = madeBy(action);
    if (made === undefined) { return; }
    const what = targets.length === 1 ? nameOf(first) : `${targets.length} resources`;
    if (await browser.make(targets.map((r) => r.uri), made)) { toasts.ok(`Making ${FORM_LABEL[made].toLowerCase()}`, `for ${what}`); } else { toasts.error("Couldn't make that", browser.acting.problem.value); }
    return;
  }
  switch (action) {
    case 'open': open(first.uri); return;
    case 'copy': if (await copyText(first.uri)) { toasts.ok('Address copied'); } return;
    case 'download': {
      const got = await browser.downloadUrl(first.uri);
      if (got === undefined) { toasts.error("Couldn't start the download", browser.acting.problem.value); return; }
      const link = document.createElement('a');
      link.href = got;
      link.download = nameOf(first);
      link.rel = 'noopener';
      link.click();
      return;
    }
    case 'context': contexting.value = targets; return;
    case 'refetch': {
      const fetched = await browser.refetch(targets);
      if (fetched === undefined) { toasts.error("Couldn't fetch that again", browser.acting.problem.value); return; }
      toasts.ok(fetched === 1 ? 'Fetched again' : `Fetched ${fetched} pages again`);
      return;
    }
    case 'rename': renaming.value = first; newName.value = nameOf(first); return;
    case 'delete': deleting.value = targets.filter((r) => isHubResource(r.uri)); return;
  }
}
async function rename(): Promise<void> {
  const target = renaming.value;
  if (target === undefined || newName.value.trim() === '') { return; }
  if (await browser.rename(target.uri, newName.value.trim())) { renaming.value = undefined; toasts.ok('Renamed'); } else { toasts.error("Couldn't rename it", browser.acting.problem.value); }
}
async function remove(): Promise<void> {
  const done = await browser.remove(deleting.value.map((r) => r.uri));
  deleting.value = [];
  if (done === undefined) { toasts.error("Couldn't delete that", browser.acting.problem.value); return; }
  if (done.deleted > 0 && opened.value !== '' && !browser.list.items.value.some((r) => r.uri === opened.value)) { panel.value = false; }
  toasts.ok(`Deleted ${done.deleted}`, done.kept > 0 ? `${done.kept} are still used and were kept.` : undefined);
}
async function importUrl(address: string): Promise<void> {
  const done = await browser.importUrl(address);
  if (done.ok) { toasts.ok('Imported', nameOf(done.value)); }
}
/** Go to a context item's page. */
function openContext(name: QualifiedName): void {
  void router.push(links.contextItem(name));
}

function notice(text: string, tone: 'ok' | 'danger'): void {
  if (tone === 'ok') { toasts.ok(text); } else { toasts.error(text); }
}
</script>

<template>
  <AppPage title="Resources" description="Files, pages and uploads, as the hub keeps them: open any to see it, its converted forms, and what is known about it.">
    <template #actions>
      <UiButton variant="primary" icon="upload" data-testid="open-uploader" @click="uploading = true">Add</UiButton>
    </template>

    <div class="resources" :class="{ split: roomy && panel, rail }" data-testid="resources-page">
      <aside v-if="rail" class="rail">
        <FolderTree :folders="browser.folders.value" :under="query.under ?? ''" @open="browser.openFolder($event)" @choose="url.set({ under: $event, in: '' })" />
      </aside>

      <section class="main" aria-label="Resources">
        <div class="toolbar" role="search" aria-label="Filter resources">
          <!-- one row: the search bar with the sort, then what the layout adds (grouping, card size) beside the layout switch -->
          <ListSearch v-model="search" list="resources" label="resources" placeholder="Search names, addresses and contents" :count="showGroups ? undefined : records.length" :more="browser.list.hasMore.value" data-testid="resource-search">
            <UiSelect v-if="view === 'groups'" v-model="group" class="pick" :options="GROUPS" label="Group" hide-label size="sm" data-testid="resource-grouping" />
            <UiSegmented v-if="view === 'grid'" v-model="size" :options="SIZES" label="Card size" />
            <UiSegmented v-model="view" :options="VIEWS" label="Layout" icon-only data-testid="resource-view" />
          </ListSearch>
        </div>

        <nav v-if="crumbs.length > 1 || query.in" class="crumbs" aria-label="Where">
          <template v-for="(crumb, i) in crumbs" :key="crumb.under">
            <span v-if="i > 0" class="sep" aria-hidden="true">/</span>
            <button type="button" class="crumb" :aria-current="i === crumbs.length - 1 ? 'page' : undefined" @click="url.set({ under: crumb.under })">{{ crumb.label }}</button>
          </template>
          <template v-if="query.in">
            <span class="sep" aria-hidden="true">›</span>
            <span class="crumb current">{{ inLabel }}</span>
            <UiButton size="sm" variant="ghost" icon="x" @click="url.set({ in: '' })">{{ view === 'groups' ? 'Back to groups' : 'Every group' }}</UiButton>
          </template>
        </nav>

        <div v-if="browser.selectedCount.value > 0" class="bulk" role="toolbar" aria-label="Selected resources" data-testid="bulk-bar">
          <span class="bulk-count">{{ browser.selectedCount.value }} selected</span>
          <UiButton v-for="action in bulk" :key="action.value" size="sm" :variant="action.danger ? 'danger' : 'secondary'" :icon="action.icon" @click="act(action.value, selectedRecords)">{{ action.label }}</UiButton>
          <UiButton size="sm" variant="ghost" @click="browser.clearSelection()">Clear</UiButton>
        </div>

        <ResourceGroups
          v-if="showGroups" :facets="browser.facets.value" :groups="browser.groups.value" :selected="browser.selected.value" :opened="opened" :peek="peek"
          @open="open" @toggle="browser.toggle($event)" @action="(action, record) => act(action, [record])" @all="url.set({ in: $event })"
        />
        <LoadState
          v-else :loading="browser.list.loading.value" :problem="browser.list.problem.value" :ready="browser.list.loaded.value" :empty="records.length === 0"
          empty-icon="layers" :empty-title="isFiltered(query) ? 'No resources match' : 'No resources yet'"
          :empty-body="isFiltered(query) ? 'Try other words or filters.' : 'Resources show here as systems serve them, or add files and pages.'" :lines="8" @retry="browser.list.load()"
        >
          <ResourceGrid
            v-if="view === 'grid' || view === 'groups'" :records="records" :selected="browser.selected.value" :opened="opened" :size="size" :peek="peek"
            @open="open" @toggle="browser.toggle($event)" @action="(action, record) => act(action, [record])"
          />
          <ResourceList
            v-else :records="records" :selected="browser.selected.value" :opened="opened" :sort="column.sort" :descending="column.descending" :now="now"
            @open="open" @toggle="browser.toggle($event)" @toggle-all="browser.toggleAll()" @sort="sortBy" @action="(action, record) => act(action, [record])"
          />
          <div v-if="browser.list.hasMore.value" class="more">
            <UiButton variant="ghost" :loading="browser.list.loadingMore.value" data-testid="more" @click="browser.list.more()">Show more</UiButton>
          </div>
        </LoadState>
      </section>

      <PanelHost v-model:open="panel" :inline="roomy" :phone="phone" :label="panelTitle">
        <PanelFrame :title="panelTitle" :subtitle="panelSubtitle" @close="panel = false">
          <ResourceViewer
            v-if="opened !== '' && query.uri" v-model:mode="mode" v-model:page="page" v-model:line="line" :uri="query.uri" v-bind="query.section === undefined ? {} : { section: query.section }"
            @navigate="open" @notice="notice" @context="(made) => toastContextMade(toasts, made, openContext)" @opened="openedStat = $event"
          />
        </PanelFrame>
      </PanelHost>
    </div>

    <ResourceUploader
      v-model:open="uploading" :uploads="browser.uploads.value" :importing="browser.importing.busy.value" :problem="browser.importing.problem.value"
      @files="browser.upload($event)" @url="importUrl" @dismiss="browser.dismissUpload($event)"
    />
    <UiDialog v-model:open="renameOpen" title="Rename" description="Only the name changes; the address stays the same.">
      <form class="rename" @submit.prevent="rename">
        <UiInput v-model="newName" label="Name" autofocus @enter="rename" />
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="renameOpen = false">Cancel</UiButton>
        <UiButton variant="primary" :loading="browser.acting.busy.value" :disabled="newName.trim() === ''" @click="rename">Rename</UiButton>
      </template>
    </UiDialog>
    <ConfirmDialog
      v-model:open="deleteOpen" :title="deleteTitle"
      body="Its content and forms are removed from the hub. Context made from it stays until it is forgotten." confirm="Delete" :busy="browser.acting.busy.value" @confirm="remove"
    />
    <ConfirmDialog
      v-model:open="contextOpen" :title="contextText.title" :body="contextText.body" :confirm="contextText.confirm" :danger="false" @confirm="makeContext"
    />
  </AppPage>
</template>

<style scoped>
.resources { display: grid; gap: var(--space-4); min-width: 0; }
.resources.rail { grid-template-columns: 220px minmax(0, 1fr); }
.resources.rail.split { grid-template-columns: 220px minmax(0, 1fr) 460px; }
.resources.split:not(.rail) { grid-template-columns: minmax(0, 1fr) 460px; }
/* the opened resource: a column pinned in view whose header stays and whose body scrolls (as `BrowserFrame`'s) */
.resources.split :deep([data-testid='chat-panel']) {
  position: sticky; top: calc(var(--pinned-top, 0px) + var(--space-4)); height: calc(100dvh - var(--pinned-top, 0px) - var(--space-4) - var(--space-7)); overflow: hidden; align-self: start;
  border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);
}
.rail { position: sticky; top: calc(var(--pinned-top, 0px) + var(--space-4)); align-self: start; max-height: calc(100dvh - var(--pinned-top, 0px) - 2 * var(--space-4)); overflow: auto; }
.main { display: grid; align-content: start; gap: var(--space-3); min-width: 0; }
.toolbar { display: grid; min-width: 0; }
.pick { width: auto; min-width: 128px; flex: 0 1 160px; }
.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1); font-size: var(--text-sm); }
.crumb { padding: 2px 6px; border: 0; border-radius: 6px; background: none; color: var(--accent); font: inherit; cursor: pointer; overflow-wrap: anywhere; }
.crumb[aria-current], .crumb.current { color: var(--text); font-weight: var(--weight-medium); cursor: default; }
.crumb:focus-visible { outline: none; box-shadow: var(--ring); }
.sep { color: var(--text-faint); }
.bulk { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); padding: var(--space-2) var(--space-3); border: 1px solid color-mix(in oklab, var(--accent) 40%, var(--border)); border-radius: var(--radius); background: color-mix(in oklab, var(--accent) 6%, var(--surface)); }
.bulk-count { font-size: var(--text-sm); font-weight: var(--weight-medium); margin-right: auto; }
.more { display: grid; place-items: center; padding: var(--space-3); }
.rename { display: grid; }
</style>
