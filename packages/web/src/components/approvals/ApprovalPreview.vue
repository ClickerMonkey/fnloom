<script setup lang="ts">
/**
 * What a run would do, as its system worked it out before approval: a warning when it can't be undone, then each part
 * in order — words (markdown), code to run (highlighted SQL or DDL), the rows it would touch, a type's change. An
 * install (`subject`) also shows what the approval binds (the system, its host and the hashes) after its words, then
 * its own tests (the counts and any failures) and its component previews, before the code the scan flagged. Code and
 * rows show at full height wherever it sits (a page, a dialog), so nothing scrolls inside a scroll.
 */
import type { ApprovalPreview, PreviewPart } from '@harness/core';
import { computed } from 'vue';
import { UiBanner } from '../../ui/index.ts';
import PreviewGallery from '../checks/PreviewGallery.vue';
import TestResults from '../checks/TestResults.vue';
import InstallSubjectView from './InstallSubjectView.vue';
import PreviewParts from './PreviewParts.vue';

const props = defineProps<{ preview: ApprovalPreview }>();

const isCode = (part: PreviewPart): boolean => part.type === 'code';
/** With a subject, the code parts (the scan's lines) come after it; without one, every part keeps its place. */
const before = computed(() => (props.preview.subject === undefined ? props.preview.parts : props.preview.parts.filter((part) => !isCode(part))));
const tests = computed(() => props.preview.checks?.tests);
const after = computed(() => (props.preview.subject === undefined ? [] : props.preview.parts.filter(isCode)));
</script>

<template>
  <div class="preview" data-testid="approval-preview">
    <UiBanner v-if="preview.irreversible" tone="danger">This can't be undone once it runs.</UiBanner>
    <PreviewParts :parts="before" />
    <InstallSubjectView v-if="preview.subject" :subject="preview.subject" />
    <section v-if="tests" class="checks" data-testid="approval-checks">
      <h4>Its tests</h4>
      <TestResults :tests="tests" failures-only />
      <template v-if="(tests.previews?.length ?? 0) > 0">
        <h4>Its component previews</h4>
        <PreviewGallery :shots="tests.previews ?? []" :limit="4" />
      </template>
    </section>
    <PreviewParts :parts="after" />
  </div>
</template>

<style scoped>
.preview { display: grid; gap: var(--space-2); min-width: 0; }
.checks { display: grid; gap: var(--space-2); min-width: 0; }
h4 { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-dim); }
</style>
