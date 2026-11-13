<script setup lang="ts">
/**
 * The root: the shell, which draws the current page, with what every page shares: the browser's named gin types for
 * every form, the systems' components for their named types, and the resource viewer for systems' renderers.
 */
import { RESOURCE_VIEWER } from '@harness/sdk';
import { provide } from 'vue';
import { GIN_INPUTS } from '../gin/registry.ts';
import { GIN_TYPES } from '../gin/types.ts';
import { ITEM_VERSIONS } from '../components/versions/versions.ts';
import ResourceViewer from '../resources/ResourceViewer.vue';
import { useStores } from '../state/stores.ts';
import AppShell from './AppShell.vue';
import { useLeaveWhenSignedOut } from './signOut.ts';

const { chat, itemVersions } = useStores();
provide(GIN_TYPES, chat.types);
// every item's version history (a fn, type, context item or part) reads from the hub
provide(ITEM_VERSIONS, itemVersions);
// a system's component for its named type draws values of that type everywhere: forms, run cards, config forms
provide(GIN_INPUTS, (type) => chat.renderers.inputView(type));
// a system's renderer shows any resource with the hub's viewer
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- typescript-eslint cannot see the types of .vue modules; vue-tsc checks this against ResourceViewerProps
provide(RESOURCE_VIEWER, ResourceViewer);
useLeaveWhenSignedOut();
</script>

<template>
  <AppShell />
</template>
