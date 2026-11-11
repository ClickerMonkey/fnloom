<script setup lang="ts">
/**
 * Fn runs in call order, each as its fn's display says: a card (`RunCard`), or one line of text that opens the run.
 * Used for the runs of an answer, alone or inside a collapsed group.
 */
import type { Display, RunId } from '@harness/core';
import { UiIcon } from '../../ui/index.ts';
import { runMessage, type RunView } from '../logic/runs.ts';
import RunCard from './RunCard.vue';
import type { RenderView } from './types.ts';

defineProps<{
  runs: readonly RunView[];
  now: number;
  collapsed: (run: RunView) => boolean;
  viewOf: (run: RunView) => RenderView<'fn'> | undefined;
  /** How each run shows now (`card` or `message`; hidden runs are left out before). */
  showOf: (run: RunView) => Display;
}>();
const emit = defineEmits<{ open: [run: RunId]; toggle: [run: RunId, collapsed: boolean]; background: [run: RunId] }>();
</script>

<template>
  <div class="runs">
    <template v-for="run in runs" :key="run.id">
      <button v-if="showOf(run) === 'message'" type="button" class="run-message" data-testid="run-message" :data-run="run.id" @click="emit('open', run.id)">
        <UiIcon name="fn" :size="14" />
        <span class="run-message-text">{{ runMessage(run) }}</span>
      </button>
      <RunCard
        v-else :run="run" :now="now" :collapsed="collapsed(run)" :view="viewOf(run)"
        @open="emit('open', run.id)" @toggle="emit('toggle', run.id, $event)" @background="emit('background', run.id)"
      />
    </template>
  </div>
</template>

<style scoped>
.runs { display: grid; gap: var(--space-2); min-width: 0; }
.run-message {
  display: flex; align-items: flex-start; gap: var(--space-2); min-width: 0; padding: var(--space-1) var(--space-2); border: 0; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-dim); font-size: var(--text-sm); line-height: var(--leading-tight); text-align: left;
  transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease);
}
.run-message:hover { background: var(--surface-2); color: var(--text); }
.run-message:focus-visible { outline: none; box-shadow: var(--ring); }
.run-message :deep(.ui-icon) { flex: none; margin-top: 1px; color: var(--text-faint); }
.run-message-text { min-width: 0; overflow-wrap: anywhere; }
</style>
