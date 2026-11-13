<script setup lang="ts">
/**
 * A session's transcript as rows: the person's messages, Claude's answers (markdown), its thinking (folded), each tool
 * use in a line (the tool and what it does) that opens to its input and result, and notes. It shows the newest page
 * first; earlier pages are read with "Show earlier" above it.
 */
import { computed } from 'vue';
import { UiButton, UiCodeBlock, UiIcon, UiMarkdown, UiSpinner } from '../../ui/index.ts';
import type { ClaudeTranscriptItem } from '@harness/core';
import { transcriptRows } from '../logic/claude.ts';

const props = defineProps<{
  items: readonly ClaudeTranscriptItem[];
  /** Earlier entries come before the ones shown. */
  more: boolean;
  loading: boolean;
}>();
const emit = defineEmits<{ more: [] }>();

const rows = computed(() => transcriptRows(props.items));
const json = (value: unknown): string => JSON.stringify(value, null, 2);
</script>

<template>
  <ol class="transcript" data-testid="claude-transcript">
    <li v-if="loading" class="row loading"><UiSpinner :size="16" /></li>
    <li v-else-if="more" class="row loading"><UiButton size="sm" variant="ghost" data-testid="transcript-more" @click="emit('more')">Show earlier</UiButton></li>
    <li v-for="row in rows" :key="row.key" :class="['row', `row-${row.type}`]" :data-type="row.type">
      <p v-if="row.type === 'user'" class="user">{{ row.text }}</p>
      <div v-else-if="row.type === 'assistant'" class="assistant"><UiMarkdown :source="row.text" /></div>
      <details v-else-if="row.type === 'thinking'" class="fold">
        <summary><UiIcon name="sparkles" :size="13" /><span>Thinking</span></summary>
        <p class="thought">{{ row.text }}</p>
      </details>
      <details v-else-if="row.type === 'tool'" class="fold tool" data-testid="transcript-tool">
        <summary>
          <UiIcon :name="row.result === undefined ? 'clock' : row.result.ok ? 'check' : 'warning'" :size="13" :class="{ failed: row.result?.ok === false }" />
          <span class="tool-name">{{ row.tool }}</span>
          <code v-if="row.summary" class="summary">{{ row.summary }}</code>
        </summary>
        <div class="tool-body">
          <UiCodeBlock :code="json(row.input)" language="json" wrap :max-height="240" />
          <UiCodeBlock v-if="row.result" :code="row.result.text || '(no output)'" wrap :max-height="240" :filename="row.result.ok ? 'Result' : 'Failed'" />
        </div>
      </details>
      <p v-else class="note">{{ row.text }}</p>
    </li>
  </ol>
</template>

<style scoped>
.transcript { display: grid; gap: var(--space-2); min-width: 0; margin: 0; padding: 0; list-style: none; }
.row { min-width: 0; }
.user { justify-self: end; max-width: min(85%, 640px); margin: 0 0 0 auto; padding: var(--space-2) var(--space-3); border-radius: var(--radius-lg); background: var(--accent-soft); white-space: pre-wrap; overflow-wrap: anywhere; width: fit-content; }
.assistant { min-width: 0; overflow-wrap: anywhere; }
.fold { min-width: 0; color: var(--text-dim); font-size: var(--text-sm); }
.fold > summary { display: flex; align-items: center; gap: var(--space-2); min-width: 0; padding: 2px var(--space-1); border-radius: var(--radius-sm); cursor: pointer; list-style: none; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary:hover { background: var(--surface-2); }
.tool-name { flex: none; color: var(--text); font-weight: var(--weight-medium); }
.summary { overflow: hidden; min-width: 0; text-overflow: ellipsis; white-space: nowrap; }
.failed { color: var(--danger); }
.tool-body { display: grid; gap: var(--space-2); min-width: 0; margin: var(--space-2) 0 var(--space-2) var(--space-5); }
.thought { margin: var(--space-1) 0 0 var(--space-5); white-space: pre-wrap; overflow-wrap: anywhere; }
.note { margin: 0; color: var(--text-faint); font-size: var(--text-xs); text-align: center; overflow-wrap: anywhere; }
.loading { display: flex; justify-content: center; padding: var(--space-2); }
</style>
