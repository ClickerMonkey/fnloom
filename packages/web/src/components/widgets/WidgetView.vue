<script setup lang="ts">
/**
 * A widget (widget pass): its title, or a breadcrumb once a drill or an action opened a level; the chip row (presets,
 * one chip per control, Apply); any binding that no longer fits; and the result view, drawn with the widget's own
 * visuals in its order (or every fitting one for a plain table). The grid pages through the rows held and the
 * buffered pager reads more only when a page needs them; a chart's zoom or period sets the range args; a click on a
 * row's mark runs the drill, else opens the row's actions (form, then confirm). Its tools: Live (re-runs in place while
 * shown), Refresh (or "Run again", which asks first, for rows a write returned: those are read-only, without chips,
 * pager or drill), and "Download every row" in the download menu (the hub's streamed export of the whole result).
 * Without a widget host, or without a fn to ask again (a proposal's preview), it draws what it has.
 *
 * A page can give it its own source (the Data page's records over `hub/records_table`), its own row menu (`opener`), a
 * sort its source does (`sort`) and tools before the visual switcher (`lead`). Where the rows are stored records and
 * the host can change them, editable cells are inputs: changes are staged, then "Save N changes" asks once, naming
 * them, and saves each record.
 */
import { HUB_VISUALS, QualifiedName, type Json, type ResultSort } from '@harness/core';
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import ConfirmDialog from '../../admin/components/ConfirmDialog.vue';
import { UiBanner, UiButton, UiIcon, UiIconButton } from '../../ui/index.ts';
import { OWN_HOST, RESULTS_HOST } from '../results/builtin.ts';
import ResultView from '../results/ResultView.vue';
import type { PageRequest, ResultPager } from '../results/table.ts';
import type { RowOpener, VisualChoice } from '../results/visuals.ts';
import { CELL_EDITOR, editInput, RecordEdits } from './record-edits.ts';
import RecordEditsDialog from './RecordEditsDialog.vue';
import WidgetActionDialog from './WidgetActionDialog.vue';
import WidgetChips from './WidgetChips.vue';
import { FnWidgetSource, type WidgetFrame, type WidgetSource } from './widget-source.ts';
import { startArgs, WidgetState } from './widget-state.ts';
import { WIDGET_HOST, widgetVisuals } from './widgets.ts';

const props = withDefaults(defineProps<{
  frame: WidgetFrame;
  /** The fn asked again (the widget fn, or the table's fn), and the args it ran with; no fn draws only what it has. */
  fn?: QualifiedName | undefined;
  args?: Json | undefined;
  /** Where the visual picked and the drill levels are kept (a run's id); empty keeps them only while mounted. */
  viewKey?: string;
  /** Show its title (off where the frame around it already names it, a run card). */
  showTitle?: boolean;
  /** Its own source, over a fn's (the Data page's records). */
  source?: WidgetSource | undefined;
  /** The page's own row menu, over the host's row actions (the Data page opens a record). */
  opener?: RowOpener | undefined;
  /** A sort its source does (the rows held are a slice of a sorted whole); without it the grid sorts the rows held. */
  sort?: ((next: ResultSort | undefined) => void) | undefined;
}>(), { fn: undefined, args: undefined, viewKey: '', showTitle: true, source: undefined, opener: undefined, sort: undefined });
const emit = defineEmits<{ saved: [count: number] }>();

const results = inject(RESULTS_HOST, OWN_HOST);
const host = inject(WIDGET_HOST, undefined);
const registry = QualifiedName.parse(HUB_VISUALS);
const state = new WidgetState(host, {
  frame: props.frame,
  args: startArgs(props.args, props.frame.paging?.offset),
  source: props.source ?? (host === undefined || props.fn === undefined ? undefined : new FnWidgetSource(host, props.fn, props.frame.title)),
  key: props.viewKey === '' ? 'widget' : props.viewKey,
});

const level = state.level;
const top = computed(() => level.value.frame);
const keyed = computed(() => (state.levels.value.length > 1 ? `${props.viewKey}#${String(state.levels.value.length - 1)}` : props.viewKey));
const local = ref<VisualChoice | undefined>(undefined);
const choice = computed({
  // the host keeps it under the view's key where it can; the local copy holds it on a page whose host keeps none
  get: () => (keyed.value === '' ? undefined : results.choice(keyed.value)) ?? local.value,
  set: (picked: VisualChoice | undefined) => {
    if (picked === undefined) { return; }
    local.value = picked;
    if (keyed.value !== '') { results.choose(keyed.value, picked); }
  },
});
const visuals = computed(() => {
  const ranked = results.visuals(registry, state.table.value, state.facts.value);
  return top.value.visuals === undefined ? ranked : widgetVisuals(ranked, top.value.visuals);
});

