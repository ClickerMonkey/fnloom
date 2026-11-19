<script setup lang="ts">
/**
 * The app's one fn modal, drawn once by `App.vue` and open while the URL says `?fn=` (`useFnModal`): a fn looked into
 * without leaving where the person is (the chat, a system's fn list, the runs browser, the graph, any `FnPill`).
 * Admins see everything its page shows, from the same `FnDetails`: its overview with its on/off switch (the page's
 * scope is told, so its list follows), its numbers over a period, what a kind fn runs, who may use it, its history
 * and its latest runs; everyone else its overview alone. The runs of it the page knows of (the chat's own, newest
 * first) list under the overview. "Open page" goes to the full fn page for admins; a fn it uses (a `FnPill`) opens in
 * its place; a run opens where the page opens runs, and All its runs goes to the runs browser. It mounts only while
 * open, so it is the newest layer and stacks over whatever sheet opened it.
 */
import type { QualifiedName } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { links } from '../../app/routes.ts';
import type { FnPeriod } from '../../admin/state/fn.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiDialog } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import type { PayloadForm } from '../logic/facts.ts';
import type { FnModal } from '../state/fn-modal.ts';
import FnDetails from './FnDetails.vue';
import FnOverview from './FnOverview.vue';
import FnRuns from './FnRuns.vue';

const props = defineProps<{ modal: FnModal; fn: QualifiedName }>();

const { fns, session } = useStores();
const router = useRouter();
const manage = computed(() => session.user.value?.role === 'admin');
const days = ref<FnPeriod>(7);
const payloadForm = ref<PayloadForm>('readable');
const now = useNow(30_000);
const open = computed({ get: () => true, set: (isOpen: boolean) => { if (!isOpen) { props.modal.close(); } } });
const shownRuns = computed(() => [...(props.modal.scope.value.runs?.() ?? []).filter((run) => run.fn === props.fn)].reverse());

// FnDetails loads the fn itself when managing; the overview alone is loaded here
watch([() => props.fn, manage], ([name, admin]) => { if (!admin) { void fns.open(name); } }, { immediate: true });
onBeforeUnmount(() => { if (!manage.value) { fns.close(); } });

/** Leave the modal for a page (the link drops `?fn=`, so it closes). */
function go(to: Parameters<typeof router.push>[0]): void {
  void router.push(to);
}
</script>

<template>
  <UiDialog v-model:open="open" :title="fnLabel(fn)" :description="fn" width="720px">
    <FnDetails
      v-if="manage" v-model:days="days" v-model:form="payloadForm" :name="fn" compact
      @run="modal.openRun($event)" @runs="go(links.fnRuns($event))" @switched="(name, on) => modal.scope.value.switched?.(name, on)"
    >
      <template v-if="shownRuns.length > 0" #runs><FnRuns :runs="shownRuns" :now="now" title="Its runs here" @open="modal.openRun($event)" /></template>
    </FnDetails>
    <FnOverview
      v-else :name="fn" :about="fns.about.value.value" :facts="fns.facts.value.value" :loading="fns.facts.loading.value" :problem="fns.facts.problem.value"
      :examples="fns.examples.value" :examples-total="fns.examplesTotal.value" :more-examples="fns.examplesNext.value !== undefined" :examples-loading="fns.examplesLoading.value"
      :examples-problem="fns.examplesProblem.value" @more="fns.moreExamples()" @retry="fns.open(fn)"
    >
      <template v-if="shownRuns.length > 0" #runs><FnRuns :runs="shownRuns" :now="now" title="Its runs here" @open="modal.openRun($event)" /></template>
    </FnOverview>
    <template #footer>
      <UiButton variant="ghost" @click="modal.close()">Close</UiButton>
      <UiButton v-if="manage" variant="secondary" icon="arrow-right" data-testid="fn-open-page" @click="go(links.fn(fn))">Open page</UiButton>
    </template>
  </UiDialog>
</template>
