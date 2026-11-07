<script setup lang="ts">
/** A run's status as a small coloured dot: it breathes while the run is active and pops when it settles. */
import type { RunStatus } from '@harness/core';
import { computed } from 'vue';
import { isActive, STATUS_LOOK } from '../logic/runs.ts';

const props = withDefaults(defineProps<{ status: RunStatus; size?: number }>(), { size: 8 });
const look = computed(() => STATUS_LOOK[props.status]);
</script>

<template>
  <span
    class="run-dot" :class="[`tone-${look.tone}`, { active: isActive(status), waiting: status === 'awaiting-approval' }]"
    :style="{ width: `${size}px`, height: `${size}px` }" role="img" :aria-label="look.word" :title="look.word" :data-status="status"
  />
</template>

<style scoped>
.run-dot {
  display: inline-block; flex: none; border-radius: 50%; background: var(--tone);
  animation: dot-settle var(--medium) var(--spring);
}
.run-dot.active { animation: dot-breathe 1.6s var(--ease-in-out) infinite; box-shadow: 0 0 0 0 var(--tone-soft); }
.run-dot.waiting { animation: dot-breathe 2.4s var(--ease-in-out) infinite; }
@keyframes dot-breathe {
  0%, 100% { box-shadow: 0 0 0 0 var(--tone-soft); opacity: 1; }
  50% { box-shadow: 0 0 0 4px var(--tone-soft); opacity: 0.7; }
}
@keyframes dot-settle { from { transform: scale(0.4); } to { transform: none; } }
</style>
