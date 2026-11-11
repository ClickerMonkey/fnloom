<script setup lang="ts">
/**
 * Any resource, from the hub or a system, drawn with the viewer for its type: images (zoom), SVG, code highlighted
 * with line numbers and go to line, markdown with diagrams and math, diagrams, html in a sandbox, tables (sheets,
 * sort, filter), pdfs at a page, a document's pages, audio and video with their transcripts, JSON as a tree, plain
 * text, folders, and a card for anything else. A mode switch offers Preview and Source where a type has both, a tab
 * per form the hub has made (raw and converted side by side), the systems' own views (`client({ resources })`,
 * replacing the Preview or as a tab), and Info; forms that could be made are offered. The mode, page and line are
 * `v-model`s so a page keeps them in the URL. `compact` draws a small preview for cards.
 *
 * It is provided under `RESOURCE_VIEWER`, so a system's renderer can show any resource with it.
 */
import type { QualifiedName, ResourceStat, ResourceUri, SectionKey } from '@harness/core';
import { computed, ref, watch } from 'vue';
import ConfirmDialog from '../admin/components/ConfirmDialog.vue';
import { useStores } from '../state/stores.ts';
import { copyText, UiBanner, UiButton, UiDiagram, UiIconButton, UiMarkdown, UiSkeleton, UiTabs, type TabItem } from '../ui/index.ts';
import { contextConfirm } from './logic/actions.ts';
import { languageOf, typeWord } from './logic/formats.ts';
import { delimiterOf, parseDelimited } from './logic/tables.ts';
import type { ModeRead } from './logic/viewers.ts';
import CodeViewer from './viewers/CodeViewer.vue';
import FolderViewer from './viewers/FolderViewer.vue';
import HtmlPreview from './viewers/HtmlPreview.vue';
import ImageViewer from './viewers/ImageViewer.vue';
import InfoPanel from './viewers/InfoPanel.vue';
import JsonTree from './viewers/JsonTree.vue';
import MediaViewer from './viewers/MediaViewer.vue';
import OfferCard from './viewers/OfferCard.vue';
import PagesViewer from './viewers/PagesViewer.vue';
import PdfViewer from './viewers/PdfViewer.vue';
import TableViewer from './viewers/TableViewer.vue';

const props = withDefaults(defineProps<{
  uri: ResourceUri;
  /** A section of it to show. Absent shows the whole (no default: the SDK's `ResourceViewerProps` leaves it out). */
  // eslint-disable-next-line vue/require-default-prop -- an absent section is the whole resource; `RESOURCE_VIEWER`'s props have no `undefined` to default to
  section?: SectionKey;
  /** A small preview for cards: the Preview only, no switch. */
  compact?: boolean;
  /** The mode shown (`preview`, `source`, a form, `system:<name>`, `info`); the first mode when '' or unknown. */
  mode?: string;
  /** The page of a pdf or a document's pages. */
  page?: number;
  /** The line lit in code. */
  line?: number;
}>(), { compact: false, mode: '', page: 1, line: 0 });

const emit = defineEmits<{
  'update:mode': [mode: string];
  'update:page': [page: number];
  'update:line': [line: number];
  /** A link inside the resource points at another resource. */
  navigate: [uri: string];
  /** Something to tell the person (copied, made, failed). */
  notice: [text: string, tone: 'ok' | 'danger'];
  /** Context was made from the resource: the items made or updated. */
  context: [made: readonly QualifiedName[]];
  /** What is known about the resource once it has loaded (its name, type and size), for a frame's title. */
  opened: [stat: ResourceStat];
}>();

const { resources } = useStores();
const { store } = resources.viewer();

watch(() => [props.uri, props.section] as const, ([uri, section]) => { void store.open(uri, section); }, { immediate: true });
watch(() => props.mode, (mode) => { store.asked.value = mode === '' ? undefined : mode; }, { immediate: true });

const opened = computed(() => store.opened.value.value);
watch(opened, (now) => { if (now !== undefined) { emit('opened', now.stat); } }, { immediate: true });
const plan = computed(() => store.plan.value);
const current = computed(() => store.mode.value);
const tabs = computed<readonly TabItem<string>[]>(() => (plan.value?.modes ?? []).map((m) => ({ value: m.id, label: m.label })));
const shownMode = computed({ get: () => current.value?.id ?? '', set: (id: string) => { emit('update:mode', id === plan.value?.initial ? '' : id); } });

