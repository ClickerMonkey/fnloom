<script setup lang="ts">
/**
 * The graph's search and filters, over one graph query (`v-model`): words to search names and descriptions, the
 * focused item with how many hops out, and behind "Filters" every filter the hub takes: systems (and which to collapse
 * into one node), node kinds, edge kinds, fn kinds, modes, effects, visibility, live or pending, on or off, and
 * whether references outside the systems show. `scoped` (a system's own graph) leaves out the system pickers.
 */
import type { FnKindName, GraphQuery, SystemName } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { UiButton, UiInput, UiSegmented, UiSwitch } from '../../ui/index.ts';
import { EDGE_KIND_LABELS, effectLabel, FILTER_CHOICES, filterCount, fnKindLabel, NODE_KIND_LABELS, STAGE_LABELS, withPart } from '../logic/graph.ts';
import GraphChips from './GraphChips.vue';

const props = withDefaults(defineProps<{
  /** The systems that may be picked. */
  systems?: readonly SystemName[];
  /** The fn kinds that may be picked. */
  fnKinds?: readonly FnKindName[];
  /** The focused item's name, to show on its chip. */
  focusName?: string;
  scoped?: boolean;
}>(), { systems: () => [], fnKinds: () => [], focusName: '', scoped: false });
const query = defineModel<GraphQuery>({ required: true });

const open = ref(false);
const words = ref(query.value.text ?? '');
let timer: ReturnType<typeof setTimeout> | undefined;
watch(words, (text) => {
  clearTimeout(timer);
  timer = setTimeout(() => { query.value = withPart(query.value, 'text', text.trim() === '' ? undefined : text.trim().slice(0, 200)); }, 300);
});
watch(() => query.value.text, (text) => { if ((text ?? '') !== words.value.trim()) { words.value = text ?? ''; } });
onBeforeUnmount(() => { clearTimeout(timer); });

const count = computed(() => filterCount(query.value));
const nodeOptions = FILTER_CHOICES.nodeKinds.map((kind) => ({ value: kind, label: NODE_KIND_LABELS[kind][0] }));
const edgeOptions = FILTER_CHOICES.edgeKinds.map((kind) => ({ value: kind, label: EDGE_KIND_LABELS[kind] }));
const modeOptions = FILTER_CHOICES.modes.map((value) => ({ value, label: { read: 'Reads', write: 'Writes', delete: 'Deletes' }[value] }));
const visibilityOptions = FILTER_CHOICES.visibility.map((value) => ({ value, label: { user: 'People', llm: 'Models', both: 'Both', none: 'Hidden' }[value] }));
const stageOptions = FILTER_CHOICES.stages.map((value) => ({ value, label: STAGE_LABELS[value] }));
const effectOptions = FILTER_CHOICES.effects.map((value) => ({ value, label: effectLabel(value) }));
const fnKindOptions = computed(() => props.fnKinds.map((value) => ({ value, label: fnKindLabel(value) })));
const systemOptions = computed(() => props.systems.map((name) => ({ value: name, label: name })));

