<script setup lang="ts">
/**
 * What a run would do, as its system worked it out before approval: a warning when it can't be undone, then each part
 * in order — words (markdown), code to run (highlighted SQL or DDL), the rows it would touch, a type's change.
 */
import type { ApprovalPreview } from '@harness/core';
import { UiBanner, UiCodeBlock, UiMarkdown } from '../../ui/index.ts';
import ResultGrid from '../results/ResultGrid.vue';
import TypeDiff from './TypeDiff.vue';

defineProps<{ preview: ApprovalPreview }>();
</script>

<template>
  <div class="preview" data-testid="approval-preview">
    <UiBanner v-if="preview.irreversible" tone="danger">This can't be undone once it runs.</UiBanner>
    <template v-for="(part, i) in preview.parts" :key="i">
      <UiMarkdown v-if="part.type === 'text'" class="text" :source="part.text" />
      <UiCodeBlock v-else-if="part.type === 'code'" :code="part.code" :language="part.language" :filename="part.title ?? ''" wrap :max-height="240" />
      <section v-else-if="part.type === 'table'" class="rows">
        <h4 class="title">{{ part.title }}</h4>
        <ResultGrid :table="part.table" :title="part.title" />
      </section>
      <TypeDiff v-else :part="part" />
    </template>
  </div>
</template>

<style scoped>
.preview { display: grid; gap: var(--space-2); min-width: 0; }
.text { font-size: var(--text-sm); }
.rows { display: grid; gap: var(--space-1); min-width: 0; }
.title { margin: 0; color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-strong); }
</style>
