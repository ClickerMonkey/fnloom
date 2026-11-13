<script setup lang="ts">
/**
 * A run's result that is rows (widget pass): a widget's result drawn as the widget, a widget proposal drawn as its
 * preview card with Save, or a plain result table drawn in the same widget view (every fitting visual, its rows'
 * actions, read-only when a write returned it) with "Make a widget", which asks the agent to propose one from the
 * run's fn and args (`widgets/make_widget`).
 */
import type { Json, QualifiedName } from '@harness/core';
import { computed, inject, ref } from 'vue';
import { UiIconButton } from '../../ui/index.ts';
import { frameOf } from './widget-source.ts';
import WidgetProposal from './WidgetProposal.vue';
import WidgetView from './WidgetView.vue';
import { proposalOf, saveWidgetRequest, widgetResultOf, WIDGET_HOST } from './widgets.ts';

const props = withDefaults(defineProps<{
  value: Json | undefined;
  /** The fn that returned it and the args it ran with. */
  fn: QualifiedName;
  args?: Json | undefined;
  title: string;
  viewKey?: string;
}>(), { args: undefined, viewKey: '' });

const host = inject(WIDGET_HOST, undefined);
const proposal = computed(() => proposalOf(props.value));
const frame = computed(() => (proposal.value === undefined ? frameOf(props.value, props.title) : undefined));
const isWidget = computed(() => widgetResultOf(props.value) !== undefined);
const asking = ref(false);

async function makeWidget(): Promise<void> {
  if (host?.ask === undefined || asking.value) { return; }
  asking.value = true;
  try { await host.ask(saveWidgetRequest(props.fn, props.args), true); } finally { asking.value = false; }
}
</script>

<template>
  <WidgetProposal v-if="proposal" :proposal="proposal" :view-key="viewKey" />
  <WidgetView v-else-if="frame" :key="viewKey" :frame="frame" :fn="isWidget || frame.readOnly ? fn : undefined" :args="args" :view-key="viewKey" :show-title="frame.title !== title">
    <template v-if="!isWidget && !frame.readOnly && host?.ask" #tools>
      <UiIconButton icon="grid" label="Make a widget" size="sm" :disabled="asking" data-testid="save-as-widget" @click="makeWidget" />
    </template>
  </WidgetView>
</template>
