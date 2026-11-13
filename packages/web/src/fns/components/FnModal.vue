<script setup lang="ts">
/**
 * A fn looked into without leaving where the person is (the chat, the runs browser): the fn's overview and the runs
 * of it the opener passes (the chat's own, newest first), with "Open page" for the full fn page when the person may
 * see it. A fn it uses opens in its place. `v-model:fn` is the fn shown; undefined closes it. Mount it only while open
 * (`v-if`), so it stacks over whatever sheet opened it. `manage` (an admin's system pages) adds what the fn page has
 * besides: its on/off switch (`switched` tells the opener), what a kind fn runs (a code fn's program, an api fn's request)
 * and its numbers over a period.
 */
import type { QualifiedName, RunId } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import FnStats from '../../admin/components/FnStats.vue';
import type { FnPeriod } from '../../admin/state/fn.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import type { RunView } from '../../chat/logic/runs.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiDialog, UiSwitch } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import type { PayloadForm } from '../logic/facts.ts';
import FnOverview from './FnOverview.vue';
import FnPayload from './FnPayload.vue';
import FnRuns from './FnRuns.vue';

const props = withDefaults(defineProps<{
  /** The runs of any fn the opener knows of; those of the fn shown are listed. */
  runs?: readonly RunView[];
  /** Whether the full fn page is the person's to open (admins). */
  canOpenPage?: boolean;
  /** Show the fn's on/off switch and its numbers, as its page does (admins). */
  manage?: boolean;
}>(), { runs: () => [], canOpenPage: false, manage: false });
const fn = defineModel<QualifiedName | undefined>('fn', { required: true });
const emit = defineEmits<{ run: [run: RunId]; page: [fn: QualifiedName]; switched: [fn: QualifiedName, on: boolean] }>();

const { fns, admin, toasts } = useStores();
const managed = admin.fn;
const days = ref<FnPeriod>(7);
const payloadForm = ref<PayloadForm>('readable');
const record = computed(() => (props.manage ? managed.record.value.value : undefined));

async function switchOn(on: boolean): Promise<void> {
  const name = record.value?.name;
  if (name === undefined) { return; }
  if (await managed.switchOn(on)) { emit('switched', name, on); } else { toasts.error(managed.switching.problem.value); }
}
const now = useNow(30_000);
const open = computed({ get: () => fn.value !== undefined, set: (isOpen: boolean) => { if (!isOpen) { fn.value = undefined; } } });
const shownRuns = computed(() => [...props.runs.filter((run) => run.fn === fn.value)].reverse());

watch(fn, (name) => { if (name !== undefined) { void fns.open(name); } }, { immediate: true });
watch([fn, days], ([name, period]) => { if (props.manage && name !== undefined) { void managed.open(name, period); } }, { immediate: true });
onBeforeUnmount(() => { fns.close(); if (props.manage) { managed.close(); } });
</script>

<template>
  <UiDialog v-model:open="open" :title="fn ? fnLabel(fn) : 'Fn'" :description="fn ?? ''" width="640px">
    <FnOverview
      v-if="fn" :name="fn" :about="fns.about.value.value" :facts="fns.facts.value.value" :loading="fns.facts.loading.value" :problem="fns.facts.problem.value"
      :examples="fns.examples.value" :examples-total="fns.examplesTotal.value" :more-examples="fns.examplesNext.value !== undefined" :examples-loading="fns.examplesLoading.value"
      :examples-problem="fns.examplesProblem.value" @fn="fn = $event" @more="fns.moreExamples()" @retry="fns.open(fn)"
    >
      <template v-if="record" #badges>
        <UiSwitch :model-value="!record.disabled" label="In use" :disabled="managed.switching.busy.value" data-testid="fn-on" @update:model-value="switchOn" />
      </template>
      <template #runs>
        <FnPayload v-if="record && record.name === fn" v-model:form="payloadForm" :payload="record.decl.payload" :readable="record.decl.readable" :max-height="240" />
        <FnRuns v-if="shownRuns.length > 0" :runs="shownRuns" :now="now" title="Its runs here" @open="emit('run', $event)" />
        <FnStats
          v-if="manage" v-model:days="days" :metrics="managed.metrics.value.value" :daily="managed.daily.value.value ?? []" :loading="managed.metrics.loading.value"
          :problem="managed.metrics.problem.value || managed.daily.problem.value" :now="now" compact @retry="fn && managed.open(fn, days)"
        />
      </template>
    </FnOverview>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Close</UiButton>
      <UiButton v-if="canOpenPage && fn" variant="secondary" icon="arrow-right" data-testid="fn-open-page" @click="fn && emit('page', fn)">Open page</UiButton>
    </template>
  </UiDialog>
</template>
