<script setup lang="ts">
/**
 * One run in an answer: its status dot, friendly label, what it is about, and what it is doing now in plain words,
 * with a ticking elapsed time and its cost. Progress shows as a bar or steps. A failed run says why in place of its
 * summary. The body is the fn's own renderer when its system has one, otherwise the result in brief. The card
 * collapses to its one line; clicking the line opens the run's details.
 */
import { computed } from 'vue';
import { UiIcon, UiIconButton } from '../../ui/index.ts';
import { formatCost, formatDuration } from '../logic/format.ts';
import { fnLabel } from '../logic/labels.ts';
import { isSettled } from '@harness/core';
import { argSummary, isBusy, resultBrief, runElapsed, runError, runResult, runText, shownStatus, type RunView } from '../logic/runs.ts';
import RendererHost from './RendererHost.vue';
import RunDot from './RunDot.vue';
import RunProgress from './RunProgress.vue';
import type { RenderView } from './types.ts';

const props = withDefaults(defineProps<{
  run: RunView;
  now: number;
  collapsed: boolean;
  /** The fn's renderer and its props, when its system has one. */
  view?: RenderView<'fn'> | undefined;
  /** Who started it, when it wasn't the agent ("You ran this"). */
  byline?: string;
}>(), { view: undefined, byline: '' });

const emit = defineEmits<{ open: []; toggle: [collapsed: boolean]; background: [] }>();

const label = computed(() => fnLabel(props.run.fn));
const about = computed(() => argSummary(props.run.args));
const error = computed(() => runError(props.run));
const result = computed(() => runResult(props.run));
const elapsed = computed(() => runElapsed(props.run, props.now));
const active = computed(() => isBusy(props.run));
const status = computed(() => shownStatus(props.run));
const brief = computed(() => resultBrief(result.value));
const showStatus = computed(() => !isSettled(props.run.status) || props.run.background || props.byline !== '');
const showResult = computed(() => props.view === undefined && brief.value !== '' && props.run.status === 'done');
const hasBody = computed(() => showStatus.value || (props.run.progress !== undefined && !isSettled(props.run.status)) || props.view !== undefined || showResult.value);
const canBackground = computed(() => props.run.allowed?.background === true && !props.run.background && !isSettled(props.run.status));
</script>

<template>
  <article
    class="run-card" :class="[`status-${status}`, { active, collapsed, asking: run.asking === true }]" data-testid="run-card" :data-run="run.id" :data-status="status"
    :aria-label="`${label}: ${runText(run)}`"
  >
    <header class="line">
      <button type="button" class="summary" :aria-expanded="collapsed ? 'false' : 'true'" @click="emit('open')">
        <RunDot :status="status" />
        <span class="label">{{ label }}</span>
        <span v-if="error" class="about error-text" :title="error.message">{{ error.message }}</span>
        <span v-else-if="about !== ''" class="about" :title="about">{{ about }}</span>
      </button>
      <span class="metrics">
        <span v-if="run.attempt > 1" class="attempt" :title="`Attempt ${run.attempt}`">×{{ run.attempt }}</span>
        <span v-if="elapsed !== undefined" class="elapsed" :class="{ ticking: active }">{{ formatDuration(elapsed) }}</span>
        <span v-if="run.totalCost > 0" class="cost" :title="`This run ${formatCost(run.cost)}, with everything it called ${formatCost(run.totalCost)}`">{{ formatCost(run.totalCost) }}</span>
      </span>
      <UiIconButton v-if="canBackground" size="sm" icon="arrow-right" label="Move to background" @click="emit('background')" />
      <UiIconButton size="sm" :icon="collapsed ? 'chevron-down' : 'chevron-up'" :label="collapsed ? 'Expand' : 'Collapse'" @click="emit('toggle', !collapsed)" />
    </header>
    <div v-if="!collapsed && hasBody" class="body">
      <p v-if="showStatus" class="status" data-testid="run-status">
        <span v-if="byline !== ''" class="byline">{{ byline }} · </span><span :class="{ shimmer: active }">{{ runText(run) }}</span>
        <span v-if="run.background" class="tag" data-testid="background-tag"><UiIcon name="arrow-right" :size="12" /> background</span>
      </p>
      <RunProgress v-if="run.progress && !isSettled(run.status)" :progress="run.progress" />
      <RendererHost v-if="view" :view="view" :label="label" @inspect="emit('open')" />
      <pre v-else-if="showResult" class="result">{{ brief }}</pre>
    </div>
  </article>
</template>

<style scoped>
.run-card {
  display: grid; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  animation: ui-rise-in var(--medium) var(--ease); transition: border-color var(--medium) var(--ease), box-shadow var(--medium) var(--ease);
}
.run-card.active { border-color: var(--accent-soft-strong); box-shadow: 0 0 0 3px var(--accent-soft); animation: ui-rise-in var(--medium) var(--ease), card-glow 2.4s var(--ease-in-out) infinite; }
.run-card.status-failed { border-color: var(--danger-soft); }
.run-card.status-awaiting-approval, .run-card.asking { border-color: var(--warn-soft); }
.run-card.status-done { animation: ui-rise-in var(--medium) var(--ease); }
@keyframes card-glow { 0%, 100% { box-shadow: 0 0 0 3px var(--accent-soft); } 50% { box-shadow: 0 0 0 1px var(--accent-soft); } }
.line { display: flex; align-items: center; gap: var(--space-1); min-width: 0; padding: 2px var(--space-1) 2px 0; }
.summary {
  display: flex; align-items: center; gap: var(--space-2); flex: 1; min-width: 0; min-height: 40px; padding: 0 var(--space-2) 0 var(--space-3);
  border: 0; border-radius: var(--radius); background: transparent; color: var(--text); text-align: left;
}
.summary:focus-visible { outline: none; box-shadow: inset var(--ring); }
.label { flex: none; font-weight: var(--weight-medium); font-size: var(--text-sm); }
.about { flex: 1; min-width: 0; color: var(--text-dim); font-size: var(--text-sm); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.error-text { color: var(--danger); font-family: var(--font); }
.metrics { display: flex; align-items: center; gap: var(--space-2); flex: none; color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.attempt { color: var(--warn); }
.ticking { color: var(--accent); }
.body { display: grid; gap: var(--space-2); min-width: 0; padding: 0 var(--space-3) var(--space-3); }
.status { margin: 0; color: var(--text-dim); font-size: var(--text-sm); overflow-wrap: anywhere; }
.byline { color: var(--text-faint); }
.tag {
  display: inline-flex; align-items: center; gap: 2px; margin-left: var(--space-2); padding: 0 6px; border-radius: var(--radius-full);
  background: var(--surface-2); color: var(--text-dim); font-size: var(--text-xs); vertical-align: 1px;
}
.shimmer {
  background: linear-gradient(90deg, var(--text-dim) 40%, var(--text-faint) 50%, var(--text-dim) 60%) 0 0 / 300% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent; animation: ui-shimmer 2.2s linear infinite;
}
.result {
  margin: 0; max-height: 200px; overflow: auto; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--code-bg);
  font-family: var(--mono); font-size: var(--text-xs); white-space: pre-wrap; overflow-wrap: anywhere;
}
</style>
