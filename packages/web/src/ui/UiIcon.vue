<script setup lang="ts">
/**
 * One icon from the set. Decorative by default (hidden from screen readers); give it a `label` when it carries meaning
 * on its own.
 */
import { computed } from 'vue';
import { ICONS, type IconName } from './icons.ts';

const props = withDefaults(defineProps<{
  name: IconName;
  /** Width and height in px. */
  size?: number;
  /** What the icon means, when nothing next to it says so. */
  label?: string;
}>(), { size: 18, label: '' });

const drawing = computed(() => ICONS[props.name]);
</script>

<template>
  <!-- eslint-disable vue/no-v-html -- the drawing comes from the fixed ICONS record, never from data -->
  <svg
    class="ui-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" :role="label === '' ? undefined : 'img'" :aria-label="label === '' ? undefined : label"
    :aria-hidden="label === '' ? 'true' : undefined" focusable="false" v-html="drawing"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>

<style scoped>
.ui-icon { flex: none; display: inline-block; vertical-align: middle; }
</style>
