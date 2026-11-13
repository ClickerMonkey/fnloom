<script setup lang="ts">
/**
 * A widget's result (build 8): its title, the visuals it keeps (in its order, the table last) drawn with their column
 * bindings, a line for any binding that no longer fits, its controls (a form over the widget's args, applied as a new
 * run), Refresh, and a button on each row that offers the actions of the row's type: a form for args left after
 * binding, a confirm for anything that is not a read, and nothing runs until a person clicks. Without a widget host
 * (a page that can't run fns) it draws read-only.
 */
import { HUB_VISUALS, QualifiedName, type Json, type WidgetActionOption, type WidgetResult } from '@harness/core';
import { computed, inject, onMounted, ref, watch } from 'vue';
import GinForm from '../../gin/GinForm.vue';
import { UiBanner, UiButton, UiDialog, UiIconButton } from '../../ui/index.ts';
import { OWN_HOST, RESULTS_HOST } from '../results/builtin.ts';
import ResultView from '../results/ResultView.vue';
import type { RowOpener } from '../results/visuals.ts';
import { WidgetState } from './widget-state.ts';
import { boundTable, confirmText, offeredVisuals, WIDGET_HOST } from './widgets.ts';

const props = withDefaults(defineProps<{
  result: WidgetResult;
  /** The widget fn that made it, and the args it ran with (its controls' values). */
  fn?: QualifiedName | undefined;
  args?: Json | undefined;
  /** Where the visual picked is kept (a message part's key); empty keeps it only while mounted. */
  viewKey?: string;
  /** Show its title (off where the frame around it already names it, a run card). */
  showTitle?: boolean;
}>(), { fn: undefined, args: undefined, viewKey: '', showTitle: true });

const results = inject(RESULTS_HOST, OWN_HOST);
const host = inject(WIDGET_HOST, undefined);
const registry = QualifiedName.parse(HUB_VISUALS);
const state = host === undefined ? undefined : new WidgetState(host, () => ({ fn: props.fn, args: props.args }));

const local = ref<string | undefined>(undefined);
const choice = computed({
  get: () => (props.viewKey === '' ? local.value : results.choice(props.viewKey)),
  set: (name: string | undefined) => {
    if (name === undefined) { return; }
    if (props.viewKey === '') { local.value = name; } else { results.choose(props.viewKey, name); }
  },
});
const visuals = computed(() => offeredVisuals((table) => results.visuals(registry, table), props.result.table, props.result.visuals));
const shownName = computed(() => visuals.value.find((v) => v.visual.name === choice.value)?.visual.name ?? visuals.value[0]?.visual.name);
const drawn = computed(() => boundTable(props.result.table, props.result.visuals.find((v) => v.visual === shownName.value)));

/** The widget's controls: a form over its args, when the page knows their type and there are any. */
const controlsType = computed(() => (props.fn === undefined ? undefined : host?.argsType(props.fn)));
const controlsOpen = ref(false);

const rows = computed((): RowOpener | undefined => {
  if (state === undefined || (state.options.value.value ?? []).length === 0) { return undefined; }
  return {
    label: 'Actions',
    has: (row) => state.hasActions(props.result.table, drawn.value.original(row)),
    open: (row) => { state.openRow(props.result.table, drawn.value.original(row)); },
  };
});

onMounted(() => { void results.prepare(registry); });
watch(() => props.result.table, (table) => { void state?.load(table); }, { immediate: true });

async function pick(option: WidgetActionOption): Promise<void> {
  if (state === undefined) { return; }
  state.choose(option);
  if (state.runsAtOnce) { await state.run(props.result.table); }
}

async function apply(args: Json): Promise<void> {
  if (await state?.apply(args) === true) { controlsOpen.value = false; }
}

const dialogTitle = computed(() => state?.picked.value?.label ?? 'Actions');
</script>

<template>
  <section class="widget" data-testid="widget-view" :data-widget="fn">
    <h3 v-if="showTitle" class="title">{{ result.title }}</h3>
    <div v-if="controlsOpen && controlsType !== undefined" class="controls" data-testid="widget-controls">
      <GinForm :type="controlsType" :initial="args" submit-label="Apply" :busy="state?.running.busy.value ?? false" @submit="apply" @cancel="controlsOpen = false" />
    </div>
    <UiBanner v-if="result.problems.length > 0" tone="warn" data-testid="widget-problems">
      {{ result.problems.length === 1 ? result.problems[0] : `${result.problems.length} views no longer fit:` }}
      <ul v-if="result.problems.length > 1" class="problems"><li v-for="problem in result.problems" :key="problem">{{ problem }}</li></ul>
    </UiBanner>
    <ResultView v-model:choice="choice" :table="drawn.table" :title="result.title" :visuals="visuals" :opener="rows">
      <template #tools>
        <UiIconButton v-if="controlsType !== undefined" icon="filter" label="Controls" size="sm" :aria-expanded="controlsOpen" data-testid="widget-controls-toggle" @click="controlsOpen = !controlsOpen" />
        <UiIconButton v-if="state && fn" icon="refresh" label="Refresh" size="sm" data-testid="widget-refresh" @click="state.refresh()" />
      </template>
    </ResultView>
    <UiDialog v-if="state" v-model:open="state.open.value" :title="dialogTitle" width="420px">
      <div class="action" data-testid="widget-action">
        <ul v-if="state.step.value === 'choose'" class="choices">
          <li v-for="option in state.offered.value" :key="option.fn">
            <button type="button" class="choice" :data-fn="option.fn" data-testid="widget-action-choice" @click="pick(option)">
              <span>{{ option.label }}</span>
              <span v-if="option.mode !== 'read'" class="mode">{{ option.mode }}</span>
            </button>
          </li>
        </ul>
        <GinForm
          v-else-if="state.step.value === 'form' && state.picked.value?.form" :type="state.picked.value.form" :submit-label="state.picked.value.label"
          :busy="state.running.busy.value" @submit="state.run(result.table, $event)" @cancel="state.close()"
        />
        <p v-else class="confirm" data-testid="widget-action-confirm">{{ state.picked.value ? confirmText(state.picked.value) : '' }}</p>
        <p v-if="state.running.problem.value !== ''" class="problem">{{ state.running.problem.value }}</p>
      </div>
      <template v-if="state.step.value === 'confirm'" #footer>
        <UiButton variant="ghost" @click="state.close()">Cancel</UiButton>
        <UiButton
          :variant="state.picked.value?.mode === 'delete' ? 'danger' : 'primary'" :loading="state.running.busy.value" data-testid="widget-action-run"
          @click="state.run(result.table)"
        >
          {{ state.picked.value?.label }}
        </UiButton>
      </template>
    </UiDialog>
  </section>
</template>

<style scoped>
.widget { display: grid; gap: var(--space-2); min-width: 0; }
.title { min-width: 0; margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.controls { padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
.problems { margin: var(--space-1) 0 0; padding-left: var(--space-4); }
.action { display: grid; gap: var(--space-3); }
.choices { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.choice {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); width: 100%; min-height: 40px; padding: 0 var(--space-3);
  border: 0; border-radius: var(--radius); background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer;
}
.choice:hover { background: var(--surface-2); }
.choice:focus-visible { outline: none; box-shadow: inset var(--ring); }
.mode { color: var(--text-faint); font-size: var(--text-xs); }
.confirm { margin: 0; color: var(--text-dim); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
</style>
