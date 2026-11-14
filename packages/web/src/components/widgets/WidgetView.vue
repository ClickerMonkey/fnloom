<script setup lang="ts">
/**
 * A widget (widget pass). Its chrome shows only what says what data it is (build-9 feedback, widget chrome): its title,
 * or a breadcrumb once a drill or an action opened a level; the chip row (presets, one chip per control, Apply); any
 * binding that no longer fits; Live (re-runs in place while shown); and, when it offers a chosen few visuals (a
 * widget's own), a small toggle between them. The rest is in the result view's 3-dot menu: exports (with "every row",
 * the hub's streamed export of the whole result), Refresh (or "Run again", which asks first, for rows a write
 * returned: those are read-only, without chips, pager or drill), the page's items, full screen and Settings (every
 * fitting visual and its style; a saved widget's look is saved by asking the agent to change it, which the person
 * then saves). The grid pages through the rows held and the buffered pager reads more only when a page needs them; a
 * chart's zoom or period sets the range args; a click on a row's mark runs the drill (the widget's own, else the one
 * through the query its rows declare: build-9 feedback), else opens the row's actions (form, then confirm). A drill opens
 * the rows behind the group in a modal (`DrillDialog`), as a widget of its own, a table first; inside it (`inDrill`) a
 * drill opens as a level, with a breadcrumb back. Without a widget host, or without a fn to ask again (a proposal's
 * preview), it draws what it has.
 *
 * A page can give it its own source (the Data page's records over `hub/records_table`), its own row menu (`opener`), a
 * sort its source does (`sort`), context beside its chips (`lead`: the Data page's search and filters) and menu items
 * (`items`, chosen with `item`). Where the rows are stored records and the host can change them, editable cells are
 * inputs: changes are staged, then "Save N changes" asks once, naming them, and saves each record.
 */
import { HUB_VISUALS, QualifiedName, type Json, type ResultSort } from '@harness/core';
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import ConfirmDialog from '../../admin/components/ConfirmDialog.vue';
// the drill's modal draws a widget view of its own (the two import each other; each uses the other only when drawn)
import DrillDialog from './DrillDialog.vue';
import { UiBanner, UiButton, UiIcon, type MenuAction } from '../../ui/index.ts';
import { OWN_HOST, RESULTS_HOST } from '../results/builtin.ts';
import ResultView from '../results/ResultView.vue';
import type { PageRequest, ResultPager } from '../results/table.ts';
import { DRILLABLE, chosenVisual, styleLabel, type RowOpener, type VisualChoice } from '../results/visuals.ts';
import { CELL_EDITOR, editInput, RecordEdits } from './record-edits.ts';
import RecordEditsDialog from './RecordEditsDialog.vue';
import WidgetActionDialog from './WidgetActionDialog.vue';
import WidgetChips from './WidgetChips.vue';
import { FnWidgetSource, type WidgetFrame, type WidgetSource } from './widget-source.ts';
import { startArgs, WidgetState } from './widget-state.ts';
import { saveLookRequest, WIDGET_HOST, widgetVisuals, type DrillStep } from './widgets.ts';

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
  /** The saved widget this draws: Settings can save its look (by asking the agent to change it). */
  widget?: QualifiedName | undefined;
  /** The page's own items in the 3-dot menu (Make a widget); a pick emits `item`. */
  items?: readonly MenuAction<string>[];
  /** It draws a drill in its modal: a drill opens as a level here, with a breadcrumb back, rather than another modal. */
  inDrill?: boolean;
  /** The visual shown until the person picks another (a drill's rows: the table). */
  firstVisual?: string | undefined;
}>(), { fn: undefined, args: undefined, viewKey: '', showTitle: true, source: undefined, opener: undefined, sort: undefined, widget: undefined, items: () => [], inDrill: false, firstVisual: undefined });
const emit = defineEmits<{ saved: [count: number]; item: [value: string] }>();

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
const local = ref<VisualChoice | undefined>(props.firstVisual === undefined ? undefined : { visual: props.firstVisual });
const choice = computed({
  // the host keeps it under the view's key where it can; the local copy holds it on a page whose host keeps none
  get: () => (keyed.value === '' ? undefined : results.choice(keyed.value)) ?? local.value,
  set: (picked: VisualChoice | undefined) => {
    if (picked === undefined) { return; }
    local.value = picked;
    if (keyed.value !== '') { results.choose(keyed.value, picked); }
  },
});
/** Every visual that can draw it, best first. */
const ranked = computed(() => results.visuals(registry, state.table.value, state.facts.value));
/** A widget's own visuals (the few its author chose) show as a toggle; without them, every fitting one is in Settings. */
const subset = computed(() => {
  const own = top.value.visuals;
  return own !== undefined && own.some((entry) => ranked.value.some((r) => r.visual.name === entry.visual));
});
const visuals = computed(() => (subset.value && top.value.visuals !== undefined ? widgetVisuals(ranked.value, top.value.visuals) : ranked.value));
/** The fitting visuals beside a widget's own, offered in Settings only. */
const others = computed(() => (subset.value ? ranked.value.filter((r) => !visuals.value.some((v) => v.visual.name === r.visual.name)) : []));

