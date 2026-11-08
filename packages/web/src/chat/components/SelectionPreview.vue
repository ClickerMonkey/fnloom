<script setup lang="ts">
/**
 * "What would this message get?": a message to try, and the context inspector for what the chat's contextor would put
 * in its prompt now (nothing is sent and no model is called).
 */
import type { SelectionReport } from '@harness/core';
import { ref } from 'vue';
import { UiBanner, UiButton, UiSkeleton, UiTextarea } from '../../ui/index.ts';
import SelectionReportView from './SelectionReportView.vue';

const props = withDefaults(defineProps<{
  report: SelectionReport | undefined;
  loading: boolean;
  problem?: string;
  /** The text to start with (the composer's draft). */
  initial?: string;
}>(), { problem: '', initial: '' });
const emit = defineEmits<{ preview: [text: string] }>();
const text = ref(props.initial);
</script>

<template>
  <div class="preview" data-testid="selection-preview">
    <form class="ask" @submit.prevent="emit('preview', text)">
      <UiTextarea v-model="text" label="Message to try" :rows="2" placeholder="What would this message get?" data-testid="preview-text" />
      <UiButton type="submit" size="sm" icon="eye" :loading="loading" :disabled="text.trim() === ''" data-testid="preview-run">Preview</UiButton>
    </form>
    <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    <UiSkeleton v-if="loading && report === undefined" shape="lines" :lines="5" />
    <SelectionReportView v-else-if="report" :report="report" />
  </div>
</template>

<style scoped>
.preview { display: grid; gap: var(--space-3); min-width: 0; }
.ask { display: grid; gap: var(--space-2); justify-items: end; }
.ask > :first-child { justify-self: stretch; }
</style>
