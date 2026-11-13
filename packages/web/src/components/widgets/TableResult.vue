<script setup lang="ts">
/**
 * A run's result that is rows (build 8): a widget's result drawn as the widget, or a plain result table drawn with the
 * hub's visuals and, where an agent can be asked, "Save as widget", which asks it to make one from the run's fn and
 * args (`hub/make_widget`).
 */
import { HUB_VISUALS, QualifiedName, type Json } from '@harness/core';
import { computed, inject, ref } from 'vue';
import { UiIconButton } from '../../ui/index.ts';
import ResultBlock from '../results/ResultBlock.vue';
import WidgetView from './WidgetView.vue';
import { resultTableOf, WIDGET_HOST, widgetResultOf } from './widgets.ts';

const props = withDefaults(defineProps<{
  value: Json | undefined;
  /** The fn that returned it and the args it ran with. */
  fn: QualifiedName;
  args?: Json | undefined;
  title: string;
  viewKey?: string;
}>(), { args: undefined, viewKey: '' });

const host = inject(WIDGET_HOST, undefined);
const registry = QualifiedName.parse(HUB_VISUALS);
const widget = computed(() => widgetResultOf(props.value));
const table = computed(() => (widget.value === undefined ? resultTableOf(props.value) : undefined));
const asking = ref(false);

async function save(): Promise<void> {
  if (host?.saveAsWidget === undefined || asking.value) { return; }
  asking.value = true;
  try { await host.saveAsWidget(props.fn, props.args); } finally { asking.value = false; }
}
</script>

<template>
  <WidgetView v-if="widget" :result="widget" :fn="fn" :args="args" :view-key="viewKey" :show-title="widget.title !== title" />
  <ResultBlock v-else-if="table" :table="table" :title="title" :registry="registry" :view-key="viewKey">
    <template #tools>
      <UiIconButton v-if="host?.saveAsWidget" icon="grid" label="Save as widget" size="sm" :disabled="asking" data-testid="save-as-widget" @click="save" />
    </template>
  </ResultBlock>
</template>
