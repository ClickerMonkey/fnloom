<script setup lang="ts">
/**
 * What a system may do through the hub (and, when fs runs it, on its machine), as the hub enforces it: the hub calls
 * it may make, the model roles and spend, the secrets, fns, hosts and paths it may reach. A system that declares no
 * grants gets the hub's base only, which the card says.
 */
import type { SystemGrants } from '@harness/core';
import { computed } from 'vue';
import { formatCost } from '../../chat/logic/format.ts';
import { UiCard, UiEmpty } from '../../ui/index.ts';
import { grantRows } from '../logic/review.ts';

const props = defineProps<{ grants: SystemGrants | undefined }>();
const rows = computed(() => grantRows(props.grants, formatCost));
</script>

<template>
  <UiCard v-if="rows.length === 0" flat>
    <UiEmpty icon="shield" title="No grants" body="It declares nothing beyond the base: it can answer its own runs, but can't call models, other fns, secrets or the network through the hub." />
  </UiCard>
  <dl v-else class="grants" data-testid="review-grants">
    <div v-for="row in rows" :key="row.key" class="row" :data-grant="row.key">
      <dt>{{ row.label }}</dt>
      <dd>
        <span v-if="row.values.length === 0" class="none">None</span>
        <span v-for="value in row.values" :key="value" class="chip">{{ value }}</span>
      </dd>
    </div>
  </dl>
</template>

<style scoped>
.grants { display: grid; margin: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.row { display: grid; grid-template-columns: minmax(120px, 180px) minmax(0, 1fr); align-items: baseline; gap: var(--space-2) var(--space-4); padding: var(--space-2) var(--space-4); }
.row + .row { border-top: 1px solid var(--border); }
dt { color: var(--text-dim); font-size: var(--text-sm); }
dd { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; }
.chip { padding: 1px var(--space-2); border-radius: var(--radius-sm); background: var(--surface-2); font-size: var(--text-sm); overflow-wrap: anywhere; }
.none { color: var(--text-faint); font-size: var(--text-sm); }
@media (max-width: 559.98px) {
  .row { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }
}
</style>
