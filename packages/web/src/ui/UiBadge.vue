<script setup lang="ts">
/** A small label for a status or count, in a tone. `dot` adds a leading dot that pulses while `live`. */
import type { Tone } from './types.ts';

withDefaults(defineProps<{ tone?: Tone; dot?: boolean; live?: boolean }>(), { tone: 'neutral', dot: false, live: false });
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <span class="ui-badge" :class="`tone-${tone}`">
    <span v-if="dot" class="dot" :class="{ live }" aria-hidden="true" />
    <slot />
  </span>
</template>

<style scoped>
.ui-badge {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 22px; padding: 0 8px; border-radius: var(--radius-full);
  background: var(--tone-soft); color: var(--tone); font-size: var(--text-xs); font-weight: var(--weight-medium); line-height: 1; white-space: nowrap;
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.dot.live { animation: ui-pulse 1.6s ease-in-out infinite; }
</style>
