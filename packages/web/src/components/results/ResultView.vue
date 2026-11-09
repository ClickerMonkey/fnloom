<script setup lang="ts">
/**
 * A result table drawn by one of the visuals that fit it: the best fit unless the person picked another, a switch
 * between the ones that fit (hidden when only the table does), and Copy and Download as CSV. The visuals come matched
 * already, so the view knows nothing of where they are from.
 */
import type { ResultTable } from '@harness/core';
import { computed } from 'vue';
import { UiIconButton, UiSegmented, copyText, type SegmentOption } from '../../ui/index.ts';
import { csvFileName, toCsv, type ResultPager } from './table.ts';
import type { FittingVisual } from './visuals.ts';

const props = withDefaults(defineProps<{
  table: ResultTable;
  title: string;
  /** The visuals that fit, best first. */
  visuals: readonly FittingVisual[];
  pager?: ResultPager | undefined;
}>(), { pager: undefined });
const chosen = defineModel<string | undefined>('choice', { default: undefined });
const emit = defineEmits<{ copied: [ok: boolean] }>();

const shown = computed(() => props.visuals.find((v) => v.visual.name === chosen.value) ?? props.visuals[0]);
const options = computed<readonly SegmentOption<string>[]>(() => props.visuals.map((v) => ({ value: v.visual.name, label: v.visual.label, icon: v.visual.icon })));
const current = computed({ get: () => shown.value?.visual.name ?? '', set: (name: string) => { chosen.value = name; } });

async function copy(): Promise<void> {
  emit('copied', await copyText(toCsv(props.table, props.table.rows)));
}

function download(): void {
  const url = URL.createObjectURL(new Blob([toCsv(props.table, props.table.rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = csvFileName(props.title);
  link.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="result" data-testid="result-view" :data-visual="shown?.visual.name">
    <div class="tools">
      <UiSegmented v-if="visuals.length > 1" v-model="current" :options="options" label="Show as" icon-only data-testid="result-visuals" />
      <span class="actions">
        <UiIconButton icon="copy" label="Copy as CSV" size="sm" data-testid="result-copy" @click="copy" />
        <UiIconButton icon="download" label="Download CSV" size="sm" data-testid="result-download" @click="download" />
      </span>
    </div>
    <component :is="shown.visual.component" v-if="shown" v-bind="shown.visual.props ?? {}" :table="table" :title="title" :pager="pager" />
  </div>
</template>

<style scoped>
.result { display: grid; gap: var(--space-2); min-width: 0; }
.tools { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.actions { display: flex; gap: 2px; margin-left: auto; }
</style>
