<script setup lang="ts">
/**
 * The models the providers offer, narrowed as the person types: name and id, which provider, how much it can read
 * at once, what it can do, and its price per million tokens in and out.
 */
import { computed, ref } from 'vue';
import { formatCost, formatTokens } from '../../chat/logic/format.ts';
import { UiBadge, UiEmpty, UiInput } from '../../ui/index.ts';
import type { ModelInfo } from '../contract.ts';

const props = defineProps<{ models: readonly ModelInfo[]; providerName: (model: ModelInfo) => string }>();
const query = ref('');
const shown = computed(() => {
  const words = query.value.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
  return props.models.filter((m) => words.every((w) => `${m.id} ${m.name} ${m.capabilities.join(' ')}`.toLowerCase().includes(w)));
});
</script>

<template>
  <div class="model-table">
    <UiInput v-model="query" type="search" icon="search" label="Find a model" hide-label placeholder="Find by name, id or what it can do" clearable />
    <UiEmpty v-if="shown.length === 0" icon="search" title="No models match" :body="query === '' ? 'Add a provider to see its models.' : 'Try fewer words.'" />
    <ul v-else class="rows" data-testid="models">
      <li v-for="model in shown" :key="model.id" class="row">
        <div class="main">
          <p class="name">{{ model.name }}</p>
          <code class="id">{{ model.id }}</code>
        </div>
        <div class="chips">
          <UiBadge v-for="capability in model.capabilities" :key="capability">{{ capability }}</UiBadge>
        </div>
        <dl class="numbers">
          <div><dt>Provider</dt><dd>{{ providerName(model) }}</dd></div>
          <div v-if="model.contextWindow !== undefined"><dt>Context</dt><dd>{{ formatTokens(model.contextWindow) }}</dd></div>
          <div v-if="model.pricing"><dt>Per 1M in / out</dt><dd>{{ model.pricing.input === 0 && model.pricing.output === 0 ? 'Free' : `${formatCost(model.pricing.input)} / ${formatCost(model.pricing.output)}` }}</dd></div>
        </dl>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.model-table { display: grid; gap: var(--space-3); }
.rows { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-4); padding: var(--space-3) var(--space-4); }
.row + .row { border-top: 1px solid var(--border); }
.main { min-width: 0; }
.name { margin: 0; font-weight: var(--weight-medium); }
.id { color: var(--text-faint); font-size: var(--text-xs); overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.numbers { display: flex; gap: var(--space-4); margin: 0; font-size: var(--text-sm); }
.numbers > div { display: grid; gap: 2px; }
dt { color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap; }
dd { margin: 0; white-space: nowrap; font-variant-numeric: tabular-nums; }
@media (max-width: 759.98px) {
  .row { grid-template-columns: minmax(0, 1fr); }
  .numbers { flex-wrap: wrap; }
}
</style>
