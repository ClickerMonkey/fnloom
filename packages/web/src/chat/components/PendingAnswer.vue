<script setup lang="ts">
/**
 * The agent's answer before its first word: its avatar with a typing indicator and the status line, in the row the
 * answer will take, so the first token or run replaces it in place (never a second avatar under a real one).
 */
import { UiAvatar } from '../../ui/index.ts';
import type { StatusLine as Line } from '../logic/runs.ts';
import StatusLine from './StatusLine.vue';
import TypingDots from './TypingDots.vue';

defineProps<{ authorName: string; line: Line }>();
const emit = defineEmits<{ tree: [] }>();
</script>

<template>
  <div class="pending" data-testid="pending-answer">
    <UiAvatar :name="authorName" kind="agent" :size="28" />
    <div class="column">
      <span class="author">{{ authorName }}</span>
      <TypingDots label="The agent is working" />
      <StatusLine v-if="line.groups.length > 0 || line.lead !== 'Thinking…'" :line="line" @tree="emit('tree')" />
    </div>
  </div>
</template>

<style scoped>
.pending { display: flex; gap: var(--space-3); padding: var(--space-1) 0; animation: ui-fade-in var(--medium) var(--ease); }
.column { display: grid; gap: var(--space-1); min-width: 0; }
.author { font-weight: var(--weight-medium); font-size: var(--text-sm); line-height: 28px; }
</style>
