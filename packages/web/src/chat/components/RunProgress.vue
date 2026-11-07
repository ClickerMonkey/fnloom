<script setup lang="ts">
/**
 * A run's progress: a thin bar with its percentage and message for linear progress, or a compact stepper for named
 * steps, each with its state and detail. Step titles come from the fn's declaration when known.
 */
import type { ProgressWire, StepStatus } from '@harness/core';
import { computed } from 'vue';
import { UiIcon, type IconName } from '../../ui/index.ts';
import { humanize } from '../logic/labels.ts';

const props = withDefaults(defineProps<{ progress: ProgressWire; titles?: Readonly<Record<string, string>> }>(), { titles: () => ({}) });

const STEP_ICON = { pending: 'dot', active: 'clock', done: 'check', failed: 'x', skipped: 'chevron-right' } as const satisfies Record<StepStatus, IconName>;

const linear = computed(() => ('fraction' in props.progress ? props.progress : undefined));
const steps = computed(() => ('steps' in props.progress ? Object.entries(props.progress.steps).map(([key, step]) => ({ key, title: props.titles[key] ?? humanize(key), ...step })) : []));
const percent = computed(() => Math.round((linear.value?.fraction ?? 0) * 100));
</script>

<template>
  <div v-if="linear" class="linear" data-testid="run-progress">
    <div class="track" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100" :aria-label="linear.message ?? 'Progress'">
      <div class="fill" :style="{ transform: `scaleX(${linear.fraction})` }" />
    </div>
    <span class="percent">{{ percent }}%</span>
    <span v-if="linear.message" class="message" :title="linear.message">{{ linear.message }}</span>
  </div>
  <ol v-else class="steps" data-testid="run-steps">
    <li v-for="step in steps" :key="step.key" class="step" :class="step.status" :data-step="step.key">
      <span class="mark"><UiIcon :name="STEP_ICON[step.status]" :size="12" /></span>
      <span class="title">{{ step.title }}</span>
      <span v-if="step.detail" class="detail" :title="step.detail">{{ step.detail }}</span>
    </li>
  </ol>
</template>

<style scoped>
.linear { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); min-width: 0; }
.track { flex: 1 1 120px; height: 4px; border-radius: var(--radius-full); background: var(--surface-3); overflow: hidden; }
.fill { height: 100%; width: 100%; background: var(--accent); transform-origin: left; transition: transform var(--slow) var(--ease); }
.percent { font-size: var(--text-xs); font-variant-numeric: tabular-nums; color: var(--text-dim); }
.message { flex-basis: 100%; min-width: 0; font-size: var(--text-xs); color: var(--text-faint); overflow-wrap: anywhere; }
.steps { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.step { display: flex; align-items: center; gap: var(--space-2); min-width: 0; font-size: var(--text-sm); color: var(--text-faint); }
.mark { display: grid; place-items: center; flex: none; width: 18px; height: 18px; border-radius: 50%; background: var(--surface-3); transition: background-color var(--medium) var(--ease), color var(--medium) var(--ease); }
.step.active { color: var(--text); }
.step.active .mark { background: var(--accent-soft); color: var(--accent); animation: ui-pulse 1.6s var(--ease-in-out) infinite; }
.step.done { color: var(--text-dim); }
.step.done .mark { background: var(--ok-soft); color: var(--ok); }
.step.failed { color: var(--danger); }
.step.failed .mark { background: var(--danger-soft); color: var(--danger); }
.title { flex: none; }
.detail { min-width: 0; color: var(--text-faint); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
