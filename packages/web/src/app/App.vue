<script setup lang="ts">
/**
 * The root: the shell, which draws the current page, with what every page shares: the browser's named gin types for
 * every form, the systems' components for their named types, the resource viewer for systems' renderers, and the one
 * fn modal (`?fn=` on any page), which every `FnPill` opens.
 */
import { APP_COMPONENTS, RESOURCE_VIEWER, RESULT_VIEW } from '@harness/sdk';
import TableResult from '../components/widgets/TableResult.vue';
import { SHARED_COMPONENTS } from '../system-pages/shared.ts';
import { provide } from 'vue';
import { useRouter } from 'vue-router';
import { GIN_INPUTS } from '../gin/registry.ts';
import { GIN_TYPES } from '../gin/types.ts';
import { ITEM_VERSIONS } from '../components/versions/versions.ts';
import FnModal from '../fns/components/FnModal.vue';
import { provideFnModal } from '../fns/state/fn-modal.ts';
import ResourceViewer from '../resources/ResourceViewer.vue';
import { useStores } from '../state/stores.ts';
import AppShell from './AppShell.vue';
import { OUTSIDE_IMAGES } from '../ui/markdown/images.ts';
import { useLeaveWhenSignedOut } from './signOut.ts';

const { chat, itemVersions, session, outsideImages } = useStores();
// markdown images from outside the hub wait for a click unless the admin's setting says to load them
provide(OUTSIDE_IMAGES, () => outsideImages.value.value);
provide(GIN_TYPES, chat.types);
// every item's version history (a fn, type, context item or part) reads from the hub
provide(ITEM_VERSIONS, itemVersions);
// a system's component for its named type draws values of that type everywhere: forms, run cards, config forms
provide(GIN_INPUTS, (type) => chat.renderers.inputView(type));
// a system's renderer shows any resource with the hub's viewer
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- typescript-eslint cannot see the types of .vue modules; vue-tsc checks this against ResourceViewerProps
provide(RESOURCE_VIEWER, ResourceViewer);
// systems' result renderers draw with the app's result view and controls wherever a run card is (a chat, a system page)
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- typescript-eslint cannot see the types of .vue modules; vue-tsc checks this against ResultViewProps
provide(RESULT_VIEW, TableResult);
provide(APP_COMPONENTS, SHARED_COMPONENTS);
useLeaveWhenSignedOut();
// one fn modal for the whole app, bound to the URL (it reads the hub, so only once signed in)
const fnModal = provideFnModal(useRouter());
</script>

<template>
  <AppShell />
  <FnModal v-if="fnModal.name.value && session.signedIn.value" :modal="fnModal" :fn="fnModal.name.value" />
</template>
