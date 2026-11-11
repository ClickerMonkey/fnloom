<script setup lang="ts">
/**
 * The file explorer (`/explore/:system/:instance/:path*?open=`): one system instance's files (an fs machine's), read
 * live through the hub as the person and never saved as resources. The folder tree sits in its own column at the left
 * on wide screens, as wide as its divider is dragged; the main column shows the folder's trail and entries (folders
 * first), and an opened file beside them on roomy screens or in their place on narrow ones. The folder is the path,
 * the opened file the `open` query, so every view has its address. Each column scrolls by itself.
 */
import { InstanceName, ResourceUri, SystemName, type ResourceStat } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import LoadState from '../admin/components/LoadState.vue';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import ExploreEntries from '../resources/browser/ExploreEntries.vue';
import ExploreNode from '../resources/browser/ExploreNode.vue';
import { crumbsOf, entryName, pathUnder, placeOf, segmentLabel, uriUnder, type ExploreChildren } from '../resources/logic/explore.ts';
import { languageOf } from '../resources/logic/formats.ts';
import CodeViewer from '../resources/viewers/CodeViewer.vue';
import { COMPACT_QUERY, TREE_WIDTH } from '../state/layout.ts';
import { useStores } from '../state/stores.ts';
import { UiButton, UiIconButton, UiMarkdown, UiSplitter, useMediaQuery } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

const { resources, layout } = useStores();
const store = resources.explorer;
const route = useRoute();
const router = useRouter();
/** The opened file's name in the folder ('' for none). */
const opened = useRouteQuery(ROUTES.explore).text('open', { push: true });
const now = useNow();
const wide = useMediaQuery('(min-width: 1100px)');
const roomy = useMediaQuery('(min-width: 1360px)');
const phone = useMediaQuery(COMPACT_QUERY);

const system = computed(() => SystemName.safeParse(route.params['system']).data);
const instance = computed(() => InstanceName.safeParse(route.params['instance']).data);
const segments = computed(() => { const path = route.params['path']; return Array.isArray(path) ? path : typeof path === 'string' && path !== '' ? [path] : []; });
watch([system, instance], ([name, copy]) => { if (name !== undefined && copy !== undefined) { void store.open(name, copy); } }, { immediate: true });

const roots = computed(() => store.roots.value.value ?? []);
const place = computed(() => placeOf(roots.value, segments.value));
/** The folder the list shows: a root and the path under it; undefined on the instance's own page (its roots). */
const folderUri = computed(() => (place.value.root === undefined ? undefined : uriUnder(place.value.root, place.value.path)));
watch(folderUri, (uri) => { if (uri !== undefined) { store.folder(uri); } }, { immediate: true });
const folder = computed(() => (folderUri.value === undefined ? undefined : store.peek(folderUri.value)));
/** The opened file's uri, from `open`. */
const fileUri = computed(() => {
  const name = opened.value;
  return place.value.root === undefined || name === '' ? undefined : uriUnder(place.value.root, [...place.value.path, name]);
});
watch(fileUri, (uri) => { void store.read(uri); }, { immediate: true });
const file = computed(() => store.file.value.value);
const fileText = computed(() => (file.value?.text !== undefined && 'inline' in file.value.text ? file.value.text.inline : undefined));

const title = computed(() => (system.value === undefined ? 'Files' : `${system.value}/${instance.value ?? ''}`));
const crumbs = computed(() => (place.value.root === undefined ? [] : crumbsOf(place.value.root, place.value.path)));
/** The roots as folders, for the instance's own page. */
const rootEntries = computed<ResourceStat[]>(() => roots.value.map((root) => ({ uri: root.uri, name: root.name, type: 'folder', version: '' })));
const entries = computed(() => (folder.value === undefined ? rootEntries.value : folder.value.items.value));

