<script setup lang="ts">
/** How much of a budget is spent: a bar that fills and warms as it nears the limit, with the amounts beside it. */
import { computed } from 'vue';
import { formatCost } from '../../chat/logic/format.ts';
import { budgetUse } from '../logic/limits.ts';

const props = defineProps<{ spent: number; max: number }>();
const use = computed(() => budgetUse({ spent: props.spent, maxCost: props.max }));
</script>

<template>
  <div class="spend-meter" :class="`tone-${use.tone}`" role="meter" :aria-valuemin="0" :aria-valuemax="max" :aria-valuenow="spent" :aria-label="`${formatCost(spent)} of ${formatCost(max)} spent`">
    <span class="bar"><span class="fill" :style="{ transform: `scaleX(${use.fraction})` }" /></span>
    <span class="text">{{ formatCost(spent) }} <span class="of">of {{ formatCost(max) }}</span></span>
  </div>
</template>

<style scoped>
.spend-meter { display: grid; gap: var(--space-1); min-width: 0; }
.bar { position: relative; height: 6px; overflow: hidden; border-radius: var(--radius-full); background: var(--surface-3); }
.fill { position: absolute; inset: 0; border-radius: inherit; transform-origin: left; transition: transform var(--slow) var(--ease), background-color var(--medium) var(--ease); }
.tone-ok .fill { background: var(--ok); }
.tone-warn .fill { background: var(--warn); }
.tone-danger .fill { background: var(--danger); }
.text { font-size: var(--text-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
.of { color: var(--text-faint); }
</style>
