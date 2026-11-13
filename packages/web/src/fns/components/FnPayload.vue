<script setup lang="ts">
/**
 * What a kind fn runs (a database's saved query, a code fn's program, an api fn's request and output), as its kind
 * writes it for people, with the stored JSON one switch away. The fn page keeps the switch in its URL (`?form=`);
 * the fn modal keeps it while open. Shows nothing for a fn without a payload (a native fn).
 */
import type { Json, ReadablePayload } from '@harness/core';
import { computed } from 'vue';
import { UiCard, UiCodeBlock, UiSegmented, type SegmentOption } from '../../ui/index.ts';
import { shownPayload, type PayloadForm } from '../logic/facts.ts';

const props = withDefaults(defineProps<{
  payload: Json | undefined;
  readable: ReadablePayload | undefined;
  /** The most height the code takes before it scrolls (px). */
  maxHeight?: number;
}>(), { maxHeight: 360 });
const form = defineModel<PayloadForm>('form', { default: 'readable' });

const forms = computed<readonly SegmentOption<PayloadForm>[]>(() => [{ value: 'readable', label: props.readable?.language.toUpperCase() ?? 'Readable' }, { value: 'stored', label: 'Stored form' }]);
const shown = computed(() => shownPayload(props.payload, props.readable, form.value));
</script>

<template>
  <UiCard v-if="shown" title="What it runs" data-testid="fn-payload">
    <template v-if="readable" #actions><UiSegmented v-model="form" :options="forms" label="Show it as" data-testid="fn-payload-form" /></template>
    <UiCodeBlock :code="shown.code" :language="shown.language" wrap :max-height="maxHeight" />
  </UiCard>
</template>