function go(path: readonly string[], open?: string): void {
  if (system.value === undefined || instance.value === undefined) { return; }
  void router.push(links.explore(system.value, instance.value, path, open));
}
/** The page path of a folder uri: its root's name and the path under it. */
function pathOf(uri: string): string[] | undefined {
  for (const root of roots.value) {
    const under = pathUnder(root, uri);
    if (under !== undefined) { return [root.name, ...under]; }
  }
  return undefined;
}
function openEntry(entry: ResourceStat): void {
  if (entry.type === 'folder') {
    const path = pathOf(entry.uri);
    if (path !== undefined) { go(path); }
    return;
  }
  go(segments.value, entryName(entry.uri));
}
function closeFile(): void { go(segments.value); }
function retry(): void {
  if (folder.value !== undefined) { void folder.value.load(); } else if (system.value !== undefined && instance.value !== undefined) { void store.open(system.value, instance.value); }
}

// ─── The tree ─────────────────────────────────────────────────────────────
const expanded = ref<ReadonlySet<string>>(new Set());
function toggle(uri: string): void {
  const next = new Set(expanded.value);
  const parsed = ResourceUri.safeParse(uri);
  if (next.has(uri)) { next.delete(uri); } else if (parsed.success) { next.add(uri); store.folder(parsed.data); }
  expanded.value = next;
}
function choose(uri: string): void {
  const path = pathOf(uri);
  if (path === undefined) { return; }
  if (!expanded.value.has(uri)) { toggle(uri); }
  go(path);
}
/** The tree follows the page: the open folder and every folder above it are expanded (and read), so it is in view. */
watch(folderUri, () => {
  const root = place.value.root;
  if (root === undefined) { return; }
  const path = place.value.path;
  const along = [root.uri, ...path.map((_, at) => uriUnder(root, path.slice(0, at + 1)))];
  const missing = along.filter((uri) => !expanded.value.has(uri));
  if (missing.length === 0) { return; }
  for (const uri of missing) { store.folder(uri); }
  expanded.value = new Set([...expanded.value, ...missing]);
}, { immediate: true });
const childrenOf = (uri: string): ExploreChildren => {
  const paged = store.peek(uri);
  return { folders: (paged?.items.value ?? []).filter((entry) => entry.type === 'folder'), loading: paged?.loading.value ?? true, problem: paged?.problem.value ?? '' };
};
const treeWidth = computed({ get: () => layout.treeWidth, set: (width: number) => { layout.treeWidth = width; } });
/** Narrow screens show the opened file in place of the list. */
const fileOnly = computed(() => fileUri.value !== undefined && !roomy.value);
</script>

