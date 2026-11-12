<script setup lang="ts">
/**
 * The search bar every searchable list has, the one layout standard: the search box (pills, suggestions, the filter
 * menu) taking the row, the sort button beside it always saying the sort, then whatever the page adds (a layout
 * switch), and the count at the right. No card around it. When the bar is narrow (a phone, a side panel) the box takes
 * its own row and the sort, the page's additions and the count (at the row's end) share the row under it. A session filter's pill shows
 * the chat's title, not its id. Mounted outside the app (no stores) it still searches, without the data's values and
 * names. The query is `v-model` (the page keeps it in the URL with `useListQuery`). When the hub's answer is `partial`
 * (it stopped at its scan bound), the count reads as a lower bound and a line under the bar says to narrow the filters.
 */
import { LIST_FIELDS, type ListName, type Sort } from '@harness/core';
import { computed, ref } from 'vue';
import { fieldsOf, formatFigure, valuesOf } from '../../state/query.ts';
import { useStoresIfAny } from '../../state/stores.ts';
import UiIcon from '../../ui/UiIcon.vue';
import UiSearch from '../../ui/UiSearch.vue';
import UiSort from '../../ui/UiSort.vue';
import type { SearchQuery, ValueNamer, ValueOption } from '../../ui/search.ts';

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
  /** The hub stopped reading at its scan bound: more rows may match than it found. */
  partial?: boolean;
}>(), { placeholder: undefined, count: undefined, more: false, noSort: false, partial: false });
const model = defineModel<SearchQuery>({ required: true });
defineSlots<{ default?: () => unknown }>();
const box = ref<{ focus: () => void } | null>(null);
defineExpose({ focus: () => { box.value?.focus(); } });

const chat = useStoresIfAny()?.chat;
const fields = computed(() => fieldsOf(props.list));
const defaultSort = computed<readonly Sort[]>(() => LIST_FIELDS[props.list].defaultSort);
const name: ValueNamer = (field, value) => (field === 'session' && typeof value === 'string' ? chat?.titleOf(value) : undefined);
const values = computed(() => {
  if (chat === undefined) { return undefined; }
  const read = valuesOf(chat.listValues, props.list);
  return async (field: string, prefix: string): Promise<readonly ValueOption[]> =>
    (await read(field, prefix)).map((option) => ({ ...option, label: option.label ?? name(field, option.value) }));
});
const sort = computed({
  get: () => model.value.sort,
  set: (next: readonly Sort[] | undefined) => {
    const { sort: _old, ...rest } = model.value;
    model.value = next === undefined ? rest : { ...rest, sort: [...next] };
  },
});
const countText = computed(() => (props.count === undefined ? '' : `${props.count.toLocaleString()}${props.more || props.partial ? '+' : ''}`));
</script>

<template>
  <div class="list-search" data-testid="list-search">
    <UiSearch ref="box" v-model="model" :fields="fields" :label="`Search ${label}`" :format="formatFigure" :values="values" :name="name" v-bind="placeholder === undefined ? {} : { placeholder }" />
    <div class="side">
      <UiSort v-if="!noSort" v-model="sort" :fields="fields" :default-sort="defaultSort" />
      <div v-if="$slots['default']" class="extra"><slot /></div>
      <span v-if="countText" class="count" :aria-label="`${countText} ${label}`" data-testid="list-count">{{ countText }}</span>
    </div>
    <p v-if="partial" class="partial" role="status" data-testid="list-partial">
      <UiIcon name="info" :size="14" />More rows than scanned; narrow the filters.
    </p>
  </div>
</template>

<style scoped>
.list-search { display: flex; align-items: flex-start; flex-wrap: wrap; gap: var(--space-2); min-width: 0; container-type: inline-size; }
.side { display: flex; align-items: center; gap: var(--space-2); flex: 0 1 auto; min-width: 0; min-height: var(--control); margin-left: auto; }
.side :deep(.ui-menu-trigger) { min-width: 0; }
/* the page's additions stand as tall as the sort and in its type size, so the row's controls match */
.extra { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); min-width: 0; }
.extra > :deep(*) { height: var(--control); font-size: var(--text-sm); }
/* narrow: the box takes the row; under it one row holds the sort, the page's additions and the count, side by side */
@container (max-width: 559px) {
  .list-search > :first-child { flex-basis: 100%; }
  .side { flex: 1 1 100%; margin-left: 0; }
  .count { min-width: 0; text-align: left; }
}
.partial { display: flex; flex-basis: 100%; align-items: center; gap: var(--space-1); margin: 0; color: var(--text-dim); font-size: var(--text-xs); }
.count { min-width: 2ch; color: var(--text-faint); font-size: var(--text-sm); font-variant-numeric: tabular-nums; text-align: right; }
</style>
