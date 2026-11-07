<script setup lang="ts">
/**
 * The one line under an answer in flight that sums up what is happening now: grouped runs, most active first
 * ("Read file ×3…  ·  Write file"), "+2 more", or "Thinking…" before anything reports. Finished groups fade out.
 * Clicking it opens the turn's tree.
 */
import { UiIcon } from '../../ui/index.ts';
import type { StatusLine } from '../logic/runs.ts';

defineProps<{ line: StatusLine }>();
const emit = defineEmits<{ tree: [] }>();
</script>

<template>
  <button type="button" class="status-line" data-testid="status-line" aria-live="polite" @click="emit('tree')">
    <span class="pulse" aria-hidden="true"><span /><span /><span /></span>
    <span v-if="line.lead !== ''" class="lead">{{ line.lead }}</span>
    <TransitionGroup name="group" tag="span" class="groups">
      <span v-for="group in line.groups" :key="group.key" class="group" :class="`tone-${group.tone} phase-${group.phase}`" :data-fn="group.fn">{{ group.text }}</span>
    </TransitionGroup>
    <span v-if="line.more > 0" class="more">+{{ line.more }} more</span>
    <UiIcon class="open" name="chevron-right" :size="14" />
  </button>
</template>

<style scoped>
.status-line {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1) var(--space-2); max-width: 100%; min-height: 32px; padding: var(--space-1) var(--space-2);
  border: 0; border-radius: var(--radius); background: transparent; color: var(--text-dim); font-size: var(--text-sm); text-align: left;
}
.status-line:hover { background: var(--surface-2); }
.status-line:focus-visible { outline: none; box-shadow: var(--ring); }
.pulse { display: inline-flex; gap: 3px; }
.pulse span { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: ui-pulse 1.2s var(--ease-in-out) infinite; }
.pulse span:nth-child(2) { animation-delay: 0.15s; }
.pulse span:nth-child(3) { animation-delay: 0.3s; }
.lead { color: var(--text); }
.groups { display: inline-flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); min-width: 0; }
.group { color: var(--tone); overflow-wrap: anywhere; }
.group.phase-done { color: var(--text-faint); }
.more { color: var(--text-faint); }
.open { color: var(--text-faint); }
.group-enter-active, .group-leave-active { transition: opacity var(--slow) var(--ease), transform var(--slow) var(--ease); }
.group-enter-from { opacity: 0; transform: translateY(3px); }
.group-leave-to { opacity: 0; }
</style>
