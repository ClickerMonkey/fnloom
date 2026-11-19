<script setup lang="ts">
/**
 * The Notes page (`/s/notes/notes`): every note, searched by the hub (never filtered here), with the search in the URL
 * (`?q=`) so a refresh or a shared link shows the same list. It draws with the app's own frame, search input, load state and markdown,
 * from `host.components`, so it looks like the rest of the app.
 */
import type { PageViewOf } from '@harness/sdk';
import { ref, watch } from 'vue';
import type { NotesContract } from '../shared/index.ts';

const view = defineProps<PageViewOf<NotesContract>>();
const { Frame, Input, LoadState, Markdown } = view.host.components;
// `?q=` bound two ways: typing changes the URL, and the URL fills the box
const search = view.host.query.bind('q');
const records = view.host.hub.caller('records', { lastOnly: true });

const notes = ref<readonly { id: string; title: string; text: string }[]>([]);
const loading = ref(true);
const problem = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    // the hub searches its database: words in the title and text, and by meaning
    const words = search.value.trim();
    const page = await records.call({ type: 'notes/Note', ...(words === '' ? {} : { search: words }) });
    notes.value = page.items.map((record) => {
      const value = record.value;
      const text = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value['text'] === 'string' ? value['text'] : '';
      return { id: record.id, title: record.title, text };
    });
    problem.value = '';
  } catch (error) {
    problem.value = error instanceof Error ? error.message : 'The notes could not be read.';
  } finally {
    loading.value = false;
  }
}
watch(() => search.value, () => { void load(); }, { immediate: true });
</script>

<template>
  <Frame title="Notes" description="Every note, searched by the hub.">
    <Input v-model="search.value" class="search" type="search" icon="search" label="Search notes" hide-label clearable placeholder="Search notes" />
    <LoadState :loading="loading" :problem="problem" :ready="notes.length > 0" :empty="!loading && notes.length === 0" empty-title="No notes" @retry="load">
      <ul class="notes">
        <li v-for="note in notes" :key="note.id" class="note">
          <h2>{{ note.title }}</h2>
          <Markdown :source="note.text" />
        </li>
      </ul>
    </LoadState>
  </Frame>
</template>

<style scoped>
.search { max-width: 32rem; margin-bottom: var(--space-3); }
.notes { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr)); }
.note { min-width: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.note h2 { margin: 0 0 var(--space-2); font-size: var(--text-md, 1rem); }
</style>