const editable = computed(() => state.live.value && !top.value.readOnly);
const pager = computed((): ResultPager | undefined => {
  if (!editable.value || top.value.paging === undefined) { return undefined; }
  const ask = (request: PageRequest): void => { if (request.offset >= state.table.value.rows.length) { void state.more(); } };
  return Object.assign(ask, { buffered: true, sort: props.sort });
});
const opener = computed((): RowOpener | undefined => {
  if (props.opener !== undefined) { return props.opener; }
  if (host === undefined || level.value.actions.length === 0) { return undefined; }
  const indexOf = (row: readonly Json[]): number => state.table.value.rows.findIndex((held) => held === row);
  return { label: 'Actions', has: (row) => state.hasActions(indexOf(row)), open: (row) => { state.openRow(indexOf(row)); } };
});

const actionsOpen = computed({ get: () => state.row.value !== undefined, set: (on: boolean) => { if (!on) { state.close(); } } });
const askingAgain = ref(false);
async function runAgain(): Promise<void> {
  askingAgain.value = false;
  if (host === undefined || props.fn === undefined) { return; }
  const ran = await host.run(props.fn, startArgs(props.args, undefined));
  state.status.value = ran.ok ? 'Ran again: its rows show as a new run.' : ran.problem;
}

// inline editing: the rows are stored records, some fields editable, and the host can change them
const update = host?.update;
const editing = computed(() => update !== undefined && !top.value.readOnly && state.table.value.records !== undefined && state.table.value.columns.some((c) => editInput(c) !== undefined));
const edits = new RecordEdits(() => (editing.value ? state.table.value : undefined));
provide(CELL_EDITOR, edits);
const confirming = ref(false);
const saving = ref(false);
const failed = ref<readonly string[]>([]);
const editLines = computed(() => (confirming.value ? edits.changes().map((change) => edits.describe(change)) : []));
function review(): void {
  failed.value = [];
  confirming.value = true;
}
async function saveEdits(): Promise<void> {
  if (update === undefined) { return; }
  saving.value = true;
  try {
    const outcome = await edits.save(update);
    failed.value = outcome.failed;
    if (outcome.failed.length === 0) { confirming.value = false; }
    if (outcome.saved > 0) {
      emit('saved', outcome.saved);
      await state.refresh();
      state.status.value = `${String(outcome.saved)} ${outcome.saved === 1 ? 'record' : 'records'} saved.`;
    }
  } finally {
    saving.value = false;
  }
}

const root = ref<HTMLElement | null>(null);
let onScreen = true;
let observer: IntersectionObserver | undefined;
onMounted(() => {
  void results.prepare(registry);
  void state.loadActions();
  void state.restore();
  if (typeof IntersectionObserver !== 'undefined' && root.value !== null) {
    observer = new IntersectionObserver((entries) => { onScreen = entries.some((entry) => entry.isIntersecting); });
    observer.observe(root.value);
  }
  state.startLive(() => onScreen && document.visibilityState !== 'hidden');
});
onBeforeUnmount(() => { state.stopLive(); observer?.disconnect(); });
watch(() => state.levels.value.length, () => { void state.loadActions(); });

const liveText = computed(() => {
  const every = state.every.value;
  return every === undefined ? '' : `Live, every ${every >= 60_000 ? `${String(Math.round(every / 60_000))} min` : `${String(Math.round(every / 1000))} s`}`;
});
const problem = computed(() => state.reading.problem.value);
function exportAll(): void { if (!state.reading.busy.value) { void state.exportCsv(); } }
</script>

