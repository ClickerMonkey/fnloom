<script setup lang="ts">
/** The note attachment: a note's title, text and tags, as `add` and `review` attach it to the assistant's message. */
import type { AttachmentViewOf } from '@harness/sdk';
import type { notes } from '../shared/index.ts';

const view = defineProps<AttachmentViewOf<typeof notes, 'note'>>();
</script>

<template>
  <article class="card">
    <h3 class="title">{{ view.data.title }}</h3>
    <p class="text">{{ view.data.text }}</p>
    <p class="meta">{{ view.data.tags.map((tag) => `#${tag}`).join(' ') }} · {{ view.data.updatedAt.toLocaleString() }}</p>
  </article>
</template>

<style scoped>
.card { display: grid; gap: var(--space-1); min-width: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.title { margin: 0; font-size: var(--text-md); }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.meta { margin: 0; color: var(--text-dim); font-size: var(--text-xs); }
</style>
