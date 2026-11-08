<script setup lang="ts">
/**
 * The search bar every searchable list has, the one layout standard: the search box (pills, suggestions, the filter
 * menu) taking the row, the sort button beside it always saying the sort, then whatever the page adds (a layout
 * switch), and the count at the right. No card around it. On a phone the box takes its own row and the rest wraps
 * under it. The query is `v-model` (the page keeps it in the URL with `useListQuery`).
 */
import { LIST_FIELDS, type ListName, type Sort } from '@harness/core';
import { computed } from 'vue';
import { fieldsOf, formatFigure, valuesOf } from '../../state/query.ts';
import { useStores } from '../../state/stores.ts';
import UiSearch from '../../ui/UiSearch.vue';
import UiSort from '../../ui/UiSort.vue';
import type { SearchQuery } from '../../ui/search.ts';

const props = withDefaults(defineProps<{
  list: ListName;
  /** What the list holds, for the box's name ("runs"). */
  label: string;
  placeholder?: string | undefined;
  /** How many rows are shown, and whether more are to come; no count when left out. */
  count?: number | undefined;
  more?: boolean;
  /** Leave the sort button out (a list sorted only one way). */
  noSort?: boolean;
}>(), { placeholder: undefined, count: undefined, more: false, noSort: false });
const model = defineModel<SearchQuery>({ required: true });
defineSlots<{ default?: () => unknown }>();

const { chat } = useStores();
const fields = computed(() => fieldsOf(props.list));
const defaultSort = computed<readonly Sort[]>(() => LIST_FIELDS[props.list].defaultSort);
const values = computed(() => valuesOf(chat.listValues, props.list));
const sort = computed({
  get: () => model.value.sort,
  set: (next: readonly Sort[] | undefined) => {
    const { sort: _old, ...rest } = model.value;
    model.value = next === undefined ? rest : { ...rest, sort: [...next] };
  },
});
const countText = computed(() => (props.count === undefined ? '' : `${props.count.toLocaleString()}${props.more ? '+' : ''}`));
</script>

<template>
  <div class="list-search" data-testid="list-search">
    <UiSearch v-model="model" :fields="fields" :label="`Search ${label}`" :format="formatFigure" :values="values" v-bind="placeholder === undefined ? {} : { placeholder }" />
    <div class="side">
      <UiSort v-if="!noSort" v-model="sort" :fields="fields" :default-sort="defaultSort" />
      <slot />
      <span v-if="countText" class="count" :aria-label="`${countText} ${label}`" data-testid="list-count">{{ countText }}</span>
    </div>
  </div>
</template>

<style scoped>
.list-search { display: flex; align-items: flex-start; flex-wrap: wrap; gap: var(--space-2); min-width: 0; }
.side { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); min-height: var(--control); margin-left: auto; }
.count { min-width: 2ch; color: var(--text-faint); font-size: var(--text-sm); font-variant-numeric: tabular-nums; text-align: right; }
</style>
