<script setup lang="ts">
/**
 * A document's text page by page (a pdf's `pages` form): a strip of page numbers (the current page in the URL, by
 * the page that shows it), the page's text, and previous and next.
 */
import { computed } from 'vue';
import { UiIconButton } from '../../ui/index.ts';

const props = withDefaults(defineProps<{ pages: readonly string[]; page?: number }>(), { page: 1 });
const emit = defineEmits<{ 'update:page': [page: number] }>();

const current = computed(() => Math.max(1, Math.min(props.pages.length, props.page)));
const text = computed(() => props.pages[current.value - 1] ?? '');
const go = (page: number): void => { emit('update:page', Math.max(1, Math.min(props.pages.length, page))); };
</script>

<template>
  <div class="pages-viewer" data-testid="pages-view">
    <nav class="strip" aria-label="Pages">
      <UiIconButton icon="chevron-left" size="sm" label="Previous page" :disabled="current <= 1" @click="go(current - 1)" />
      <ol class="numbers">
        <li v-for="n in pages.length" :key="n">
          <button type="button" class="number" :class="{ current: n === current }" :aria-current="n === current ? 'page' : undefined" @click="go(n)">{{ n }}</button>
        </li>
      </ol>
      <UiIconButton icon="chevron-right" size="sm" label="Next page" :disabled="current >= pages.length" @click="go(current + 1)" />
    </nav>
    <article class="page" :aria-label="`Page ${current} of ${pages.length}`">
      <p v-if="text.trim() === ''" class="dim">This page has no text.</p>
      <div v-else class="text">{{ text }}</div>
    </article>
  </div>
</template>

<style scoped>
.pages-viewer { display: grid; gap: var(--space-2); min-width: 0; }
.strip { display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.numbers { display: flex; gap: 2px; margin: 0; padding: 2px; list-style: none; overflow-x: auto; flex: 1; min-width: 0; }
.number { min-width: 28px; height: 28px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text-dim); font: var(--text-xs) var(--mono); cursor: pointer; }
.number.current { border-color: var(--accent); background: color-mix(in oklab, var(--accent) 14%, transparent); color: var(--text); }
.number:focus-visible { outline: none; box-shadow: var(--ring); }
.page { padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-sm); line-height: var(--leading); }
.dim { margin: 0; color: var(--text-faint); }
</style>
