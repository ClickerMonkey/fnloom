<script setup lang="ts">
/**
 * A records page's filters (build 8): one pill per filter, each removable, and Filter, which adds one on a column
 * (is, contains, more than, less than a value). The hub applies them; the page keeps them in its URL.
 */
import type { Filter, ResultColumn } from '@harness/core';
import { computed, ref } from 'vue';
import { UiButton, UiIconButton, UiInput, UiSelect, type SelectOption } from '../../ui/index.ts';
import { filterLabel, ID_COLUMN, typedFilter } from '../logic/data.ts';

type Op = 'is' | 'contains' | 'gt' | 'lt';

const props = defineProps<{ columns: readonly ResultColumn[]; filters: readonly Filter[] }>();
const emit = defineEmits<{ change: [filters: Filter[]] }>();

const adding = ref(false);
const fields = computed<SelectOption<string>[]>(() => props.columns.filter((c) => c.name !== ID_COLUMN && c.kind !== 'json' && c.kind !== 'binary').map((c) => ({ value: c.name, label: c.label ?? c.name })));
const field = ref('');
const op = ref<Op>('is');
const value = ref('');
const numeric = computed(() => ['integer', 'number'].includes(props.columns.find((c) => c.name === field.value)?.kind ?? ''));
const OPS = computed<SelectOption<Op>[]>(() => (numeric.value
  ? [{ value: 'is', label: 'is' }, { value: 'gt', label: 'more than' }, { value: 'lt', label: 'less than' }]
  : [{ value: 'is', label: 'is' }, { value: 'contains', label: 'contains' }]));

function start(): void {
  field.value = fields.value[0]?.value ?? '';
  op.value = 'is';
  value.value = '';
  adding.value = true;
}

function add(): void {
  if (field.value === '' || value.value.trim() === '') { return; }
  emit('change', [...props.filters, typedFilter(field.value, op.value, value.value.trim(), numeric.value)]);
  adding.value = false;
}
</script>

<template>
  <div class="filters" data-testid="record-filters">
    <span v-for="(filter, i) in filters" :key="i" class="pill" data-testid="record-filter">
      {{ filterLabel(filter) }}
      <UiIconButton icon="x" :label="`Remove ${filterLabel(filter)}`" size="sm" @click="emit('change', filters.filter((_, at) => at !== i))" />
    </span>
    <UiButton v-if="!adding && fields.length > 0" size="sm" variant="ghost" icon="filter" data-testid="record-filter-add" @click="start">Filter</UiButton>
    <form v-if="adding" class="add" @submit.prevent="add">
      <UiSelect v-model="field" :options="fields" label="Field" hide-label size="sm" />
      <UiSelect v-model="op" :options="OPS" label="How" hide-label size="sm" />
      <UiInput v-model="value" label="Value" hide-label size="sm" placeholder="Value" class="value" data-testid="record-filter-value" />
      <UiButton size="sm" type="submit" variant="primary">Add</UiButton>
      <UiButton size="sm" variant="ghost" @click="adding = false">Cancel</UiButton>
    </form>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); min-width: 0; }
.pill { display: inline-flex; align-items: center; gap: 2px; padding: 0 0 0 var(--space-2); border-radius: var(--radius-full); background: var(--accent-soft); color: var(--text); font-size: var(--text-sm); }
.add { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); min-width: 0; }
.value { min-width: 120px; flex: 1; }
</style>
