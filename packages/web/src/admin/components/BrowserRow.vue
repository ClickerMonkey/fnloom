<script setup lang="ts">
/**
 * One row of a browser: a leading mark, a title with a line under it, figures on the right, and the time. The whole
 * row opens the item; the opened one stays marked.
 */
import { fullTime, relativeTime } from '../../ui/index.ts';

withDefaults(defineProps<{ title: string; detail?: string; at?: number | undefined; now: number; selected?: boolean; testid?: string }>(), { detail: '', at: undefined, selected: false, testid: '' });
const emit = defineEmits<{ open: [] }>();
const slots = defineSlots<{ mark?: () => unknown; badges?: () => unknown; figures?: () => unknown }>();
</script>

<template>
  <li class="browser-row" :class="{ selected }">
    <button type="button" class="open" :aria-current="selected ? 'true' : undefined" :data-testid="testid || undefined" @click="emit('open')">
      <span v-if="slots.mark" class="mark"><slot name="mark" /></span>
      <span class="main">
        <span class="title">{{ title }}</span>
        <span v-if="detail !== ''" class="detail">{{ detail }}</span>
        <span v-if="slots.badges" class="badges"><slot name="badges" /></span>
      </span>
      <span v-if="slots.figures" class="figures"><slot name="figures" /></span>
      <time v-if="at !== undefined" class="at" :datetime="new Date(at).toISOString()" :title="fullTime(at)">{{ relativeTime(at, now) }}</time>
    </button>
  </li>
</template>

<style scoped>
.browser-row + .browser-row { border-top: 1px solid var(--border); }
.open {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3); width: 100%;
  padding: var(--space-3) var(--space-4); border: 0; background: transparent; color: var(--text); text-align: left;
  transition: background-color var(--fast) var(--ease);
}
.open:hover { background: var(--surface-2); }
.open:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.selected .open { background: var(--accent-soft); }
.mark { display: grid; place-items: center; width: 20px; }
.main { display: grid; gap: 2px; min-width: 0; }
.title { overflow: hidden; font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.detail { overflow: hidden; color: var(--text-dim); font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.badges { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.figures { display: flex; gap: var(--space-3); color: var(--text-dim); font-size: var(--text-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
.at { min-width: 56px; color: var(--text-faint); font-size: var(--text-xs); text-align: right; white-space: nowrap; }
@media (max-width: 559.98px) {
  .open { grid-template-columns: auto minmax(0, 1fr) auto; }
  .figures { grid-column: 2; grid-row: 2; }
  .at { grid-column: 3; grid-row: 1; }
}
</style>