<template>
  <section ref="root" class="widget" data-testid="widget-view" :data-widget="fn" :data-level="state.levels.value.length - 1">
    <nav v-if="state.levels.value.length > 1" class="crumbs" aria-label="Levels" data-testid="widget-crumbs">
      <template v-for="(crumb, i) in state.levels.value" :key="i">
        <UiIcon v-if="i > 0" name="chevron-right" :size="12" class="sep" />
        <button v-if="i < state.levels.value.length - 1" type="button" class="crumb" data-testid="widget-crumb" @click="state.back(i)">{{ crumb.label }}</button>
        <span v-else class="crumb here" aria-current="page">{{ crumb.label }}</span>
      </template>
    </nav>
    <h3 v-else-if="showTitle" class="title">{{ top.title }}</h3>
    <WidgetChips
      v-if="!top.readOnly" :controls="top.controls" :presets="top.presets" :current-of="(arg) => state.chipValue(arg)" :dirty="state.dirty.value"
      :busy="state.reading.busy.value" :editable="editable" @stage="(arg, value) => state.stage(arg, value)" @apply="state.apply()" @discard="state.discard()"
      @preset="state.preset($event)"
    />
    <UiBanner v-if="top.problems.length > 0" tone="warn" data-testid="widget-problems">
      {{ top.problems.length === 1 ? top.problems[0] : `${top.problems.length} views no longer fit:` }}
      <ul v-if="top.problems.length > 1" class="problems"><li v-for="p in top.problems" :key="p">{{ p }}</li></ul>
    </UiBanner>
    <ResultView
      v-model:choice="choice" :table="state.table.value" :title="top.title" :visuals="visuals" :facts="state.facts.value" :pager="pager" :opener="opener"
      :drills="state.drills.value && !top.readOnly"
      :export-all="top.export !== undefined && host !== undefined ? exportAll : undefined" @drill="state.drill($event)" @range="state.range($event)"
    >
      <template v-if="$slots['lead']" #lead><slot name="lead" /></template>
      <template #tools>
        <template v-if="edits.count.value > 0">
          <UiButton size="sm" variant="ghost" data-testid="record-edits-discard" @click="edits.discard()">Discard</UiButton>
          <UiButton size="sm" variant="primary" icon="check" data-testid="record-edits-review" @click="review">Save {{ edits.count.value }} {{ edits.count.value === 1 ? 'change' : 'changes' }}</UiButton>
        </template>
        <slot name="tools" />
        <span v-if="liveText !== ''" class="live" data-testid="widget-live"><span class="pulse" aria-hidden="true" />{{ liveText }}</span>
        <UiIconButton v-if="top.readOnly && host && fn" icon="refresh" label="Run again" size="sm" data-testid="widget-run-again" @click="askingAgain = true" />
        <UiIconButton
          v-else-if="state.live.value" icon="refresh" label="Refresh" size="sm" :disabled="state.reading.busy.value" data-testid="widget-refresh" @click="state.refresh()"
        />
      </template>
    </ResultView>
    <p v-if="problem !== '' || state.status.value !== ''" class="status" :class="{ bad: problem !== '' }" role="status" data-testid="widget-status">
      {{ problem !== '' ? problem : state.status.value }}
    </p>
    <WidgetActionDialog
      v-model:open="actionsOpen" :offered="state.offered.value" :picked="state.picked.value" :step="state.step.value" :row="state.rowName.value"
      :busy="state.acting.busy.value" :problem="state.acting.problem.value" @choose="state.choose($event)" @form="state.submitForm($event)" @run="state.runAction()"
    />
    <RecordEditsDialog v-model:open="confirming" :lines="editLines" :count="edits.count.value" :busy="saving" :failed="failed" @save="saveEdits" />
    <ConfirmDialog
      v-model:open="askingAgain" title="Run it again?" confirm="Run again" :danger="false"
      body="These rows came from a change. Running it again makes that change again." @confirm="runAgain"
    />
  </section>
</template>

<style scoped>
.widget { display: grid; gap: var(--space-2); min-width: 0; }
.title { min-width: 0; margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--space-1); min-width: 0; font-size: var(--text-sm); }
.crumb { max-width: 16rem; padding: 2px var(--space-1); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--accent); font: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.crumb:hover { background: var(--surface-2); }
.crumb:focus-visible { outline: none; box-shadow: var(--ring); }
.crumb.here { color: var(--text); font-weight: var(--weight-strong); cursor: default; }
.sep { color: var(--text-faint); }
.problems { margin: var(--space-1) 0 0; padding-left: var(--space-4); }
.live { display: inline-flex; align-items: center; gap: 6px; padding: 0 var(--space-2); color: var(--text-dim); font-size: var(--text-xs); white-space: nowrap; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--success, var(--accent)); animation: pulse 2s var(--ease) infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
.status { margin: 0; color: var(--text-dim); font-size: var(--text-xs); }
.status.bad { color: var(--danger); }
</style>
