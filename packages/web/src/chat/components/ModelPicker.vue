<script setup lang="ts">
/**
 * The model picker: search the hub's chat models by name ("free" and ability words filter), narrow by filter chips
 * (free, tools, vision, reasoning), sort by name, price or context, and pick one, or go back to the agent's own
 * choice. Each row shows the model's provider, price, context size and abilities. Picking emits; the chat saves it.
 * The admin's model role editor uses it too, over the models able to do the role and without the agent's-choice row.
 */
import { computed, ref } from 'vue';
import { UiBadge, UiIcon, UiInput, UiSegmented, type SegmentOption } from '../../ui/index.ts';
import {
  abilities, contextText, FILTER_LOOK, findModels, MODEL_FILTERS, MODEL_SORTS, priceText, SORT_LOOK, isFree, type ChatModel, type ModelFilter, type ModelSort,
} from '../logic/models.ts';
import type { ModelPick } from '../logic/session.ts';

const props = withDefaults(defineProps<{
  models: readonly ChatModel[];
  /** The chat's choice now. */
  current: ModelPick;
  /** How many rows show before the picker asks for a narrower search. */
  limit?: number;
  /** Whether the first row offers the agent's own choice ('default'). */
  ownChoice?: boolean;
  /** A height the list scrolls within (a dialog); '' lets it grow with its rows (a panel that scrolls). */
  listHeight?: string;
}>(), { limit: 150, ownChoice: true, listHeight: '' });
const emit = defineEmits<{ pick: [pick: ModelPick] }>();

const text = ref('');
const filters = ref<ReadonlySet<ModelFilter>>(new Set());
const sort = ref<ModelSort>('name');
const SORTS: readonly SegmentOption<ModelSort>[] = MODEL_SORTS.map((value) => ({ value, label: SORT_LOOK[value].label }));

const found = computed(() => findModels(props.models, { text: text.value, filters: filters.value, sort: sort.value }));
const shown = computed(() => found.value.slice(0, props.limit));

function toggle(filter: ModelFilter): void {
  const next = new Set(filters.value);
  if (!next.delete(filter)) { next.add(filter); }
  filters.value = next;
}

const pickOf = (model: ChatModel): ModelPick => `model:${model.id}`;
</script>

<template>
  <div class="picker" data-testid="model-picker">
    <UiInput v-model="text" type="search" label="Search models" hide-label placeholder="Search models — try “free” or “vision”" icon="search" clearable autofocus data-testid="model-search" />
    <div class="controls">
      <div class="filters" role="group" aria-label="Filters">
        <button
          v-for="filter in MODEL_FILTERS" :key="filter" type="button" class="chip" :class="{ on: filters.has(filter) }" :aria-pressed="filters.has(filter)"
          :data-filter="filter" @click="toggle(filter)"
        >
          {{ FILTER_LOOK[filter].label }}
        </button>
      </div>
      <UiSegmented v-model="sort" :options="SORTS" label="Sort by" data-testid="model-sort" />
    </div>
    <ul class="list" :class="{ scrolls: listHeight !== '' }" :style="listHeight === '' ? undefined : { maxHeight: listHeight }" role="listbox" aria-label="Models">
      <li v-if="ownChoice">
        <button type="button" class="row" role="option" :aria-selected="current === 'default'" data-model="default" @click="emit('pick', 'default')">
          <span class="main">
            <span class="name">The agent’s own choice</span>
            <span class="facts">The agent picks a model for each answer.</span>
          </span>
          <UiIcon v-if="current === 'default'" class="check" name="check" :size="16" />
        </button>
      </li>
      <li v-for="model in shown" :key="`${model.provider}/${model.id}`">
        <button type="button" class="row" role="option" :aria-selected="current === pickOf(model)" :data-model="model.id" @click="emit('pick', pickOf(model))">
          <span class="main">
            <span class="name">{{ model.name }}</span>
            <span class="facts">
              <span>{{ model.provider }} · </span>
              <span :class="{ free: isFree(model) }">{{ priceText(model) }}</span>
              <span v-if="contextText(model) !== ''"> · {{ contextText(model) }}</span>
            </span>
            <span v-if="abilities(model).length > 0" class="badges">
              <UiBadge v-for="ability in abilities(model)" :key="ability">{{ ability }}</UiBadge>
            </span>
          </span>
          <UiIcon v-if="current === pickOf(model)" class="check" name="check" :size="16" />
        </button>
      </li>
    </ul>
    <p class="dim" data-testid="model-count">
      <template v-if="found.length === 0">No models match. Try fewer words or filters.</template>
      <template v-else-if="found.length > shown.length">Showing {{ shown.length }} of {{ found.length }}. Search to narrow it down.</template>
      <template v-else>{{ found.length }} model{{ found.length === 1 ? '' : 's' }}</template>
    </p>
  </div>
</template>

<style scoped>
.picker { display: grid; gap: var(--space-3); min-width: 0; }
.controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.chip {
  height: 28px; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-full); background: var(--surface);
  color: var(--text-dim); font-size: var(--text-sm); line-height: 1.25; transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease), border-color var(--fast) var(--ease);
}
.chip:hover { background: var(--surface-2); color: var(--text); }
.chip.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.chip:focus-visible { outline: none; box-shadow: var(--ring); }
.list { display: grid; align-content: start; gap: 2px; margin: 0; padding: 0; list-style: none; }
.list.scrolls { overflow-y: auto; padding: 2px; border: 1px solid var(--border); border-radius: var(--radius); }
.row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); width: 100%; padding: var(--space-2) var(--space-3);
  border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--text); text-align: left;
  transition: background-color var(--fast) var(--ease), border-color var(--fast) var(--ease);
}
.row:hover { background: var(--surface-2); }
.row[aria-selected='true'] { border-color: var(--accent-soft-strong); background: var(--accent-soft); }
.row:focus-visible { outline: none; box-shadow: var(--ring); }
.main { display: grid; gap: 2px; min-width: 0; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-medium); }
.facts { color: var(--text-faint); font-size: var(--text-sm); }
.free { color: var(--ok); font-weight: var(--weight-medium); }
.badges { display: flex; flex-wrap: wrap; gap: var(--space-1); padding-top: 2px; }
.check { color: var(--accent); }
.dim { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
</style>
