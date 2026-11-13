<script setup lang="ts">
/**
 * Draws a visual's component with one object of props. Bound beside other attributes (the key Vue adds under `v-if`,
 * a loading wrapper's fallthrough), Vue would merge them and parse `style` (a visual's prop, the sdk's `VisualView`)
 * as CSS; bound alone here, they reach the visual as they are.
 */
import type { Component } from 'vue';

defineProps<{
  /** The visual's component. */
  visual: Component;
  /** Everything it is drawn with: its props and its event handlers (`onDrill`, `onRange`). */
  drawn: Readonly<Record<string, unknown>>;
}>();
</script>

<template>
  <component :is="visual" v-bind="drawn" />
</template>
