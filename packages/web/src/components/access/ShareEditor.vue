<script setup lang="ts">
/**
 * The visibility editor the chat hands systems' renderers (the SDK's `SHARE_EDITOR`): the app's `UiVisibility` with
 * its people-and-groups picker, over a `v-model` rule that isn't saved anywhere until the renderer uses it.
 */
import type { ShareRule } from '@harness/core';
import UiVisibility from '../../ui/UiVisibility.vue';
import { usePickerSources } from '../pickers/sources.ts';

withDefaults(defineProps<{ label?: string }>(), { label: 'Who can use it' });
const model = defineModel<ShareRule>({ required: true });
const people = usePickerSources().people();
</script>

<template>
  <UiVisibility v-model="model" :people="people" :label="label" />
</template>
