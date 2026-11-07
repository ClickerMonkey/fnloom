<script setup lang="ts">
/** A small spinning ring for work in progress. Announced as "Loading" unless given another label. */
withDefaults(defineProps<{ size?: number; label?: string }>(), { size: 16, label: 'Loading' });
</script>

<template>
  <span class="ui-spinner" role="status" :aria-label="label" :style="{ width: `${size}px`, height: `${size}px` }" />
</template>

<style scoped>
.ui-spinner {
  display: inline-block; flex: none; border-radius: 50%;
  border: 2px solid color-mix(in oklab, currentColor 22%, transparent); border-top-color: currentColor;
  animation: ui-spin 0.7s linear infinite;
}
</style>
