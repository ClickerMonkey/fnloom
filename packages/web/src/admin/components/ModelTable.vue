<script setup lang="ts">
/**
 * The models the providers offer, narrowed as the person types: name and id, what it can do, which provider, how much
 * it can read at once, and its price per million tokens in and out. The columns are one grid, so they line up from
 * row to row; a number the provider doesn't give shows a dash. A model one provider lists twice shows once.
 */
import type { ModelInfo } from '@harness/core';
import { computed } from 'vue';
import { formatCost } from '../../chat/logic/format.ts';
import { contextSize, findModels, isFree } from '../../chat/logic/models.ts';
import { UiBadge, UiEmpty, UiInput } from '../../ui/index.ts';

const props = defineProps<{ models: readonly ModelInfo[]; providerName: (model: ModelInfo) => string }>();
/** The search; a parent binds it to the URL so a refresh keeps it. */
const query = defineModel<string>('query', { default: '' });

const keyOf = (model: ModelInfo): string => `${model.provider}/${model.id}`;
const unique = computed(() => [...new Map(props.models.map((m) => [keyOf(m), m])).values()]);
const shown = computed(() => findModels(unique.value, { text: query.value, filters: new Set(), sort: 'name' }));
const context = (model: ModelInfo): string => contextSize(model) || '—';
const price = (model: ModelInfo): string => {
  if (model.pricing === undefined) { return '—'; }
  return isFree(model) ? 'Free' : `${formatCost(model.pricing.input)} / ${formatCost(model.pricing.output)}`;
};
</script>

<template>
  <div class="model-table">
    <div class="pinned"><UiInput v-model="query" type="search" icon="search" label="Find a model" hide-label placeholder="Find by name, id or what it can do" clearable /></div>
    <UiEmpty v-if="shown.length === 0" icon="search" title="No models match" :body="query === '' ? 'Add a provider to see its models.' : 'Try fewer words.'" />
    <ul v-else class="rows" data-testid="models">
      <li class="row head" aria-hidden="true"><span>Model</span><span>Can</span><span>Provider</span><span class="num">Context</span><span class="num">Per 1M in / out</span></li>
      <li v-for="model in shown" :key="keyOf(model)" class="row" data-testid="model-row">
        <div class="main">
          <p class="name">{{ model.name }}</p>
          <code class="id">{{ model.id }}</code>
        </div>
        <div class="chips">
          <UiBadge v-for="capability in model.capabilities" :key="capability">{{ capability }}</UiBadge>
        </div>
        <dl class="numbers">
          <div class="cell"><dt>Provider</dt><dd>{{ providerName(model) }}</dd></div>
          <div class="cell num"><dt>Context</dt><dd>{{ context(model) }}</dd></div>
          <div class="cell num"><dt>Per 1M in / out</dt><dd>{{ price(model) }}</dd></div>
        </dl>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.model-table { display: grid; gap: var(--space-3); }
.rows { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.row {
  display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 110px 80px 150px; align-items: center; gap: var(--space-2) var(--space-4);
  padding: var(--space-3) var(--space-4);
}
.row + .row { border-top: 1px solid var(--border); }
.head { padding-block: var(--space-2); background: var(--surface-2); color: var(--text-faint); font-size: var(--text-xs); font-weight: var(--weight-medium); }
.main { min-width: 0; }
.name { margin: 0; font-weight: var(--weight-medium); }
.id { color: var(--text-faint); font-size: var(--text-xs); overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.numbers { display: contents; }
.cell { min-width: 0; font-size: var(--text-sm); }
.num { text-align: right; }
dt { display: none; color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap; }
dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
@media (max-width: 759.98px) {
  .row { grid-template-columns: minmax(0, 1fr); }
  .head { display: none; }
  .numbers { display: flex; flex-wrap: wrap; gap: var(--space-4); margin: 0; }
  .cell { display: grid; gap: 2px; }
  .num { text-align: left; }
  dt { display: block; }
}
</style>
