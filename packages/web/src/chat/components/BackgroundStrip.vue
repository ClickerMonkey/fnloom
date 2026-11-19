<script setup lang="ts">
/**
 * Runs moved to the background, as a thin strip above the composer: each with its live status and its fn (a `FnPill`,
 * which opens the fn modal); tapping its status or time opens the run's details. It scrolls sideways rather than grow, so it never pushes the composer off a phone screen.
 */
import type { RunId } from '@harness/core';
import { formatDuration } from '../logic/format.ts';
import FnPill from '../../fns/components/FnPill.vue';
import { fnLabel } from '../logic/labels.ts';
import { runElapsed, type RunView } from '../logic/runs.ts';
import RunDot from './RunDot.vue';

defineProps<{ runs: readonly RunView[]; now: number }>();
const emit = defineEmits<{ open: [run: RunId] }>();
</script>

<template>
  <div v-if="runs.length > 0" class="strip" role="region" aria-label="Background work" data-testid="background-strip">
    <span class="label">Background</span>
    <ul class="runs">
      <li v-for="run in runs" :key="run.id" class="run">
        <button type="button" class="open" :data-run="run.id" :aria-label="`Open the run of ${fnLabel(run.fn)}`" @click="emit('open', run.id)">
          <RunDot :status="run.status" />
          <span v-if="runElapsed(run, now) !== undefined" class="time">{{ formatDuration(runElapsed(run, now) ?? 0) }}</span>
        </button>
        <FnPill :name="run.fn" class="fn" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.strip { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.label { flex: none; color: var(--text-faint); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.runs { display: flex; gap: var(--space-1); min-width: 0; margin: 0; padding: 2px; overflow-x: auto; list-style: none; scrollbar-width: none; }
.run {
  display: inline-flex; align-items: center; gap: 2px; height: 30px; padding: 0 3px 0 0; border: 1px solid var(--border);
  border-radius: var(--radius-full); background: var(--surface); white-space: nowrap;
}
.open {
  display: inline-flex; align-items: center; gap: var(--space-2); height: 100%; padding: 0 var(--space-2) 0 var(--space-3); border: 0;
  border-radius: var(--radius-full); background: transparent; color: var(--text); font-size: var(--text-sm);
}
.open:hover { background: var(--surface-2); }
.open:focus-visible { outline: none; box-shadow: var(--ring); }
.fn { flex: none; }
.time { color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
</style>
