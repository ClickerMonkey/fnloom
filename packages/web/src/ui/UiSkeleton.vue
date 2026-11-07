<script setup lang="ts">
/**
 * A placeholder that shimmers while content loads, so a pane is never blank: `lines` of text (the last one shorter),
 * a `circle` (avatars) or a `block` of a given height. Hidden from screen readers; the region it fills should say
 * it is busy.
 */
withDefaults(defineProps<{
  shape?: 'lines' | 'circle' | 'block';
  lines?: number;
  /** For `circle` (diameter) and `block` (height), in px. */
  size?: number;
}>(), { shape: 'lines', lines: 3, size: 40 });
</script>

<template>
  <div v-if="shape === 'lines'" class="ui-skeleton-lines" aria-hidden="true">
    <span v-for="line in lines" :key="line" class="ui-skeleton line" :style="{ width: line === lines && lines > 1 ? '62%' : '100%' }" />
  </div>
  <span v-else class="ui-skeleton" :class="shape" aria-hidden="true" :style="shape === 'circle' ? { width: `${size}px`, height: `${size}px` } : { height: `${size}px` }" />
</template>

<style scoped>
.ui-skeleton-lines { display: grid; gap: 10px; }
.ui-skeleton {
  display: block; border-radius: var(--radius-sm);
  background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 37%, var(--surface-2) 63%);
  background-size: 400% 100%; animation: ui-shimmer 1.4s ease infinite;
}
.line { height: 12px; }
.circle { flex: none; border-radius: 50%; }
.block { width: 100%; border-radius: var(--radius); }
</style>