const editable = computed(() => state.live.value && !top.value.readOnly);
/** A click on a row's mark drills (the visuals mark what they draw as clickable then). */
const drillable = computed(() => state.drills.value && !top.value.readOnly);
provide(DRILLABLE, drillable);
/** The drill open in the modal. */
const drilling = shallowRef<DrillStep | undefined>(undefined);
function onDrill(row: number): void {
  if (props.inDrill) { void state.drill(row); return; }
  const step = state.drillStep(row);
  if (step !== undefined) { drilling.value = step; }
}
const pager = computed((): ResultPager | undefined => {
  if (!editable.value || top.value.paging === undefined) { return undefined; }
  const ask = (request: PageRequest): void => { if (request.offset >= state.table.value.rows.length) { void state.more(); } };
  return Object.assign(ask, { buffered: true, sort: props.sort });
});
/** The row whose actions are open, when the page's own opener leads the list ("Open" the record, then its actions). */
const pageRow = shallowRef<readonly Json[] | undefined>(undefined);
const opener = computed((): RowOpener | undefined => {
  const page = props.opener;
  if (host === undefined || level.value.actions.length === 0) { return page; }
  const indexOf = (row: readonly Json[]): number => state.table.value.rows.findIndex((held) => held === row);
  if (page === undefined) { return { label: 'Actions', has: (row) => state.hasActions(indexOf(row)), open: (row) => { state.openRow(indexOf(row)); } }; }
  return {
    label: page.label,
    has: (row) => page.has(row) || state.hasActions(indexOf(row)),
    open: (row) => {
      const index = indexOf(row);
      if (!state.hasActions(index)) { page.open(row); return; }
      pageRow.value = page.has(row) ? row : undefined;
      state.openRow(index);
    },
  };
});
const lead = computed(() => (pageRow.value === undefined || props.opener === undefined ? undefined : props.opener.label));
function openFromPage(): void {
  const row = pageRow.value;
  state.close();
  if (row !== undefined) { props.opener?.open(row); }
}

const actionsOpen = computed({ get: () => state.row.value !== undefined, set: (on: boolean) => { if (!on) { state.close(); } } });
watch(actionsOpen, (on) => { if (!on) { pageRow.value = undefined; } });
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

/** The menu's widget items: Run again (rows a write returned) or Refresh, then the page's own. */
const menuItems = computed((): MenuAction<string>[] => [
  ...(top.value.readOnly && host !== undefined && props.fn !== undefined ? [{ value: 'run-again', label: 'Run again…', icon: 'refresh' as const }]
    : state.live.value ? [{ value: 'refresh', label: 'Refresh', icon: 'refresh' as const, disabled: state.reading.busy.value }] : []),
  ...props.items,
]);
function onItem(value: string): void {
  if (value === 'run-again') { askingAgain.value = true; return; }
  if (value === 'refresh') { void state.refresh(); return; }
  emit('item', value);
}

/** Save the look picked in Settings as the saved widget's own: the agent proposes the change, the person saves it. */
const savingLook = ref(false);
const canSaveLook = computed(() => props.widget !== undefined && host?.ask !== undefined);
async function saveLook(close: () => void): Promise<void> {
  const shown = chosenVisual([...visuals.value, ...others.value], choice.value);
  if (props.widget === undefined || host?.ask === undefined || shown === undefined || savingLook.value) { return; }
  savingLook.value = true;
  try {
    const asked = await host.ask(saveLookRequest(props.widget, shown.ranked.visual.label, styleLabel(shown.ranked.visual.shape, shown.style)), true);
    if (asked) { close(); }
  } finally {
    savingLook.value = false;
  }
}
</script>

<template>
  <section ref="root" class="widget" data-testid="widget-view" :data-widget="fn" :data-level="state.levels.value.length - 1">
    <ResultView
      v-model:choice="choice" :table="state.table.value" :title="top.title" :visuals="visuals" :others="others" :toggle="subset" :facts="state.facts.value" :pager="pager"
      :opener="opener" :drills="drillable" :items="menuItems"
      :export-all="top.export !== undefined && host !== undefined ? exportAll : undefined" @drill="onDrill" @range="state.range($event)" @item="onItem"
    >
      <template #context>
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
      </template>
      <template v-if="$slots['lead']" #lead><slot name="lead" /></template>
      <template #tools>
        <template v-if="edits.count.value > 0">
          <UiButton size="sm" variant="ghost" data-testid="record-edits-discard" @click="edits.discard()">Discard</UiButton>
          <UiButton size="sm" variant="primary" icon="check" data-testid="record-edits-review" @click="review">Save {{ edits.count.value }} {{ edits.count.value === 1 ? 'change' : 'changes' }}</UiButton>
        </template>
        <slot name="tools" />
        <span v-if="liveText !== ''" class="live" data-testid="widget-live"><span class="pulse" aria-hidden="true" />{{ liveText }}</span>
      </template>
      <template v-if="canSaveLook" #settings="{ close }">
        <UiButton variant="ghost" icon="check" :loading="savingLook" data-testid="widget-save-look" @click="saveLook(close)">Save to the widget</UiButton>
      </template>
    </ResultView>
    <p v-if="problem !== '' || state.status.value !== ''" class="status" :class="{ bad: problem !== '' }" role="status" data-testid="widget-status">
      {{ problem !== '' ? problem : state.status.value }}
    </p>
    <WidgetActionDialog
      v-model:open="actionsOpen" :offered="state.offered.value" :picked="state.picked.value" :step="state.step.value" :row="state.rowName.value"
      :busy="state.acting.busy.value" :problem="state.acting.problem.value" :lead="lead" @lead="openFromPage" @choose="state.choose($event)" @form="state.submitForm($event)" @run="state.runAction()"
    />
    <DrillDialog v-if="drilling" :key="JSON.stringify(drilling)" :step="drilling" :from="top.title" :view-key="keyed === '' ? '' : `${keyed}>drill`" @close="drilling = undefined" />
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
