<script setup lang="ts">
/**
 * A run's result that is rows (widget pass): a widget's result drawn as the widget, a widget proposal drawn as its
 * preview card with Save, or a plain result table drawn in the same widget view (every fitting visual, its rows'
 * actions, read-only when a write returned it) with "Make a widget" in its 3-dot menu, which asks the agent to propose
 * one from the run's fn and args (`widgets/make_widget`). A saved widget's Settings can save the look picked there.
 */
import type { Json, QualifiedName } from '@harness/core';
import { computed, inject, ref } from 'vue';
import type { MenuAction } from '../../ui/index.ts';
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
/** A plain table (not a widget, not a write's rows) can be made into a widget, where there is an agent to ask. */
const items = computed((): MenuAction<string>[] => (
  !isWidget.value && frame.value?.readOnly !== true && host?.ask !== undefined ? [{ value: 'make-widget', label: 'Make a widget', icon: 'grid', disabled: asking.value }] : []
));
function onItem(value: string): void { if (value === 'make-widget') { void makeWidget(); } }

async function makeWidget(): Promise<void> {
  if (host?.ask === undefined || asking.value) { return; }
  asking.value = true;
  try { await host.ask(saveWidgetRequest(props.fn, props.args), true); } finally { asking.value = false; }
}
</script>

<template>
  <WidgetProposal v-if="proposal" :proposal="proposal" :view-key="viewKey" />
  <WidgetView
    v-else-if="frame" :key="viewKey" :frame="frame" :fn="isWidget || frame.readOnly ? fn : undefined" :args="args" :view-key="viewKey" :show-title="frame.title !== title"
    :widget="isWidget ? fn : undefined" :items="items" @item="onItem"
  />
</template>
