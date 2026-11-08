<script setup lang="ts">
/**
 * Markdown, rendered safely (no HTML from the source reaches the page) and styled for reading: comfortable spacing,
 * code and tables that scroll inside themselves, long words that wrap. Images open large in a viewer. Handles text
 * that is still streaming in.
 */
import { computed, ref, type FunctionalComponent } from 'vue';
import UiImageViewer from '../UiImageViewer.vue';
import { parseMarkdown } from './parse.ts';
import { renderBlocks } from './render.ts';

const props = withDefaults(defineProps<{
  source: string;
  /** Handle links inside the app (`/…`), such as with the router. */
  navigate?: ((href: string) => void) | undefined;
}>(), { navigate: undefined });

const emit = defineEmits<{ copied: [ok: boolean] }>();
const blocks = computed(() => parseMarkdown(props.source));
const viewing = ref<{ src: string; alt: string } | undefined>(undefined);
const viewerOpen = computed({ get: () => viewing.value !== undefined, set: (open) => { if (!open) { viewing.value = undefined; } } });
const Blocks: FunctionalComponent = () => renderBlocks(blocks.value, {
  navigate: props.navigate, copied: (ok) => { emit('copied', ok); }, view: (src, alt) => { viewing.value = { src, alt }; },
});
</script>

<template>
  <div class="ui-markdown">
    <Blocks />
    <UiImageViewer v-if="viewing" v-model:open="viewerOpen" :src="viewing.src" :alt="viewing.alt" />
  </div>
</template>

<style scoped>
.ui-markdown { min-width: 0; overflow-wrap: anywhere; line-height: var(--leading); }
.ui-markdown > :deep(:first-child) { margin-top: 0; }
.ui-markdown > :deep(:last-child) { margin-bottom: 0; }
.ui-markdown :deep(p), .ui-markdown :deep(ul), .ui-markdown :deep(ol), .ui-markdown :deep(blockquote), .ui-markdown :deep(.md-block), .ui-markdown :deep(.md-table) { margin: 0 0 var(--space-3); }
.ui-markdown :deep(h1), .ui-markdown :deep(h2), .ui-markdown :deep(h3), .ui-markdown :deep(h4), .ui-markdown :deep(h5), .ui-markdown :deep(h6) { margin: var(--space-5) 0 var(--space-2); font-weight: var(--weight-strong); }
.ui-markdown :deep(h1) { font-size: var(--text-2xl); }
.ui-markdown :deep(h2) { font-size: var(--text-xl); }
.ui-markdown :deep(h3) { font-size: var(--text-lg); }
.ui-markdown :deep(h4), .ui-markdown :deep(h5), .ui-markdown :deep(h6) { font-size: var(--text-md); }
.ui-markdown :deep(ul), .ui-markdown :deep(ol) { padding-left: 1.5em; }
.ui-markdown :deep(li) { margin: 2px 0; }
.ui-markdown :deep(li > p) { margin: 0; }
.ui-markdown :deep(li > ul), .ui-markdown :deep(li > ol) { margin: 2px 0 0; }
.ui-markdown :deep(.md-tasks) { list-style: none; padding-left: 0.25em; }
.ui-markdown :deep(.md-task) { display: flex; align-items: baseline; gap: var(--space-2); }
.ui-markdown :deep(.md-task input) { accent-color: var(--accent); margin: 0; transform: translateY(1px); }
.ui-markdown :deep(blockquote) { padding: 2px 0 2px var(--space-4); border-left: 3px solid var(--border-strong); color: var(--text-dim); }
.ui-markdown :deep(hr) { margin: var(--space-5) 0; border: 0; border-top: 1px solid var(--border); }
.ui-markdown :deep(.md-code) { padding: 1px 5px; border-radius: 5px; background: var(--surface-3); font: 0.88em var(--mono); }
.ui-markdown :deep(a) { text-decoration: underline; text-decoration-color: color-mix(in oklab, var(--accent) 40%, transparent); text-underline-offset: 2px; }
.ui-markdown :deep(a:hover) { text-decoration-color: var(--accent); }
.ui-markdown :deep(.md-image) { display: block; max-width: 100%; height: auto; border-radius: var(--radius); }
.ui-markdown :deep(.md-image-open) { display: block; max-width: 100%; padding: 0; border: 0; border-radius: var(--radius); background: transparent; cursor: zoom-in; }
.ui-markdown :deep(.md-image-open:focus-visible) { outline: none; box-shadow: var(--ring); }
.ui-markdown :deep(.md-resource) { text-decoration: none; }
.ui-markdown :deep(.md-resource .md-code) { color: var(--accent); }
.ui-markdown :deep(.md-table) { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); }
.ui-markdown :deep(table) { width: 100%; border-collapse: collapse; font-size: var(--text-sm); overflow-wrap: normal; }
.ui-markdown :deep(th), .ui-markdown :deep(td) { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.ui-markdown :deep(th) { background: var(--surface-2); font-weight: var(--weight-medium); white-space: nowrap; }
.ui-markdown :deep(tr:last-child td) { border-bottom: 0; }
.ui-markdown :deep(.md-math) { font-size: 1.05em; }
.ui-markdown :deep(.md-math-wrap) { max-width: 100%; overflow-x: auto; padding: var(--space-2) 0; }
.ui-markdown :deep(.md-math-wrap:focus-visible) { outline: none; box-shadow: var(--ring); border-radius: var(--radius); }
.ui-markdown :deep(.md-math-block) { font-size: 1.15em; }
.ui-markdown :deep(.md-math-unknown) { color: var(--danger); }
</style>
