<script setup lang="ts">
/**
 * A wavy rule across the thread where the model re-read the whole chat: the call behind the answer below read no
 * prompt cache, though earlier calls in the chat did. Its label is the call's time, with the date when it isn't today;
 * its words say what happened (shown, since phones have no tooltip) and the tooltip says it in full.
 */
import { computed } from 'vue';
import { fullTime } from '../../ui/index.ts';
import { cacheMissLabel, CACHE_MISS_TIP, CACHE_MISS_WORDS } from '../logic/format.ts';

const props = defineProps<{
  /** When the call was made. */
  at: number;
  now: number;
}>();

const label = computed(() => cacheMissLabel(props.at, props.now));
const tip = computed(() => `${CACHE_MISS_TIP} · ${fullTime(props.at)}`);
</script>

<template>
  <div class="cache-miss" role="separator" :aria-label="`${CACHE_MISS_TIP}, ${label}`" :title="tip" data-testid="cache-miss">
    <span class="wave" aria-hidden="true" />
    <span class="label"><span class="what">{{ CACHE_MISS_WORDS }}</span> · <time :datetime="new Date(at).toISOString()">{{ label }}</time></span>
    <span class="wave" aria-hidden="true" />
  </div>
</template>

<style scoped>
.cache-miss { display: flex; align-items: center; gap: var(--space-3); color: var(--warn); font-size: var(--text-xs); font-weight: var(--weight-medium); cursor: help; }
.wave {
  flex: 1; min-width: var(--space-5); height: 8px; background: currentColor; opacity: 0.7;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M0 4 Q3 0 6 4 T12 4' fill='none' stroke='black' stroke-width='1.25'/%3E%3C/svg%3E") repeat-x left center / 12px 8px;
}
.label { flex: 0 1 auto; min-width: 0; color: var(--text-dim); font-variant-numeric: tabular-nums; text-align: center; }
.what { color: var(--warn); }
</style>
