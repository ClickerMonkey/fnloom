<script setup lang="ts">
/**
 * The value family (DOM, not ECharts): one to four rows of values. `cards` shows each bound column of each row as a
 * labelled card; `single` shows the first value large with the rest of its row under it. A card is a button when the
 * row can be drilled into.
 */
import { computed } from 'vue';
import type { VisualProps } from '../results/visuals.ts';
import { cellText } from '../results/table.ts';

const props = withDefaults(defineProps<VisualProps>(), { pager: undefined, opener: undefined });
const emit = defineEmits<{ drill: [row: number] }>();

const columns = computed(() => (props.bind['value'] ?? []).flatMap((name) => {
  const index = props.table.columns.findIndex((c) => c.name === name);
  const column = props.table.columns[index];
  return column === undefined ? [] : [{ index, column, label: column.label ?? column.name }];
}));
const cards = computed(() => props.table.rows.map((row, at) => ({
  at, values: columns.value.map((c) => ({ label: c.label, text: cellText(row[c.index], c.column) ?? '—', name: c.column.name })),
})));
const lead = computed(() => cards.value[0]);
</script>

<template>
  <div class="values" data-testid="value-visual" :data-style="style">
    <div v-if="style === 'single' && lead" class="single">
      <button type="button" class="big" data-testid="value-card" @click="emit('drill', lead.at)">
        <span class="label">{{ lead.values[0]?.label }}</span>
        <span class="number">{{ lead.values[0]?.text }}</span>
      </button>
      <dl v-if="lead.values.length > 1" class="rest">
        <div v-for="value in lead.values.slice(1)" :key="value.name"><dt>{{ value.label }}</dt><dd>{{ value.text }}</dd></div>
      </dl>
    </div>
    <ul v-else class="cards">
      <template v-for="card in cards" :key="card.at">
        <li v-for="value in card.values" :key="`${card.at}:${value.name}`">
          <button type="button" class="card" data-testid="value-card" @click="emit('drill', card.at)">
            <span class="label">{{ value.label }}</span>
            <span class="number">{{ value.text }}</span>
          </button>
        </li>
      </template>
    </ul>
  </div>
</template>

<style scoped>
.values { min-width: 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.card, .big {
  display: grid; gap: 2px; width: 100%; min-width: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); color: var(--text); font: inherit; text-align: left; cursor: pointer;
}
.card:hover, .big:hover { border-color: var(--border-strong); }
.card:focus-visible, .big:focus-visible { outline: none; box-shadow: var(--ring); }
.label { overflow: hidden; color: var(--text-dim); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.number { overflow: hidden; font-size: var(--text-xl); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.single { display: grid; gap: var(--space-2); }
.big .number { font-size: 40px; line-height: 1.1; }
.rest { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: 0; font-size: var(--text-sm); }
.rest div { display: flex; gap: var(--space-1); }
.rest dt { color: var(--text-dim); }
.rest dd { margin: 0; font-variant-numeric: tabular-nums; }
</style>
