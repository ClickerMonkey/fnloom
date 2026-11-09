<script setup lang="ts">
/**
 * A picker of one kind of thing on the hub (fns, context, systems, people, models, resources, types, kinds): `UiPicker`
 * with the app's source for `source` (`people` is people and groups together), so a form names things by picking them instead of typing them.
 */
import type { PickSource } from '@harness/core';
import { computed } from 'vue';
import UiPicker from '../../ui/UiPicker.vue';
import { usePickerSources } from './sources.ts';

const props = withDefaults(defineProps<{
  source: PickSource | 'people';
  label: string;
  hideLabel?: boolean;
  placeholder?: string;
  hint?: string;
  error?: string;
  /** At most this many; 1 is a single picker. */
  max?: number | undefined;
  /** Take the words as typed as a value too (a pattern), or undefined when they aren't one. */
  custom?: ((text: string) => string | undefined) | undefined;
  disabled?: boolean;
  testid?: string;
}>(), { hideLabel: false, placeholder: 'Search', hint: '', error: '', max: undefined, custom: undefined, disabled: false, testid: '' });
const model = defineModel<readonly string[]>({ required: true });

const sources = usePickerSources();
const from = computed(() => (props.source === 'people' ? sources.people() : sources.source(props.source)));
/** People read as names, everything else as code. */
const code = computed(() => !['person', 'group', 'people'].includes(props.source));
</script>

<template>
  <UiPicker
    v-model="model" :source="from" :label="label" :hide-label="hideLabel" :placeholder="placeholder" :hint="hint" :error="error" :max="max" :custom="custom"
    :code="code" :disabled="disabled" :testid="testid"
  />
</template>
