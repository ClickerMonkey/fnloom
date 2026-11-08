<script setup lang="ts">
/**
 * One measure per day as bars (a single series, so the title names it and there is no legend): thin bars with
 * rounded tops on a quiet baseline and one top gridline, a tooltip for the bar under the pointer or focus (the whole
 * column is its target), a few date labels so none collide, and the same numbers as a table.
 */
import { computed, ref } from 'vue';
import type { DayBar } from '../logic/metrics.ts';
import { niceMax } from '../logic/metrics.ts';

const props = withDefaults(defineProps<{
  title: string;
  bars: readonly DayBar[];
  /** How a value reads on the scale ("12", "480ms"). */
  format: (value: number) => string;
  testid?: string;
}>(), { testid: 'day-bars' });

const top = computed(() => niceMax(Math.max(0, ...props.bars.map((b) => b.value))));
const pointed = ref<number | undefined>(undefined);
/** Every how many bars a date is written under, so labels never run into each other. */
const labelEvery = computed(() => Math.max(1, Math.ceil(props.bars.length / 7)));
const shown = computed(() => (pointed.value === undefined ? undefined : props.bars[pointed.value]));
</script>

<template>
  <figure class="day-bars" :data-testid="testid">
    <figcaption class="title">{{ title }}</figcaption>
    <div class="plot" role="img" :aria-label="`${title}: ${bars.map((b) => `${b.label} ${format(b.value)}`).join(', ')}`" @pointerleave="pointed = undefined">
      <span class="scale top">{{ format(top) }}</span>
      <span class="scale zero">0</span>
      <div class="grid" aria-hidden="true" />
      <div class="columns">
        <button
          v-for="(bar, i) in bars" :key="bar.day" type="button" class="column" :class="{ pointed: pointed === i }" :aria-label="`${bar.label}: ${bar.lines.join(', ')}`"
          :data-day="bar.day" @pointerenter="pointed = i" @focus="pointed = i" @blur="pointed = undefined"
        >
          <span class="bar" :style="{ height: `${bar.value <= 0 ? 0 : Math.max(2, (bar.value / top) * 100)}%` }" />
        </button>
      </div>
      <div v-if="shown && pointed !== undefined" class="tip" role="status" :style="{ left: `${Math.min(80, Math.max(20, ((pointed + 0.5) / bars.length) * 100))}%` }">
        <strong>{{ shown.label }}</strong>
        <span v-for="line in shown.lines" :key="line">{{ line }}</span>
      </div>
    </div>
    <div class="labels" aria-hidden="true">
      <span v-for="(bar, i) in bars" :key="bar.day" class="label">{{ i % labelEvery === 0 ? bar.label : '' }}</span>
    </div>
    <details class="table">
      <summary>As a table</summary>
      <table>
        <thead><tr><th>Day</th><th>{{ title }}</th></tr></thead>
        <tbody><tr v-for="bar in bars" :key="bar.day"><td>{{ bar.label }}</td><td>{{ bar.lines.join(' · ') }}</td></tr></tbody>
      </table>
    </details>
  </figure>
</template>

<style scoped>
.day-bars { display: grid; gap: var(--space-2); margin: 0; min-width: 0; }
.title { font-size: var(--text-sm); font-weight: var(--weight-strong); }
.plot { position: relative; height: 140px; margin-left: 44px; }
.scale { position: absolute; left: -44px; width: 38px; color: var(--text-faint); font-size: var(--text-xs); text-align: right; font-variant-numeric: tabular-nums; }
.scale.top { top: -7px; }
.scale.zero { bottom: -7px; }
.grid { position: absolute; inset: 0; border-top: 1px dashed var(--border); border-bottom: 1px solid var(--border-strong); pointer-events: none; }
.columns { position: absolute; inset: 0; display: flex; gap: 2px; align-items: stretch; }
.column { display: flex; flex: 1; align-items: flex-end; justify-content: center; min-width: 0; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; }
.column:hover, .column.pointed { background: var(--surface-2); }
.column:focus-visible { outline: none; box-shadow: var(--ring); }
/* a thin mark, rounded where the data ends, anchored square to the baseline */
.bar { display: block; width: min(70%, 18px); border-radius: 4px 4px 0 0; background: var(--series-1); transition: height var(--medium) var(--ease); }
.tip {
  position: absolute; bottom: calc(100% + 6px); z-index: 2; display: grid; gap: 2px; min-width: 140px; padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow-md);
  color: var(--text); font-size: var(--text-xs); white-space: nowrap; transform: translateX(-50%); pointer-events: none;
}
.labels { display: flex; gap: 2px; margin-left: 44px; }
.label { flex: 1; min-width: 0; overflow: visible; color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap; }
.table summary { color: var(--text-dim); font-size: var(--text-xs); cursor: pointer; }
.table table { width: 100%; margin-top: var(--space-2); border-collapse: collapse; font-size: var(--text-sm); }
.table th, .table td { padding: 2px var(--space-2); border-bottom: 1px solid var(--border); text-align: left; }
</style>
