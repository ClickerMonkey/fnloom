<script setup lang="ts">
/**
 * A run's result that is rows (widget pass), and the app's result view systems' renderers draw with (the SDK's
 * `RESULT_VIEW`, props `ResultViewProps`): a widget's result drawn as the widget, or a plain result table drawn in the
 * same widget view (every fitting visual, its rows' actions, read-only when a write returned it) with "Make a widget" in
 * its 3-dot menu, which asks the agent to propose one from the run's fn and args (`widgets/make_widget`). A widget
 * proposal's preview draws as it is (the widgets system's renderer adds its card and Save). Where the result can keep
 * the look picked in Settings (`keepLook`: a saved widget), Settings offers it.
 */
import type { Json, QualifiedName } from '@harness/core';
import type { ResultLook } from '@harness/sdk';
import { computed, inject, ref } from 'vue';
import type { MenuAction } from '../../ui/index.ts';
import { frameOf } from './widget-source.ts';
import WidgetView from './WidgetView.vue';
import { resultTableOf, saveWidgetRequest, widgetResultOf, WIDGET_HOST } from './widgets.ts';

const props = withDefaults(defineProps<{
  value: Json;
  title: string;
  /** The fn that returned it; without one it draws only what it has (a preview). */
  fn?: QualifiedName | undefined;
  /** The args it ran with. */
  args?: Json | undefined;
  viewKey?: string;
  keepLook?: ((look: ResultLook) => Promise<boolean>) | undefined;
}>(), { fn: undefined, args: undefined, viewKey: '', keepLook: undefined });

const host = inject(WIDGET_HOST, undefined);
const frame = computed(() => frameOf(props.value, props.title));
const isWidget = computed(() => widgetResultOf(props.value) !== undefined);
const asking = ref(false);
/** A plain table (not a widget, not a write's rows) can be made into a widget, where there is an agent to ask. */
const items = computed((): MenuAction<string>[] => (
  props.fn !== undefined && resultTableOf(props.value) !== undefined && frame.value?.readOnly !== true && host?.ask !== undefined
    ? [{ value: 'make-widget', label: 'Make a widget', icon: 'grid', disabled: asking.value }] : []
));
function onItem(value: string): void { if (value === 'make-widget') { void makeWidget(); } }

async function makeWidget(): Promise<void> {
  if (host?.ask === undefined || props.fn === undefined || asking.value) { return; }
  asking.value = true;
  try { await host.ask(saveWidgetRequest(props.fn, props.args), true); } finally { asking.value = false; }
}
</script>

<template>
  <WidgetView
    v-if="frame" :key="viewKey" :frame="frame" :fn="isWidget || frame.readOnly ? fn : undefined" :args="args" :view-key="viewKey" :show-title="frame.title !== title"
    :keep-look="keepLook" :items="items" @item="onItem"
  />
</template>
