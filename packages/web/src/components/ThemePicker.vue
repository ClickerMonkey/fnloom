<script setup lang="ts">
/** Choose the theme: follow the device, light or dark (`v-model`). */
import type { ThemeChoice } from '../state/theme.ts';
import { UiSegmented, type SegmentOption } from '../ui/index.ts';

const OPTIONS = [
  { value: 'system', label: 'Device', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
] as const satisfies readonly SegmentOption<ThemeChoice>[];

const model = defineModel<ThemeChoice>({ required: true });
</script>

<template>
  <UiSegmented v-model="model" :options="OPTIONS" label="Theme" data-testid="theme-choice" />
</template>
