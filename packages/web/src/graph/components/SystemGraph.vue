<script setup lang="ts">
/**
 * One system's graph, for the Graph tab of its page and of its review: its own items drawn fully, what they reference
 * in other systems or the hub greyed, with the same search and filters as the global graph, kept in the URL.
 */
import type { SystemName } from '@harness/core';
import { useGraphQuery } from '../state/route.ts';
import GraphPanel from './GraphPanel.vue';

const props = defineProps<{ system: SystemName }>();
const query = useGraphQuery(() => ({ systems: [props.system] }));
</script>

<template>
  <GraphPanel v-model="query" scoped data-testid="system-graph" />
</template>
