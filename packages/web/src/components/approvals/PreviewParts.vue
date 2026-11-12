<script setup lang="ts">
/** Parts of an approval preview, in order: words (markdown), code (highlighted, full height), rows, a type's change. */
import type { PreviewPart } from '@harness/core';
import { UiCodeBlock, UiMarkdown } from '../../ui/index.ts';
import ResultGrid from '../results/ResultGrid.vue';
import TypeDiff from './TypeDiff.vue';

defineProps<{ parts: readonly PreviewPart[] }>();
</script>

<template>
  <template v-for="(part, i) in parts" :key="i">
    <UiMarkdown v-if="part.type === 'text'" class="text" :source="part.text" />
    <UiCodeBlock v-else-if="part.type === 'code'" :code="part.code" :language="part.language" :filename="part.title ?? ''" wrap :max-height="0" />
    <section v-else-if="part.type === 'table'" class="rows">
      <h4 class="title">{{ part.title }}</h4>
      <ResultGrid :table="part.table" :title="part.title" />
    </section>
    <TypeDiff v-else-if="part.type === 'type-diff'" :part="part" />
    <!-- build 8: web lane draws the `flags` part (sensitive files the call would touch) -->
  </template>
</template>

<style scoped>
.text { font-size: var(--text-sm); }
.rows { display: grid; gap: var(--space-1); min-width: 0; }
.title { margin: 0; color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-strong); }
</style>
