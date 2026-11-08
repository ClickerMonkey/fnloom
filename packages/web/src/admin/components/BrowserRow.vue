<script setup lang="ts">
/**
 * One row of a browser: a leading mark, a title with a line under it, figures on the right, and the time. The whole
 * row opens the item; the opened one stays marked. Figures and time sit in fixed columns, right-aligned, so they line up
 * from row to row in every browser; in a narrow list (a phone, or beside a docked sidebar) the figures move under the
 * title and wrap, so long figures never run over the title.
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
.browser-row { container: browser-row / inline-size; }
.browser-row + .browser-row { border-top: 1px solid var(--border); }
.open {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto 64px; align-items: center; gap: var(--space-3); width: 100%;
  padding: var(--space-3) var(--space-4); border: 0; background: transparent; color: var(--text); text-align: left;
  transition: background-color var(--fast) var(--ease);
}
.open:hover { background: var(--surface-2); }
.open:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.selected .open { background: var(--accent-soft); }
.mark { grid-column: 1; display: grid; place-items: center; width: 20px; }
.main { grid-column: 2; display: grid; gap: 2px; min-width: 0; }
.title { overflow: hidden; font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.detail { overflow: hidden; color: var(--text-dim); font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.badges { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.figures { grid-column: 3; display: flex; justify-content: flex-end; gap: var(--space-3); min-width: 0; color: var(--text-dim); font-size: var(--text-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
.figures :slotted(*) { min-width: 64px; text-align: right; }
.at { grid-column: 4; min-width: 56px; color: var(--text-faint); font-size: var(--text-xs); text-align: right; white-space: nowrap; }
/* keyed to the row's own width, not the viewport's: a list beside a docked sidebar or an opened item is narrow too */
@container browser-row (max-width: 619.98px) {
  .open { grid-template-columns: auto minmax(0, 1fr) auto; }
  .figures :slotted(*) { min-width: 0; text-align: left; }
  .figures { grid-column: 2 / 4; grid-row: 2; flex-wrap: wrap; justify-content: flex-start; gap: var(--space-1) var(--space-3); white-space: normal; }
  .at { grid-column: 3; grid-row: 1; }
}
</style>