/** What the mode shown reads, and its load. */
const read = computed<ModeRead>(() => current.value?.reads ?? { as: 'none' });
const load = computed(() => store.load(read.value));
const text = computed(() => store.text(read.value)?.text ?? '');
const total = computed(() => store.text(read.value)?.total ?? 0);
const url = computed(() => store.download(read.value)?.url ?? '');
const version = computed(() => store.version(read.value));
const format = computed(() => opened.value?.stat.format);
const tables = computed(() => {
  if (version.value?.kind === 'table') { return version.value.tables; }
  return read.value.as === 'text' ? [parseDelimited(text.value, delimiterOf(format.value), opened.value?.stat.name)] : [];
});
const pages = computed(() => (version.value?.kind === 'pages' ? version.value.pages : []));
/** A pdf's page count, from its pages form when there is one. */
const pagesRead: ModeRead = { as: 'version', form: 'pages' };
const pdfPages = computed(() => {
  if (current.value?.draws !== 'pdf' || opened.value?.forms.some((f) => f.kind === 'pages') !== true) { return 0; }
  const pagesVersion = store.version(pagesRead);
  return pagesVersion?.kind === 'pages' ? pagesVersion.pages.length : 0;
});
/** The transcript beside audio and video, when there is one. */
const transcriptRead: ModeRead = { as: 'text', form: 'transcript' };
const transcript = computed(() => ((current.value?.draws === 'audio' || current.value?.draws === 'video') && opened.value?.forms.some((f) => f.kind === 'transcript') === true
  ? store.text(transcriptRead)?.text ?? '' : ''));
const systemViewer = computed(() => store.systemViewers.value.find((v) => v.system === current.value?.system));
const systemProps = computed(() => (current.value?.system === undefined ? undefined : store.systemView(current.value.system)));
const loading = computed(() => store.opened.loading.value || (load.value?.loading.value === true && load.value.value.value === undefined));

/** Links inside a resource: another resource opens here; anything else in a new tab. */
function navigate(href: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) && !/^https?:/i.test(href)) { emit('navigate', href); return; }
  window.open(href, '_blank', 'noopener');
}

async function copyUri(): Promise<void> {
  emit('notice', await copyText(props.uri) ? 'Address copied' : "Couldn't copy the address", 'ok');
}
async function download(): Promise<void> {
  const got = await store.downloadUrl();
  if (got === undefined) { emit('notice', store.making.problem.value, 'danger'); return; }
  const link = document.createElement('a');
  link.href = got.url;
  link.download = opened.value?.stat.name ?? 'download';
  link.rel = 'noopener';
  link.click();
}
async function make(): Promise<void> {
  const kind = current.value?.form;
  if (kind === undefined) { return; }
  if (await store.make(kind)) { emit('notice', 'Made it.', 'ok'); }
}
/** Making context asks first (the button's label says what it does; this says what it makes). */
const confirming = ref(false);
const confirmText = computed(() => contextConfirm([opened.value?.stat.name ?? 'this resource']));
async function makeContext(): Promise<void> {
  confirming.value = false;
  const made = await store.makeContext();
  if (made === undefined) { emit('notice', store.contexting.problem.value, 'danger'); return; }
  emit('context', [...made.created, ...made.updated]);
}
</script>

