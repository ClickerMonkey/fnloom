<script setup lang="ts">
/**
 * The search box's filter menu: every filterable field, then the chosen field's operators and its value (choices for
 * a field with known values, a number, a date, yes or no, or words), then Add. Opened on a pill, it starts on that
 * pill's field, operator and values and replaces it.
 */
import { OP_LABELS, type Filter, type FilterOp } from '@harness/core';
import { computed, ref, watch } from 'vue';
import UiButton from './UiButton.vue';
import UiIcon from './UiIcon.vue';
import { arityOf, buildFilter, filterValues, opsOf, valueLabel, writeDate, type NumberFormat, type SearchFields, type ValueOption } from './search.ts';

const props = defineProps<{
  fields: SearchFields;
  format: NumberFormat;
  /** A field's values from the data, for fields whose values aren't fixed. */
  values?: ((field: string, prefix: string) => Promise<readonly ValueOption[]>) | undefined;
  /** The filter being changed, if any. */
  editing?: Filter | undefined;
  /** The field a new filter starts on (a field suggestion picked while typing). */
  start?: string | undefined;
}>();
const emit = defineEmits<{ apply: [filter: Filter]; cancel: [] }>();

const filterable = computed(() => Object.entries(props.fields).filter(([, decl]) => decl.filterable));
const field = ref<string | undefined>(props.editing?.field ?? props.start);
const decl = computed(() => (field.value === undefined ? undefined : props.fields[field.value]));
const op = ref<FilterOp | undefined>(props.editing?.op);
/** The typed values: one per box (`one`, `two`), or the picked choices (`many`). */
const typed = ref<string[]>([]);
const options = ref<readonly ValueOption[]>([]);

/** A value as its box holds it (dates as days, so the date input can show them). */
function boxValue(value: string | number | boolean): string {
  if (typeof value === 'number' && decl.value?.type === 'date') { return writeDate(value).slice(0, 10); }
  return String(value);
}

watch(() => props.editing, (filter) => {
  field.value = filter?.field ?? props.start;
  op.value = filter?.op;
  typed.value = filter === undefined ? [] : filterValues(filter).map(boxValue);
}, { immediate: true });

watch(field, async (key, before) => {
  if (key !== before && before !== undefined) { typed.value = []; }
  const d = key === undefined ? undefined : props.fields[key];
  if (d !== undefined && (op.value === undefined || !opsOf(d).includes(op.value))) { op.value = opsOf(d)[0]; }
  options.value = d?.values?.map((value) => ({ value })) ?? (d?.type === 'boolean' ? [{ value: true }, { value: false }] : []);
  if (key !== undefined && d?.dynamic === true && props.values !== undefined) {
    const got = await props.values(key, '').catch(() => []);
    if (field.value === key) { options.value = got; }
  }
}, { immediate: true });

const arity = computed(() => (op.value === undefined ? 'none' : arityOf(op.value)));
const choices = computed(() => options.value.length > 0 && decl.value !== undefined && (decl.value.type === 'enum' || decl.value.type === 'boolean'));
const inputType = computed(() => (decl.value?.type === 'date' ? 'date' : 'text'));
const placeholder = computed(() => {
  switch (decl.value?.unit) {
    case 'usd': return '0.01';
    case 'ms': return '2s, 500ms';
    case 'bytes': return '1kb, 2mb';
    case 'tokens': case 'count': return '1000, 12k';
    case undefined: return 'Value';
  }
});
const filter = computed(() => (decl.value === undefined || field.value === undefined || op.value === undefined ? undefined : buildFilter(decl.value, field.value, op.value, typed.value)));

function pick(value: string | number | boolean): void {
  const key = String(value);
  if (arity.value === 'many') {
    typed.value = typed.value.includes(key) ? typed.value.filter((v) => v !== key) : [...typed.value, key];
  } else {
    typed.value = [key];
  }
}
function setBox(at: number, event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) { return; }
  const next = [...typed.value];
  next[at] = event.target.value;
  typed.value = next;
}
function setMany(event: Event): void {
  if (event.target instanceof HTMLInputElement) { typed.value = event.target.value.split(',').map((v) => v.trim()).filter((v) => v !== ''); }
}
function apply(): void {
  if (filter.value !== undefined) { emit('apply', filter.value); }
}
</script>

