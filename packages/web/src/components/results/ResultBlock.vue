<script setup lang="ts">
/**
 * A result table in a page: works out its column facts, asks the page's results host (`RESULTS_HOST`) for the
 * registry's visuals that can draw it, loads the registry's contributions first, and keeps the person's choice of
 * visual and style under the view's key.
 */
import { columnFacts, type QualifiedName, type ResultTable } from '@harness/core';
import { computed, inject, onMounted, ref } from 'vue';
import { OWN_HOST, RESULTS_HOST } from './builtin.ts';
import ResultView from './ResultView.vue';
import type { ResultPager } from './table.ts';
import type { RowOpener, VisualChoice } from './visuals.ts';

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
const local = ref<VisualChoice | undefined>(undefined);
const facts = computed(() => columnFacts(props.table));
const visuals = computed(() => host.visuals(props.registry, props.table, facts.value));
const choice = computed({
  // the host keeps it under the view's key where it can; the local copy holds it on a page whose host keeps none
  get: () => (props.viewKey === '' ? undefined : host.choice(props.viewKey)) ?? local.value,
  set: (picked: VisualChoice | undefined) => {
    if (picked === undefined) { return; }
    local.value = picked;
    if (props.viewKey !== '') { host.choose(props.viewKey, picked); }
  },
});

onMounted(() => { void host.prepare(props.registry); });
</script>

<template>
  <ResultView v-model:choice="choice" :table="table" :title="title" :visuals="visuals" :facts="facts" :pager="pager" :opener="opener">
    <template v-if="$slots['lead']" #lead><slot name="lead" /></template>
    <template v-if="$slots['tools']" #tools><slot name="tools" /></template>
  </ResultView>
</template>
