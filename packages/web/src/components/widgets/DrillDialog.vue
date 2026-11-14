<script setup lang="ts">
/**
 * A drill in a modal (build-9 feedback, drill-downs from every widget): the rows behind the group a person clicked,
 * read with the drill's fn (a widget's own drill, or `database/drill_down` through the query) and drawn as a widget of
 * their own, a table first and every other fitting visual a pick away, with the same 3-dot menu. The pager reads the
 * next page by the drill's paging args. A click on one of its rows drills again as a level inside the modal, with a
 * breadcrumb back; those levels stay out of the URL. Closing it leaves the widget it was opened from as it was.
 */
import { inject, onMounted, provide, ref, shallowRef } from 'vue';
import { UiBanner, UiDialog, UiSpinner } from '../../ui/index.ts';
import { FnWidgetSource, type WidgetFrame } from './widget-source.ts';
import { WIDGET_HOST, type DrillStep } from './widgets.ts';
import WidgetView from './WidgetView.vue';

const props = defineProps<{
  step: DrillStep;
  /** The title of the widget it was opened from. */
  from: string;
  /** Where the visual picked is kept; empty keeps it only while open. */
  viewKey: string;
}>();
const emit = defineEmits<{ close: [] }>();

const host = inject(WIDGET_HOST, undefined);
// the modal's own levels are not the page's: they stay out of the URL's `level`
if (host !== undefined) { provide(WIDGET_HOST, { ...host, levels: undefined }); }
const source = host === undefined ? undefined : new FnWidgetSource(host, props.step.fn, props.step.label, props.step.paging);
const frame = shallowRef<WidgetFrame | undefined>(undefined);
const problem = ref('');
const open = ref(true);

function close(on: boolean): void {
  open.value = on;
  if (!on) { emit('close'); }
}

onMounted(async () => {
  if (source === undefined) { problem.value = 'There is nothing to read the rows with here.'; return; }
  try {
    frame.value = await source.run(props.step.args);
  } catch (error) {
    problem.value = `Couldn't open ${props.step.label}: ${error instanceof Error ? error.message : String(error)}`;
  }
});
</script>

<template>
  <UiDialog :open="open" :title="step.label" :description="`The rows behind it, from ${from}.`" width="960px" data-testid="drill-dialog" @update:open="close">
    <div class="drill">
      <UiBanner v-if="problem !== ''" tone="danger" data-testid="drill-problem">{{ problem }}</UiBanner>
      <WidgetView
        v-else-if="frame" :frame="frame" :fn="step.fn" :args="step.args" :source="source" :view-key="viewKey" :show-title="false" in-drill first-visual="table"
      />
      <p v-else class="loading" data-testid="drill-loading"><UiSpinner /> Reading the rows…</p>
    </div>
  </UiDialog>
</template>

<style scoped>
.drill { display: grid; gap: var(--space-2); min-width: 0; min-height: 120px; }
.loading { display: flex; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