<template>
  <div class="resource-viewer" :class="{ compact }" :data-mode="current?.id" :data-draws="current?.draws" data-testid="resource-viewer">
    <UiBanner v-if="store.opened.problem.value !== ''" tone="danger">
      {{ store.opened.problem.value }}
      <template #actions><UiButton size="sm" variant="ghost" @click="store.open(uri, section)">Retry</UiButton></template>
    </UiBanner>
    <template v-if="opened && plan && current">
      <div v-if="!compact" class="bar">
        <UiTabs v-if="tabs.length > 1" v-model="shownMode" class="modes" :tabs="tabs" label="Show" data-testid="viewer-modes" />
        <span class="actions">
          <UiIconButton icon="copy" size="sm" label="Copy the address" @click="copyUri" />
          <UiIconButton v-if="opened.from === 'library'" icon="download" size="sm" label="Download" data-testid="viewer-download" @click="download" />
          <UiButton
            v-if="opened.from === 'library'" icon="book-open" size="sm" variant="ghost" title="Make context from this" :loading="store.contexting.busy.value"
            data-testid="viewer-context" @click="confirming = true"
          >
            Context
          </UiButton>
          <UiIconButton icon="refresh" size="sm" label="Reload" @click="store.open(uri, section)" />
        </span>
      </div>
      <UiBanner v-if="load?.problem.value" tone="danger">
        {{ load.problem.value }}
        <template #actions><UiButton size="sm" variant="ghost" @click="store.retry(read)">Retry</UiButton></template>
      </UiBanner>
      <UiSkeleton v-else-if="loading" shape="lines" :lines="compact ? 3 : 8" />

      <div v-else class="body" :class="`draws-${current.draws}`">
        <ImageViewer v-if="current.draws === 'image' || current.draws === 'svg'" :src="url" :alt="opened.stat.name" :compact="compact" />
        <UiDiagram v-else-if="current.draws === 'diagram'" :source="text" :language="languageOf(format) || 'mermaid'" :title="opened.stat.name" />
        <div v-else-if="current.draws === 'markdown'" class="markdown"><UiMarkdown :source="compact ? text.slice(0, 600) : text" :navigate="navigate" /></div>
        <CodeViewer
          v-else-if="current.draws === 'code' || current.draws === 'text'" :code="text" :language="current.draws === 'code' ? current.language ?? '' : ''" :filename="opened.stat.name"
          :line="line" :total="total" :compact="compact" @update:line="emit('update:line', $event)"
        />
        <HtmlPreview v-else-if="current.draws === 'html'" :html="text" :title="opened.stat.name" :compact="compact" />
        <TableViewer v-else-if="current.draws === 'table'" :tables="tables" :compact="compact" />
        <PdfViewer v-else-if="current.draws === 'pdf'" :src="url" :page="page" :pages="pdfPages" :title="opened.stat.name" @update:page="emit('update:page', $event)" />
        <PagesViewer v-else-if="current.draws === 'pages'" :pages="pages" :page="page" @update:page="emit('update:page', $event)" />
        <MediaViewer v-else-if="current.draws === 'audio' || current.draws === 'video'" :src="url" :kind="current.draws" :transcript="transcript" :title="opened.stat.name" />
        <JsonTree v-else-if="current.draws === 'json'" :text="text" :lines="format === 'jsonl'" :compact="compact" @copied="emit('notice', $event, 'ok')" />
        <FolderViewer v-else-if="current.draws === 'folder'" :links="opened.links" :base="uri" @open="emit('navigate', $event)" />
        <component :is="systemViewer.component" v-else-if="current.draws === 'system' && systemViewer && systemProps" v-bind="systemProps" />
        <OfferCard v-else-if="current.draws === 'offer' && current.offer" :offer="current.offer" :busy="store.making.busy.value" :problem="store.making.problem.value" @make="make" />
        <InfoPanel v-else-if="current.draws === 'info'" :stat="opened.stat" :record="opened.record" :forms="opened.forms" :links="opened.links" @open="emit('navigate', $event)" />
        <div v-else class="binary" data-testid="binary-view">
          <p class="dim">There is no preview for this {{ typeWord(opened.stat) }}.</p>
          <UiButton v-if="opened.from === 'library' && !compact" icon="download" @click="download">Download</UiButton>
          <UiButton v-if="plan.modes.some((m) => m.id === 'info') && !compact" variant="ghost" @click="shownMode = 'info'">Show its details</UiButton>
        </div>
      </div>
    </template>
    <UiSkeleton v-else-if="store.opened.loading.value" shape="lines" :lines="compact ? 3 : 8" />
    <ConfirmDialog
      v-model:open="confirming" :title="confirmText.title" :body="confirmText.body" :confirm="confirmText.confirm" :danger="false"
      :busy="store.contexting.busy.value" @confirm="makeContext"
    />
  </div>
</template>

<style scoped>
.resource-viewer { display: grid; gap: var(--space-3); min-width: 0; }
.bar { display: flex; align-items: center; gap: var(--space-2); min-width: 0; flex-wrap: wrap; }
/* the tabs take their own width and the actions wrap below them when both don't fit; tabs wider than the row scroll, faded */
.modes { flex: 1 1 auto; min-width: 0; }
.actions { display: flex; gap: 2px; margin-left: auto; }
.body { min-width: 0; }
.markdown { min-width: 0; overflow-wrap: anywhere; }
.compact .markdown { max-height: 220px; overflow: hidden; mask-image: linear-gradient(to bottom, #000 70%, transparent); }
.binary { display: grid; justify-items: start; gap: var(--space-2); }
.dim { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
</style>
