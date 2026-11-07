<script setup lang="ts">
/**
 * The session's cost so far, ticking up as runs and LLM calls settle, beside a small bar for the tightest budget
 * (amber near it, red at it). Its tooltip lists every budget that applies and marks the tightest.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { UiIcon, UiPopover } from '../../ui/index.ts';
import { formatCost } from '../logic/format.ts';
import type { BudgetMeter } from '../logic/session.ts';

const props = withDefaults(defineProps<{ spent: number; meter?: BudgetMeter | undefined; compact?: boolean }>(), { meter: undefined, compact: false });

/** The cost as shown: it eases to the real value instead of jumping. */
const shown = ref(props.spent);
let frame = 0;
watch(() => props.spent, (target) => {
  cancelAnimationFrame(frame);
  const from = shown.value;
  const start = performance.now();
  const step = (at: number): void => {
    const t = Math.min(1, (at - start) / 400);
    shown.value = from + (target - from) * (1 - (1 - t) ** 3);
    if (t < 1) { frame = requestAnimationFrame(step); }
  };
  if (typeof requestAnimationFrame === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches) { frame = requestAnimationFrame(step); } else { shown.value = target; }
});
onBeforeUnmount(() => { cancelAnimationFrame(frame); });

const open = ref(false);
const anchor = ref<HTMLElement | null>(null);
const width = computed(() => `${Math.round(Math.min(1, props.meter?.fraction ?? 0) * 100)}%`);
</script>

<template>
  <button
    ref="anchor" type="button" class="meter" :class="meter ? `tone-${meter.tone}` : 'tone-neutral'" data-testid="budget-meter"
    :aria-label="`Spent ${formatCost(spent)}${meter ? `. ${meter.text}` : ''}`" :aria-expanded="open ? 'true' : 'false'" @click="open = !open"
  >
    <UiIcon name="coins" :size="14" />
    <span class="cost" data-testid="session-cost">{{ formatCost(shown) }}</span>
    <span v-if="meter" class="bar" :title="meter.text"><span class="fill" :style="{ width }" /></span>
  </button>
  <UiPopover v-model:open="open" :anchor="anchor" side="top" align="end" label="Budget">
    <div class="details" data-testid="budget-details">
      <p class="total">This chat has spent <strong>{{ formatCost(spent) }}</strong>.</p>
      <ul v-if="meter" class="rows">
        <li v-for="row in meter.rows" :key="row.key" :class="{ tight: row.tightest }">
          <span>{{ row.label }}</span>
          <span class="left">{{ formatCost(row.left) }} left</span>
          <span v-if="row.tightest" class="tag">tightest</span>
        </li>
      </ul>
      <p v-else class="none">No budget limits this chat.</p>
    </div>
  </UiPopover>
</template>

<style scoped>
.meter {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 var(--space-2); border: 0; border-radius: var(--radius-full);
  background: transparent; color: var(--text-dim); font-size: var(--text-xs); font-variant-numeric: tabular-nums;
}
.meter:hover { background: var(--surface-2); }
.meter:focus-visible { outline: none; box-shadow: var(--ring); }
.bar { position: relative; width: 40px; height: 4px; border-radius: var(--radius-full); background: var(--surface-3); overflow: hidden; }
.fill { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--tone); transition: width var(--slow) var(--ease); }
.details { display: grid; gap: var(--space-2); width: min(300px, calc(100vw - 32px)); padding: var(--space-3) var(--space-4); font-size: var(--text-sm); }
.total { margin: 0; }
.rows { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.rows li { display: flex; align-items: center; gap: var(--space-2); color: var(--text-dim); }
.rows li.tight { color: var(--text); font-weight: var(--weight-medium); }
.left { margin-left: auto; font-variant-numeric: tabular-nums; }
.tag { padding: 0 6px; border-radius: var(--radius-full); background: var(--accent-soft); color: var(--accent); font-size: var(--text-xs); }
.none { margin: 0; color: var(--text-faint); }
</style>
