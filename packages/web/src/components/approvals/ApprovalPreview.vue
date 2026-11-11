<script setup lang="ts">
/**
 * What a run would do, as its system worked it out before approval: a warning when it can't be undone, then each part
 * in order — words (markdown), code to run (highlighted SQL or DDL), the rows it would touch, a type's change. An
 * install (`subject`) also shows what the approval binds (the system, its host and the hashes) after its words and
 * before the code the scan flagged. Code and rows show at full height wherever it sits (a page, a dialog), so nothing
 * scrolls inside a scroll.
 */
import type { ApprovalPreview, PreviewPart } from '@harness/core';
import { computed } from 'vue';
import { UiBanner } from '../../ui/index.ts';
import InstallSubjectView from './InstallSubjectView.vue';
import PreviewParts from './PreviewParts.vue';

const props = defineProps<{ preview: ApprovalPreview }>();

const isCode = (part: PreviewPart): boolean => part.type === 'code';
/** With a subject, the code parts (the scan's lines) come after it; without one, every part keeps its place. */
const before = computed(() => (props.preview.subject === undefined ? props.preview.parts : props.preview.parts.filter((part) => !isCode(part))));
const after = computed(() => (props.preview.subject === undefined ? [] : props.preview.parts.filter(isCode)));
</script>

<template>
  <div class="preview" data-testid="approval-preview">
    <UiBanner v-if="preview.irreversible" tone="danger">This can't be undone once it runs.</UiBanner>
    <PreviewParts :parts="before" />
    <InstallSubjectView v-if="preview.subject" :subject="preview.subject" />
    <PreviewParts :parts="after" />
  </div>
</template>

<style scoped>
.preview { display: grid; gap: var(--space-2); min-width: 0; }
</style>
