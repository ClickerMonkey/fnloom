<script setup lang="ts">
/**
 * A fn looked into without leaving where the person is (the chat, the runs browser): the fn's overview and the runs
 * of it the opener passes (the chat's own, newest first), with "Open page" for the full fn page when the person may
 * see it. A fn it uses opens in its place. `v-model:fn` is the fn shown; undefined closes it. Mount it only while open
 * (`v-if`), so it stacks over whatever sheet opened it.
 */
import type { QualifiedName, RunId } from '@harness/core';
import { computed, onBeforeUnmount, watch } from 'vue';
import { fnLabel } from '../../chat/logic/labels.ts';
import type { RunView } from '../../chat/logic/runs.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiDialog } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import FnOverview from './FnOverview.vue';
import FnRuns from './FnRuns.vue';

const props = withDefaults(defineProps<{
  /** The runs of any fn the opener knows of; those of the fn shown are listed. */
  runs?: readonly RunView[];
  /** Whether the full fn page is the person's to open (admins). */
  canOpenPage?: boolean;
}>(), { runs: () => [], canOpenPage: false });
const fn = defineModel<QualifiedName | undefined>('fn', { required: true });
const emit = defineEmits<{ run: [run: RunId]; page: [fn: QualifiedName] }>();

const { fns } = useStores();
const now = useNow(30_000);
const open = computed({ get: () => fn.value !== undefined, set: (isOpen: boolean) => { if (!isOpen) { fn.value = undefined; } } });
const shownRuns = computed(() => [...props.runs.filter((run) => run.fn === fn.value)].reverse());

watch(fn, (name) => { if (name !== undefined) { void fns.open(name); } }, { immediate: true });
onBeforeUnmount(() => { fns.close(); });
</script>

<template>
  <UiDialog v-model:open="open" :title="fn ? fnLabel(fn) : 'Fn'" :description="fn ?? ''" width="640px">
    <FnOverview
      v-if="fn" :name="fn" :about="fns.about.value.value" :facts="fns.facts.value.value" :loading="fns.facts.loading.value" :problem="fns.facts.problem.value"
      :examples="fns.examples.value" :examples-total="fns.examplesTotal.value" :more-examples="fns.examplesNext.value !== undefined" :examples-loading="fns.examplesLoading.value"
      :examples-problem="fns.examplesProblem.value" @fn="fn = $event" @more="fns.moreExamples()" @retry="fns.open(fn)"
    >
      <template #runs>
        <FnRuns v-if="shownRuns.length > 0" :runs="shownRuns" :now="now" title="Its runs here" @open="emit('run', $event)" />
      </template>
    </FnOverview>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Close</UiButton>
      <UiButton v-if="canOpenPage && fn" variant="secondary" icon="arrow-right" data-testid="fn-open-page" @click="fn && emit('page', fn)">Open page</UiButton>
    </template>
  </UiDialog>
</template>
