<script setup lang="ts">
/**
 * The graph of every system's items and how they connect (`/admin/graph`, in the admin area's Systems group), as the
 * signed-in admin may see it: a cluster per system, the search bar every list has (words and filters by system, item
 * and link kind, fn kind, mode, effect, visibility, stage and on or off, run by the hub), a focus N hops out, systems
 * collapsed into one node and references outside, all in the URL. Its line says "hover" with a mouse and "tap" on a
 * touch screen. The old `/graph` address comes here with its query.
 */
import { computed } from 'vue';
import AppPage from '../app/AppPage.vue';
import GraphPanel from '../graph/components/GraphPanel.vue';
import { useGraphQuery } from '../graph/state/route.ts';
import { useMediaQuery } from '../ui/index.ts';

const query = useGraphQuery();
const touch = useMediaQuery('(hover: none)');
const description = computed(() => `Every system's fns, context, types and parts, and how they connect. ${touch.value ? 'Tap one for what it is and to open it.' : 'Hover for what each is; click to open it.'}`);
</script>

<template>
  <AppPage title="Graph" :description="description" width="full">
    <GraphPanel v-model="query" height="max(420px, calc(100dvh - 300px))" />
  </AppPage>
</template>
