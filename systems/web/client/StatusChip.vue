<script setup lang="ts">
/**
 * A run's status chip on the web cards: a short label with a dot, coloured by its tone, the dot pulsing while the run
 * is busy. The search card and the page card both draw it.
 */
import type { Chip } from './view.ts';

defineProps<{ chip: Chip }>();
</script>

<template>
  <span class="chip" :class="chip.tone" role="status"><span class="dot" aria-hidden="true" />{{ chip.label }}</span>
</template>

<style scoped>
.chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  line-height: 18px;
  white-space: nowrap;
  background: var(--surface-2);
  color: var(--text-dim);
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.chip.busy { color: var(--accent); background: var(--accent-soft); }
.chip.busy .dot { animation: pulse 1.2s var(--ease) infinite; }
.chip.ok { color: var(--ok); background: var(--ok-soft); }
.chip.bad { color: var(--danger); background: var(--danger-soft); }
@keyframes pulse { 50% { opacity: 0.35; transform: scale(0.8); } }
@media (prefers-reduced-motion: reduce) {
  .chip.busy .dot { animation: none; }
}
</style>
