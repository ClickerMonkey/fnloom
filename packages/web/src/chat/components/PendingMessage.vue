<script setup lang="ts">
/**
 * Your message while it is on its way to the hub: drawn at once where it will land (your own bubble, a little faded),
 * with what is happening to it under it: sending, or waiting for the connection when the hub can't be reached (it
 * goes as soon as it is back). The hub's stored copy replaces it; a failed send puts it back in the composer.
 */
import type { OutgoingPart, QualifiedName } from '@harness/core';
import { UiIcon, UiSpinner } from '../../ui/index.ts';
import PartList from './PartList.vue';

defineProps<{
  parts: readonly OutgoingPart[];
  commandName: (context: QualifiedName) => string;
  /** The hub can't be reached now: the message waits for the connection. */
  queued: boolean;
}>();
</script>

<template>
  <div class="pending-message" :data-state="queued ? 'queued' : 'sending'" data-testid="pending-message">
    <div class="column">
      <div class="bubble"><PartList :parts="parts" :command-name="commandName" /></div>
      <p class="state" role="status">
        <template v-if="queued"><UiIcon name="clock" :size="13" /> Waiting for the connection. It sends when the hub is back.</template>
        <template v-else><UiSpinner :size="12" /> Sending…</template>
      </p>
    </div>
  </div>
</template>

<style scoped>
.pending-message { display: flex; justify-content: flex-end; min-width: 0; padding: var(--space-1) 0; animation: ui-rise-in var(--medium) var(--ease); }
.column { display: grid; justify-items: end; gap: var(--space-1); min-width: 0; max-width: min(85%, var(--readable)); }
.bubble {
  display: grid; min-width: 0; max-width: 100%; padding: var(--space-2) var(--space-4); border-radius: var(--radius-lg); border-bottom-right-radius: var(--radius-sm);
  background: var(--accent); color: var(--on-accent); line-height: var(--leading); opacity: 0.72; transition: opacity var(--medium) var(--ease);
}
[data-state='queued'] .bubble { opacity: 0.55; }
.state { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; margin: 0; padding: 0 var(--space-1); color: var(--text-faint); font-size: var(--text-xs); }
</style>