const nodeKinds = computed({ get: () => query.value.nodeKinds ?? [], set: (value) => { query.value = withPart(query.value, 'nodeKinds', [...value]); } });
const edgeKinds = computed({ get: () => query.value.edgeKinds ?? [], set: (value) => { query.value = withPart(query.value, 'edgeKinds', [...value]); } });
const chosenFnKinds = computed({ get: () => query.value.fnKinds ?? [], set: (value) => { query.value = withPart(query.value, 'fnKinds', [...value]); } });
const modes = computed({ get: () => query.value.modes ?? [], set: (value) => { query.value = withPart(query.value, 'modes', [...value]); } });
const effects = computed({ get: () => query.value.effects ?? [], set: (value) => { query.value = withPart(query.value, 'effects', [...value]); } });
const visibility = computed({ get: () => query.value.visibility ?? [], set: (value) => { query.value = withPart(query.value, 'visibility', [...value]); } });
const stages = computed({ get: () => query.value.stages ?? [], set: (value) => { query.value = withPart(query.value, 'stages', [...value]); } });
const systems = computed({ get: () => query.value.systems ?? [], set: (value) => { query.value = withPart(query.value, 'systems', props.systems.filter((name) => value.includes(name))); } });
const collapse = computed({ get: () => query.value.collapse ?? [], set: (value) => { query.value = withPart(query.value, 'collapse', props.systems.filter((name) => value.includes(name))); } });
const on = computed<'all' | 'on' | 'off'>({
  get: () => (query.value.on === undefined ? 'all' : query.value.on ? 'on' : 'off'),
  set: (value) => { query.value = withPart(query.value, 'on', value === 'all' ? undefined : value === 'on'); },
});
const external = computed({ get: () => query.value.external !== false, set: (shown) => { query.value = withPart(query.value, 'external', shown ? undefined : false); } });
const hops = computed<'1' | '2' | '3' | '4'>({
  get: () => (['1', '2', '3', '4'] as const)[(query.value.focus?.hops ?? 1) - 1] ?? '1',
  set: (value) => { const focus = query.value.focus; if (focus !== undefined) { query.value = { ...query.value, focus: { node: focus.node, hops: Number(value) } }; } },
});

function unfocus(): void {
  query.value = withPart(query.value, 'focus', undefined);
}

function clear(): void {
  const keep: GraphQuery = {};
  if (props.scoped && query.value.systems !== undefined) { keep.systems = query.value.systems; }
  query.value = keep;
  words.value = '';
}
</script>

<template>
  <div class="filters" data-testid="graph-filters">
    <div class="bar">
      <UiInput v-model="words" class="words" icon="search" type="search" placeholder="Search names and descriptions" label="Search the graph" hide-label clearable size="sm" data-testid="graph-search" />
      <div v-if="query.focus" class="focus" data-testid="graph-focus-chip">
        <span class="focus-name" :title="focusName || query.focus.node">Around {{ focusName || query.focus.node }}</span>
        <UiSegmented v-model="hops" label="Hops out" :options="[{ value: '1', label: '1 hop' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }]" />
        <UiButton size="sm" variant="ghost" icon="x" @click="unfocus">Everything</UiButton>
      </div>
      <UiButton size="sm" icon="filter" :variant="open ? 'secondary' : 'ghost'" :aria-expanded="open" data-testid="graph-filters-toggle" @click="open = !open">
        Filters{{ count > 0 ? ` (${count})` : '' }}
      </UiButton>
      <UiButton v-if="count > 0 || query.text || query.focus" size="sm" variant="ghost" @click="clear">Clear</UiButton>
    </div>
    <div v-if="open" class="panel" data-testid="graph-filter-panel">
      <template v-if="!scoped && props.systems.length > 0">
        <GraphChips v-model="systems" label="Only systems" :options="systemOptions" testid="graph-filter-systems" />
        <GraphChips v-model="collapse" label="Collapse into one node" :options="systemOptions" />
      </template>
      <GraphChips v-model="nodeKinds" label="Items" :options="nodeOptions" testid="graph-filter-nodes" />
      <GraphChips v-model="edgeKinds" label="Links" :options="edgeOptions" testid="graph-filter-edges" />
      <GraphChips v-if="fnKindOptions.length > 0" v-model="chosenFnKinds" label="Fn kinds" :options="fnKindOptions" />
      <GraphChips v-model="modes" label="Modes" :options="modeOptions" />
      <GraphChips v-model="effects" label="Effects on" :options="effectOptions" />
      <GraphChips v-model="visibility" label="Visible to" :options="visibilityOptions" />
      <GraphChips v-model="stages" label="Stage" :options="stageOptions" />
      <div class="row">
        <UiSegmented v-model="on" label="On or off" :options="[{ value: 'all', label: 'On and off' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]" />
        <UiSwitch v-model="external" label="Show references outside" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.filters { display: grid; gap: var(--space-2); min-width: 0; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); min-width: 0; }
.words { flex: 1 1 220px; min-width: 0; }
.focus { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); min-width: 0; }
.focus-name { font-size: var(--text-sm); font-family: var(--mono); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel { display: grid; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4); }
</style>
