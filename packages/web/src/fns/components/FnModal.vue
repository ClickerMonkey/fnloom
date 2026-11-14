<script setup lang="ts">
/**
 * A fn looked into without leaving where the person is (the chat, a system's fn list, the runs browser, the graph).
 * `manage` (admins) shows everything its page shows, from the same `FnDetails`: its overview with its on/off switch
 * (`switched` tells the opener), its numbers over a period, what a kind fn runs, who may use it, its history and its
 * latest runs; otherwise its overview alone. The runs of it the opener passes (the chat's own, newest first) list under
 * the overview. "Open page" (`page`) goes to the full fn page when the person may see it; a fn it uses opens in its
 * place; a run opens through `run`, and All its runs goes to the runs browser. `v-model:fn` is the fn shown; undefined
 * closes it. Mount it only while open (`v-if`), so it stacks over whatever sheet opened it.
 */
import type { QualifiedName, RunId } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { links } from '../../app/routes.ts';
import type { FnPeriod } from '../../admin/state/fn.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import type { RunView } from '../../chat/logic/runs.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiDialog } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import type { PayloadForm } from '../logic/facts.ts';
import FnDetails from './FnDetails.vue';
import FnOverview from './FnOverview.vue';
import FnRuns from './FnRuns.vue';

const props = withDefaults(defineProps<{
  /** The runs of any fn the opener knows of; those of the fn shown are listed. */
  runs?: readonly RunView[];
  /** Whether the full fn page is the person's to open (admins). */
  canOpenPage?: boolean;
  /** Show all its page shows: its on/off switch, numbers, payload, access, history and latest runs (admins). */
  manage?: boolean;
}>(), { runs: () => [], canOpenPage: false, manage: false });
const fn = defineModel<QualifiedName | undefined>('fn', { required: true });
const emit = defineEmits<{ run: [run: RunId]; page: [fn: QualifiedName]; switched: [fn: QualifiedName, on: boolean] }>();

const { fns } = useStores();
const router = useRouter();
const days = ref<FnPeriod>(7);
const payloadForm = ref<PayloadForm>('readable');
const now = useNow(30_000);
const open = computed({ get: () => fn.value !== undefined, set: (isOpen: boolean) => { if (!isOpen) { fn.value = undefined; } } });
const shownRuns = computed(() => [...props.runs.filter((run) => run.fn === fn.value)].reverse());

/** All its runs, in the runs browser (the modal closes, so it doesn't stay over them). */
function allRuns(name: QualifiedName): void {
  fn.value = undefined;
  void router.push(links.fnRuns(name));
}

// FnDetails loads the fn itself when managing; the overview alone is loaded here
if (!props.manage) {
  watch(fn, (name) => { if (name !== undefined) { void fns.open(name); } }, { immediate: true });
  onBeforeUnmount(() => { fns.close(); });
}
</script>

<template>
  <UiDialog v-model:open="open" :title="fn ? fnLabel(fn) : 'Fn'" :description="fn ?? ''" width="720px">
    <template v-if="fn">
      <FnDetails
        v-if="manage" v-model:days="days" v-model:form="payloadForm" :name="fn" compact
        @fn="fn = $event" @run="emit('run', $event)" @runs="allRuns" @switched="(name, on) => emit('switched', name, on)"
      >
        <template v-if="shownRuns.length > 0" #runs><FnRuns :runs="shownRuns" :now="now" title="Its runs here" @open="emit('run', $event)" /></template>
      </FnDetails>
      <FnOverview
        v-else :name="fn" :about="fns.about.value.value" :facts="fns.facts.value.value" :loading="fns.facts.loading.value" :problem="fns.facts.problem.value"
        :examples="fns.examples.value" :examples-total="fns.examplesTotal.value" :more-examples="fns.examplesNext.value !== undefined" :examples-loading="fns.examplesLoading.value"
        :examples-problem="fns.examplesProblem.value" @fn="fn = $event" @more="fns.moreExamples()" @retry="fn && fns.open(fn)"
      >
        <template v-if="shownRuns.length > 0" #runs><FnRuns :runs="shownRuns" :now="now" title="Its runs here" @open="emit('run', $event)" /></template>
      </FnOverview>
    </template>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Close</UiButton>
      <UiButton v-if="canOpenPage && fn" variant="secondary" icon="arrow-right" data-testid="fn-open-page" @click="fn && emit('page', fn)">Open page</UiButton>
    </template>
  </UiDialog>
</template>
