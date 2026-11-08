<script setup lang="ts">
/**
 * A pdf, one page at a time (`page`, kept in the URL by the page that shows it), drawn by the app's pdf engine
 * (`PDF_DOCUMENTS`, pdf.js) at the width it is shown, so it reads the same on a phone as on a desktop. Previous and
 * next and a page box move through it; the page count comes from the document (or its `pages` form until it opens).
 * Without an engine, or when the pdf won't open there, the browser's own pdf viewer shows it instead. Open links to
 * the pdf itself either way.
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { UiIcon, UiIconButton, UiInput, UiSkeleton } from '../../ui/index.ts';
import { clampPage, PDF_DOCUMENTS, type PdfDocument } from '../logic/pdf.ts';

const props = withDefaults(defineProps<{ src: string; page?: number; pages?: number; title?: string }>(), { page: 1, pages: 0, title: 'Document' });
const emit = defineEmits<{ 'update:page': [page: number] }>();

const engine = inject(PDF_DOCUMENTS, undefined);
const opened = shallowRef<PdfDocument | undefined>(undefined);
const failed = ref(engine === undefined);
const drawing = ref(false);
const canvas = ref<HTMLCanvasElement>();
const frame = ref<HTMLElement>();
const width = ref(0);
const typed = ref(String(props.page));
const count = computed(() => opened.value?.pages ?? props.pages);
const frameSrc = computed(() => `${props.src}#page=${props.page}`);
let generation = 0;

watch(() => props.page, (page) => { typed.value = String(page); });
const go = (page: number): void => { emit('update:page', clampPage(page, count.value)); };
function submit(): void {
  const n = Number.parseInt(typed.value, 10);
  if (Number.isFinite(n)) { go(n); }
}

async function close(): Promise<void> {
  const was = opened.value;
  opened.value = undefined;
  await was?.close().catch(() => undefined);
}

watch(() => props.src, async (src) => {
  const mine = ++generation;
  await close();
  if (engine === undefined) { return; }
  failed.value = false;
  try {
    const document = await engine.open(src);
    if (mine !== generation) { await document.close(); return; }
    opened.value = document;
  } catch {
    if (mine === generation) { failed.value = true; }
  }
}, { immediate: true });

watch(() => [opened.value, props.page, width.value, canvas.value] as const, async ([document, page, shown, target]) => {
  if (document === undefined || target === undefined || shown <= 0) { return; }
  const mine = generation;
  drawing.value = true;
  try {
    await document.draw(clampPage(page, document.pages), target, shown, window.devicePixelRatio || 1);
  } catch {
    if (mine === generation) { failed.value = true; }
  } finally {
    drawing.value = false;
  }
});

let observer: ResizeObserver | undefined;
onMounted(() => {
  if (frame.value === undefined || typeof ResizeObserver === 'undefined') { return; }
  observer = new ResizeObserver(([entry]) => { width.value = Math.floor(entry?.contentRect.width ?? 0); });
  observer.observe(frame.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  generation++;
  void close();
});
</script>

<template>
  <div class="pdf-viewer" data-testid="pdf-view">
    <div class="tools">
      <UiIconButton icon="chevron-left" size="sm" label="Previous page" :disabled="page <= 1" @click="go(page - 1)" />
      <form class="page" @submit.prevent="submit">
        <UiInput v-model="typed" type="number" label="Page" hide-label size="sm" @enter="submit" />
      </form>
      <span v-if="count > 0" class="of" data-testid="pdf-pages">of {{ count }}</span>
      <UiIconButton icon="chevron-right" size="sm" label="Next page" :disabled="count > 0 && page >= count" @click="go(page + 1)" />
      <a :href="frameSrc" target="_blank" rel="noopener noreferrer" class="open"><UiIcon name="external" :size="14" />Open</a>
    </div>
    <iframe v-if="failed" :key="frameSrc" class="frame" :src="frameSrc" :title="title" data-testid="pdf-frame"></iframe>
    <div v-else ref="frame" class="sheet" data-testid="pdf-sheet">
      <UiSkeleton v-if="opened === undefined || drawing" class="placeholder" />
      <canvas ref="canvas" :class="{ hidden: opened === undefined }" :aria-label="`${title}, page ${page}`" role="img"></canvas>
    </div>
  </div>
</template>

<style scoped>
.pdf-viewer { display: grid; gap: var(--space-2); min-width: 0; }
.tools { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1); }
.page { width: 5.5rem; }
.of { color: var(--text-faint); font-size: var(--text-sm); }
.open { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; padding: 0 var(--space-2); color: var(--accent); font-size: var(--text-sm); text-decoration: none; }
.open:focus-visible { outline: none; box-shadow: var(--ring); border-radius: 6px; }
.frame { width: 100%; height: min(75dvh, 900px); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
.sheet { position: relative; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); overflow: hidden; }
.sheet canvas { display: block; max-width: 100%; background: #fff; }
.sheet canvas.hidden { visibility: hidden; height: min(60dvh, 600px); }
.placeholder { position: absolute; inset: var(--space-2); }
</style>
