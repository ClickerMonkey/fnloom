<script setup lang="ts">
/**
 * A connection's settings as pickers over the values its account offers (the calendars to read, and the one new
 * events go to). Each pick is saved as it is made, so there is no Save button. It only draws the pickers and reports
 * the whole settings value.
 */
import type { Json } from '@harness/core';
import { computed } from 'vue';
import { UiPicker, listSource } from '../ui/index.ts';
import { pickedSettings, pickedValues, type SettingsPick } from './logic.ts';

const props = withDefaults(defineProps<{
  picks: readonly SettingsPick[];
  /** The settings as stored. */
  settings: Json;
  disabled?: boolean;
}>(), { disabled: false });
const emit = defineEmits<{ save: [settings: Record<string, Json>] }>();

const values = computed((): Record<string, readonly string[]> => Object.fromEntries(props.picks.map((pick) => [pick.key, pickedValues(props.settings, pick.key)])));
const sources = computed(() => Object.fromEntries(props.picks.map((pick) => [pick.key, listSource(pick.options)])));

function pick(key: string, picked: readonly string[]): void {
  emit('save', pickedSettings(props.picks, { ...values.value, [key]: picked }));
}
</script>

<template>
  <div class="picks" data-testid="connection-settings-picks">
    <UiPicker
      v-for="field in picks" :key="field.key" :model-value="values[field.key] ?? []" :source="sources[field.key] ?? listSource(field.options)" :label="field.label" :hint="field.hint"
      :max="field.many ? undefined : 1" :code="false" :delay="0" :disabled="disabled" :testid="`settings-${field.key}`"
      @update:model-value="pick(field.key, $event)"
    />
  </div>
</template>

<style scoped>
.picks { display: grid; gap: var(--space-3); }
</style>
