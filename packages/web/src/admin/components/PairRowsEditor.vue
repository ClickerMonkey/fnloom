<script setup lang="ts">
/**
 * Names and values as rows (headers, environment values): each row a name and a value, a row added at the end and
 * any removed. `secret` draws the values as passwords; `namesOnly` asks only for names (each person types the values
 * on the connections page); `kept` says the hub keeps the values, which stay hidden until the admin replaces them.
 */
import { UiButton, UiIconButton, UiInput } from '../../ui/index.ts';
import type { PairRow } from '../logic/remote-config.ts';

const props = withDefaults(defineProps<{
  label: string;
  hint?: string;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  secret?: boolean;
  namesOnly?: boolean;
  kept?: boolean;
  error?: string;
  testid?: string;
}>(), { hint: '', namePlaceholder: 'Name', valuePlaceholder: 'Value', secret: false, namesOnly: false, kept: false, error: '', testid: 'pair-rows' });
const rows = defineModel<readonly PairRow[]>('rows', { required: true });
const emit = defineEmits<{ replace: [] }>();

function change(index: number, part: keyof PairRow, text: string): void {
  rows.value = rows.value.map((row, i) => (i === index ? { ...row, [part]: text } : row));
}
function add(): void {
  rows.value = [...rows.value, { name: '', value: '' }];
}
function remove(index: number): void {
  rows.value = rows.value.filter((_, i) => i !== index);
}
const hideValues = (): boolean => props.namesOnly || props.kept;
</script>

<template>
  <fieldset class="pairs" :data-testid="testid">
    <legend class="label">{{ label }}</legend>
    <p v-if="kept" class="kept" data-testid="pairs-kept">
      <span>The values are kept sealed{{ rows.length > 0 ? ` for ${rows.map((r) => r.name).join(', ')}` : '' }}.</span>
      <UiButton size="sm" variant="ghost" icon="edit" @click="emit('replace')">Replace</UiButton>
    </p>
    <template v-if="!kept">
      <div v-for="(row, index) in rows" :key="index" class="row" :class="{ single: hideValues() }">
        <UiInput :model-value="row.name" :label="`${label}: name ${index + 1}`" hide-label size="sm" :placeholder="namePlaceholder" @update:model-value="change(index, 'name', $event)" />
        <UiInput
          v-if="!hideValues()" :model-value="row.value" :label="`${label}: value ${index + 1}`" hide-label size="sm" :placeholder="valuePlaceholder"
          :type="secret ? 'password' : 'text'" :revealable="secret" @update:model-value="change(index, 'value', $event)"
        />
        <UiIconButton icon="x" size="sm" :label="`Remove ${row.name || 'this row'}`" @click="remove(index)" />
      </div>
      <UiButton class="add" size="sm" variant="ghost" icon="plus" @click="add">Add</UiButton>
    </template>
    <p v-if="error !== ''" class="error" role="alert">{{ error }}</p>
    <p v-else-if="hint !== ''" class="hint">{{ hint }}</p>
  </fieldset>
</template>

<style scoped>
.pairs { display: grid; gap: var(--space-2); min-width: 0; margin: 0; padding: 0; border: 0; }
.label { padding: 0; margin-bottom: var(--space-1); font-size: var(--text-sm); font-weight: var(--weight-medium); }
.row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) auto; gap: var(--space-2); align-items: center; }
.row.single { grid-template-columns: minmax(0, 1fr) auto; }
.add { justify-self: start; }
.kept { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.hint { margin: 0; color: var(--text-faint); font-size: var(--text-xs); }
.error { margin: 0; color: var(--danger); font-size: var(--text-xs); }
@media (max-width: 479.98px) {
  .row { grid-template-columns: minmax(0, 1fr) auto; }
  .row > :nth-child(2) { grid-column: 1; }
  .row > :last-child { grid-row: 1; grid-column: 2; }
}
</style>