<template>
  <div class="filter-menu" data-testid="filter-menu">
    <div v-if="decl === undefined" class="fields" role="list" aria-label="Fields">
      <button v-for="[key, d] in filterable" :key="key" type="button" class="field" role="listitem" :data-field="key" @click="field = key">
        <span>{{ d.label }}</span><UiIcon name="chevron-right" :size="14" class="faint" />
      </button>
    </div>
    <form v-else class="edit" @submit.prevent="apply">
      <header class="head">
        <button v-if="editing === undefined" type="button" class="back" aria-label="Other fields" @click="field = undefined"><UiIcon name="chevron-left" :size="14" /></button>
        <strong>{{ decl.label }}</strong>
      </header>
      <div class="ops" role="radiogroup" aria-label="Operator">
        <button
          v-for="o in opsOf(decl)" :key="o" type="button" role="radio" class="op" :aria-checked="op === o ? 'true' : 'false'" :data-op="o" @click="op = o"
        >
          {{ OP_LABELS[o] }}
        </button>
      </div>
      <div v-if="arity !== 'none'" class="value">
        <div v-if="choices" class="choices" :role="arity === 'many' ? 'group' : 'radiogroup'" aria-label="Value">
          <button
            v-for="option in options" :key="String(option.value)" type="button" class="choice" :role="arity === 'many' ? 'checkbox' : 'radio'"
            :aria-checked="typed.includes(String(option.value)) ? 'true' : 'false'" @click="pick(option.value)"
          >
            <UiIcon :name="typed.includes(String(option.value)) ? 'check' : 'dot'" :size="12" class="mark" />
            <span class="choice-label">{{ option.label ?? valueLabel(decl, option.value, format) }}</span>
            <span v-if="option.count !== undefined" class="count">{{ option.count }}</span>
          </button>
        </div>
        <input v-else-if="arity === 'many'" class="box" :value="typed.join(', ')" placeholder="a, b, c" aria-label="Values, separated by commas" @input="setMany" />
        <div v-else class="boxes">
          <input class="box" :type="inputType" :value="typed[0] ?? ''" :placeholder="placeholder" :aria-label="arity === 'two' ? 'From' : 'Value'" @input="setBox(0, $event)" />
          <template v-if="arity === 'two'">
            <span class="faint">and</span>
            <input class="box" :type="inputType" :value="typed[1] ?? ''" :placeholder="placeholder" aria-label="To" @input="setBox(1, $event)" />
          </template>
        </div>
      </div>
      <footer class="foot">
        <UiButton size="sm" variant="ghost" @click="emit('cancel')">Cancel</UiButton>
        <UiButton size="sm" variant="primary" type="submit" :disabled="filter === undefined" data-testid="filter-apply">{{ editing ? 'Change' : 'Add filter' }}</UiButton>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.filter-menu { display: grid; min-width: 240px; max-width: 340px; padding: var(--space-1); }
.fields { display: grid; max-height: 320px; overflow: auto; }
.field, .choice {
  display: flex; align-items: center; gap: var(--space-2); min-height: 32px; padding: 0 var(--space-2); border: 0; border-radius: var(--radius-sm);
  background: transparent; color: var(--text); text-align: left; font-size: var(--text-sm);
}
.field { justify-content: space-between; }
.field:hover, .field:focus-visible, .choice:hover, .choice:focus-visible { background: var(--surface-2); outline: none; }
.edit { display: grid; gap: var(--space-2); padding: var(--space-1); }
.head { display: flex; align-items: center; gap: var(--space-1); font-size: var(--text-sm); }
.back { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: var(--radius-sm); background: none; color: var(--text-dim); }
.back:hover { background: var(--surface-2); }
.ops { display: flex; flex-wrap: wrap; gap: 4px; }
.op {
  padding: 2px 8px; border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface); color: var(--text-dim);
  font-size: var(--text-xs); white-space: nowrap;
}
.op[aria-checked='true'] { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
.choices { display: grid; max-height: 220px; overflow: auto; }
.mark { color: var(--text-faint); }
.choice[aria-checked='true'] .mark { color: var(--accent); }
.choice-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count, .faint { color: var(--text-faint); font-size: var(--text-xs); }
.boxes { display: flex; align-items: center; gap: var(--space-2); }
.box {
  flex: 1; min-width: 0; height: var(--control-sm); padding: 0 var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  background: var(--surface); color: var(--text); font: inherit; font-size: var(--text-sm);
}
.box:focus { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
.foot { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
