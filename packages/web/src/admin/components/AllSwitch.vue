<script setup lang="ts">
/**
 * The master switch above a system's list of items (its fns, its context): all of them on or off at once, while each
 * item keeps its own switch underneath for when they are back on. What it says follows the switch.
 */
import { UiSwitch } from '../../ui/index.ts';

defineProps<{
  on: boolean;
  label: string;
  /** What being on means. */
  onText: string;
  /** What being off means. */
  offText: string;
  testid: string;
}>();
const emit = defineEmits<{ switch: [on: boolean] }>();
</script>

<template>
  <div class="all-switch" :class="{ off: !on }">
    <UiSwitch :model-value="on" :label="label" :description="on ? onText : offText" :data-testid="testid" @update:model-value="emit('switch', $event)" />
  </div>
</template>

<style scoped>
.all-switch {
  margin-bottom: var(--space-3); padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface);
  transition: border-color var(--fast) var(--ease), background var(--medium) var(--ease);
}
.all-switch.off { border-color: var(--border-strong); background: var(--surface-2); }
</style>
