<script setup lang="ts">
/**
 * A pdf in the browser's own pdf viewer, opened at a page (`page`, kept in the URL by the page that shows it), with
 * a page box and previous and next when the page count is known (from its `pages` form). Where the browser can't
 * draw pdfs inline (some phones), the open and download links still work, and the Pages tab has its text.
 */
import { computed, ref, watch } from 'vue';
import { UiIcon, UiIconButton, UiInput } from '../../ui/index.ts';

const props = withDefaults(defineProps<{ src: string; page?: number; pages?: number; title?: string }>(), { page: 1, pages: 0, title: 'Document' });
const emit = defineEmits<{ 'update:page': [page: number] }>();

const typed = ref(String(props.page));
watch(() => props.page, (page) => { typed.value = String(page); });
const frameSrc = computed(() => `${props.src}#page=${props.page}`);
const go = (page: number): void => { emit('update:page', Math.max(1, props.pages > 0 ? Math.min(props.pages, page) : page)); };
function submit(): void {
  const n = Number.parseInt(typed.value, 10);
  if (Number.isFinite(n)) { go(n); }
}
</script>

<template>
  <div class="pdf-viewer" data-testid="pdf-view">
    <div class="tools">
      <UiIconButton icon="chevron-left" size="sm" label="Previous page" :disabled="page <= 1" @click="go(page - 1)" />
      <form class="page" @submit.prevent="submit">
        <UiInput v-model="typed" type="number" label="Page" hide-label size="sm" @enter="submit" />
      </form>
      <span v-if="pages > 0" class="of">of {{ pages }}</span>
      <UiIconButton icon="chevron-right" size="sm" label="Next page" :disabled="pages > 0 && page >= pages" @click="go(page + 1)" />
      <a :href="frameSrc" target="_blank" rel="noopener noreferrer" class="open"><UiIcon name="external" :size="14" />Open</a>
    </div>
    <iframe :key="frameSrc" class="frame" :src="frameSrc" :title="title"></iframe>
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
</style>