<template>
  <div class="explore" :class="{ rail: wide, split: roomy && fileUri !== undefined }" :style="wide ? { '--tree': `${treeWidth}px` } : undefined" data-testid="explore-page">
    <template v-if="wide">
      <aside class="tree" aria-label="Folders">
        <ul class="roots">
          <ExploreNode
            v-for="root in roots" :key="root.uri" :uri="root.uri" :label="root.name" :current="folderUri ?? ''" :expanded="expanded" :children-of="childrenOf"
            @toggle="toggle" @choose="choose"
          />
        </ul>
      </aside>
      <UiSplitter v-model="treeWidth" label="Folder tree width" :min="TREE_WIDTH.min" :max="TREE_WIDTH.max" :reset="TREE_WIDTH.reset" />
    </template>

    <section v-if="!fileOnly" class="main" aria-label="Folder">
      <header class="head">
        <!-- inside a folder the trail starts with the instance, so the heading is only for screen readers -->
        <h1 class="title" :class="{ 'sr-only': phone || crumbs.length > 0 }">{{ title }}</h1>
        <nav v-if="crumbs.length > 0" class="crumbs" aria-label="Folder trail" data-testid="explore-crumbs">
          <button type="button" class="crumb" @click="go([])">{{ title }}</button>
          <template v-for="(crumb, at) in crumbs" :key="crumb.path.join('/')">
            <span class="sep" aria-hidden="true">/</span>
            <button type="button" class="crumb" :class="{ current: at === crumbs.length - 1 }" :aria-current="at === crumbs.length - 1 ? 'page' : undefined" @click="go([place.root?.name ?? '', ...crumb.path])">{{ crumb.label }}</button>
          </template>
        </nav>
        <p v-else class="about">Live from {{ title }}: nothing here is saved as a resource.</p>
      </header>
      <LoadState
        :loading="store.roots.loading.value || (folder?.loading.value ?? false)" :problem="folder?.problem.value || store.roots.problem.value"
        :ready="store.roots.value.value !== undefined && (folder === undefined || folder.loaded.value)" :empty="entries.length === 0"
        :empty-title="folder === undefined ? 'No folders here' : 'Nothing in this folder'" :empty-body="folder === undefined ? 'This system serves no folders, or none you may see.' : ''" empty-icon="folder"
        @retry="retry"
      >
        <ExploreEntries :entries="entries" :now="now" :opened="fileUri ?? ''" @open="openEntry" />
        <div v-if="folder?.hasMore.value" class="more"><UiButton variant="ghost" :loading="folder.loadingMore.value" @click="folder.more()">Show more</UiButton></div>
      </LoadState>
    </section>

    <section v-if="fileUri !== undefined" class="file" aria-label="File" data-testid="explore-file">
      <header class="file-head">
        <UiIconButton v-if="fileOnly" icon="chevron-left" label="Back to the folder" @click="closeFile" />
        <span class="file-name" :title="fileUri">{{ segmentLabel(opened) }}</span>
        <UiIconButton v-if="!fileOnly" icon="x" label="Close the file" @click="closeFile" />
      </header>
      <LoadState
        :loading="store.file.loading.value" :problem="store.file.problem.value" :ready="file !== undefined" :empty="fileText === undefined"
        empty-title="Too large or not text" empty-body="Only text files show here." empty-icon="file" @retry="fileUri && store.read(fileUri)"
      >
        <div v-if="file?.stat.format === 'markdown'" class="markdown" data-testid="explore-markdown"><UiMarkdown :source="fileText ?? ''" /></div>
        <!-- the pane's header already names the file -->
        <CodeViewer v-else :code="fileText ?? ''" :language="languageOf(file?.stat.format)" />
      </LoadState>
    </section>
  </div>
</template>

<style scoped>
/* the page fills the shell's height: each column scrolls by itself */
.explore { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); min-width: 0; min-height: 0; height: 100%; overflow: hidden; }
.explore.rail { grid-template-columns: var(--tree) 1px minmax(0, 1fr); }
.explore.split { grid-template-columns: minmax(0, 1fr) minmax(420px, 1fr); }
.explore.rail.split { grid-template-columns: var(--tree) 1px minmax(0, 1fr) minmax(420px, 1fr); }
.tree { min-width: 0; min-height: 0; overflow: auto; padding: var(--space-5) var(--space-3); }
.roots { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.main, .file { display: grid; align-content: start; gap: var(--space-3); min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: var(--space-5); }
.file { border-left: 1px solid var(--border); }
.head { display: grid; gap: var(--space-2); }
.title { margin: 0; font-size: var(--text-xl); font-weight: var(--weight-strong); }
.about { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1); font-size: var(--text-sm); }
.crumb { padding: 2px 6px; border: 0; border-radius: 6px; background: none; color: var(--accent); font: inherit; cursor: pointer; overflow-wrap: anywhere; }
.crumb.current { color: var(--text); font-weight: var(--weight-medium); cursor: default; }
.crumb:focus-visible { outline: none; box-shadow: var(--ring); }
.sep { color: var(--text-faint); }
.more { display: grid; place-items: center; padding: var(--space-3); }
.file-head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.markdown { min-width: 0; }
.file-name { flex: 1; min-width: 0; overflow: hidden; font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 759px) {
  .main, .file { padding: var(--space-3); }
  .file { border-left: 0; }
}
</style>
