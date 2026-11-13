<script setup lang="ts">
/**
 * A result table in a page: asks the page's results host (`RESULTS_HOST`) for the registry's visuals that fit it,
 * loads the registry's contributions first, and keeps the person's choice under the view's key.
 */
import type { QualifiedName, ResultTable } from '@harness/core';
import { computed, inject, onMounted, ref } from 'vue';
import { OWN_HOST, RESULTS_HOST } from './builtin.ts';
import ResultView from './ResultView.vue';
import type { ResultPager } from './table.ts';
import type { RowOpener } from './visuals.ts';

const props = withDefaults(defineProps<{
  table: ResultTable;
  title: string;
  registry: QualifiedName;
  /** Where the person's choice of visual is kept (a message part's key); empty keeps it only while mounted. */
  viewKey?: string;
  pager?: ResultPager | undefined;
  /** A button per row that opens what it offers. */
  opener?: RowOpener | undefined;
}>(), { viewKey: '', pager: undefined, opener: undefined });

const host = inject(RESULTS_HOST, OWN_HOST);
const local = ref<string | undefined>(undefined);
const visuals = computed(() => host.visuals(props.registry, props.table));
const choice = computed({
  get: () => (props.viewKey === '' ? local.value : host.choice(props.viewKey)),
  set: (name: string | undefined) => {
    if (name === undefined) { return; }
    if (props.viewKey === '') { local.value = name; } else { host.choose(props.viewKey, name); }
  },
});

onMounted(() => { void host.prepare(props.registry); });
</script>

<template>
  <ResultView v-model:choice="choice" :table="table" :title="title" :visuals="visuals" :pager="pager" :opener="opener">
    <template #tools><slot name="tools" /></template>
  </ResultView>
</template>
