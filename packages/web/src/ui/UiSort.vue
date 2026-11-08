<script setup lang="ts">
/**
 * The sort button beside a search box, always saying how the list is sorted ("Started, newest first"). Its menu lists
 * every sortable field; picking the current one turns its direction round, another starts in its natural direction.
 * With no sort of its own the list's default applies and is shown.
 */
import type { Sort } from '@harness/core';
import { computed } from 'vue';
import UiIcon from './UiIcon.vue';
import UiMenu from './UiMenu.vue';
import { sortText, withSort, type SearchFields } from './search.ts';
import type { MenuItem } from './types.ts';

const props = defineProps<{
  fields: SearchFields;
  /** The sort the list gets with none chosen. */
  defaultSort: readonly Sort[];
}>();
const model = defineModel<readonly Sort[] | undefined>({ required: true });

const applied = computed(() => (model.value !== undefined && model.value.length > 0 ? model.value : props.defaultSort));
const current = computed(() => applied.value[0]);
const items = computed<MenuItem<string>[]>(() => Object.entries(props.fields).filter(([, decl]) => decl.sortable).map(([key, decl]) => ({
  value: key,
  label: decl.label,
  ...(current.value?.field === key ? { icon: current.value.dir === 'asc' ? 'chevron-up' : 'chevron-down', hint: 'reverse' } : {}),
})));
const words = computed(() => (current.value === undefined ? 'Sort' : sortText(props.fields, current.value)));

function pick(field: string): void {
  const next = withSort(props.fields, applied.value, field);
  const same = JSON.stringify(next) === JSON.stringify(props.defaultSort);
  model.value = same ? undefined : next;
}
</script>

<template>
  <UiMenu :items="items" label="Sort by" @select="pick">
    <template #trigger="{ toggle, attrs }">
      <button type="button" class="ui-sort" v-bind="attrs" :aria-label="`Sorted by ${words}. Change the sort`" :title="`Sorted by ${words}`" data-testid="sort" @click="toggle">
        <UiIcon name="sort" :size="16" class="icon" />
        <span class="words">{{ words }}</span>
      </button>
    </template>
  </UiMenu>
</template>

<style scoped>
.ui-sort {
  display: inline-flex; align-items: center; gap: var(--space-2); max-width: 100%; height: var(--control); padding: 0 var(--space-3);
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text-dim); font: inherit; font-size: var(--text-sm); white-space: nowrap;
}
.ui-sort:hover { border-color: var(--text-faint); color: var(--text); }
.ui-sort:focus-visible { outline: none; box-shadow: var(--ring); }
.icon { flex: none; }
.words { overflow: hidden; text-overflow: ellipsis; }
</style>
