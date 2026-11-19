<script setup lang="ts">
/**
 * A saved widget's result (a run of a `widgets/widget` fn), drawn as the kind's result renderer: the app's result view
 * with the widget's chips, visuals, pager, drill and row actions, reading the widget fn again as the chips change. Its
 * Settings can keep the look picked there as the widget's own: that runs `make_widget` over the same source, which
 * proposes the change in the chat for the person to save.
 */
import { WidgetResult } from '@harness/core';
import { RESULT_VIEW, type ResultLook, type ResultView, type UntypedFn, type WithSystem } from '@harness/sdk';
import { computed, inject } from 'vue';
import type { WidgetsContract } from '../shared/index.ts';
import { lookArgs } from './proposal.ts';

const props = defineProps<ResultView<UntypedFn> & WithSystem<WidgetsContract['defs']>>();

const ResultViewComponent = inject(RESULT_VIEW, undefined);
const widget = computed(() => {
  const parsed = WidgetResult.safeParse(props.result);
  return parsed.success ? parsed.data : undefined;
});

async function keepLook(look: ResultLook): Promise<boolean> {
  const result = widget.value;
  if (result === undefined) { return false; }
  await props.system.run.make_widget(lookArgs(props.fn, result, look));
  return true;
}
</script>

<template>
  <component
    :is="ResultViewComponent" v-if="ResultViewComponent" :value="result" :fn="fn" :args="args" :title="title" :view-key="run"
    :keep-look="widget ? keepLook : undefined" data-testid="saved-widget"
  />
</template>
