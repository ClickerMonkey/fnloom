<script setup lang="ts">
/**
 * A resource view: a "Words" tab beside the hub's own preview of every markdown resource (notes are served as markdown),
 * counting its words and headings. It reads the text through the view, so it works for any system's markdown.
 */
import type { ResourceView, WithSystem } from '@harness/sdk';
import { ref, watchEffect } from 'vue';
import type { NotesContract } from '../shared/index.ts';

const view = defineProps<ResourceView & WithSystem<NotesContract['defs']>>();
const counts = ref<{ words: number; headings: number } | undefined>(undefined);
const problem = ref('');

watchEffect(() => {
  const version = view.stat.version;
  view.text().then((text) => {
    if (view.stat.version !== version) { return; }
    counts.value = { words: text.split(/\s+/).filter((word) => word !== '').length, headings: text.split('\n').filter((line) => line.startsWith('#')).length };
    problem.value = '';
  }).catch((error: unknown) => { problem.value = error instanceof Error ? error.message : 'It could not be read.'; });
});
</script>

<template>
  <section class="words" aria-live="polite">
    <p v-if="problem" class="problem">{{ problem }}</p>
    <p v-else-if="counts"><strong>{{ counts.words }}</strong> words, <strong>{{ counts.headings }}</strong> headings in {{ view.stat.name }}</p>
    <p v-else class="dim">Counting…</p>
  </section>
</template>

<style scoped>
.words { padding: var(--space-3); }
.words p { margin: 0; }
.dim { color: var(--text-dim); }
.problem { color: var(--danger); }
</style>
