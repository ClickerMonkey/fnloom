<script setup lang="ts">
/**
 * What a system may do through the hub (and, when fs runs it, on its machine), as the hub enforces it: the hub calls
 * it may make, the model roles and spend, the secrets, fns, hosts and paths it may reach. A system that declares no
 * grants gets the hub's base only, which the card says. With `delta`, each value is marked against the grants `before`
 * (newly granted, or no longer granted), as a pending change to the grants reads. The fns it may call are `FnPill`s: a
 * fn opens in the fn modal, a whole system or a glob links to the fns it matches.
 */
import type { SystemGrants } from '@harness/core';
import { computed } from 'vue';
import { formatCost } from '../../chat/logic/format.ts';
import FnPill from '../../fns/components/FnPill.vue';
import { UiCard, UiEmpty } from '../../ui/index.ts';
import { grantDeltaRows } from '../logic/review.ts';

const props = withDefaults(defineProps<{ grants: SystemGrants | undefined; delta?: boolean; before?: SystemGrants | undefined }>(), { delta: false, before: undefined });
const rows = computed(() => (props.grants === undefined && !props.delta ? [] : grantDeltaRows(props.delta ? props.before ?? { hub: [] } : undefined, props.grants, formatCost)));
const MARK = { same: '', add: '+', remove: '−' } as const;
const WORD = { same: '', add: 'newly granted', remove: 'no longer granted' } as const;
</script>

<template>
  <UiCard v-if="rows.length === 0" flat>
    <UiEmpty icon="shield" title="No grants" body="It declares nothing beyond the base: it can answer its own runs, but can't call models, other fns, secrets or the network through the hub." />
  </UiCard>
  <dl v-else class="grants" :class="{ delta }" data-testid="review-grants">
    <div v-for="row in rows" :key="row.key" class="row" :data-grant="row.key">
      <dt>{{ row.label }}</dt>
      <dd>
        <span v-if="row.values.length === 0" class="none">None</span>
        <template v-for="value in row.values" :key="`${value.kind}:${value.value}`">
          <span v-if="row.key === 'calls'" class="call" :class="value.kind" :data-delta="delta ? value.kind : undefined">
            <span v-if="MARK[value.kind]" class="mark" aria-hidden="true">{{ MARK[value.kind] }}</span><FnPill :name="value.value" :off="value.kind === 'remove'" /><span v-if="WORD[value.kind]" class="sr">, {{ WORD[value.kind] }}</span>
          </span>
          <span
            v-else class="chip" :class="value.kind" :data-delta="delta ? value.kind : undefined" :title="WORD[value.kind] || undefined"
          ><span v-if="MARK[value.kind]" class="mark" aria-hidden="true">{{ MARK[value.kind] }}</span>{{ value.value }}<span v-if="WORD[value.kind]" class="sr">, {{ WORD[value.kind] }}</span></span>
        </template>
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
.chip.add { background: var(--ok-soft); color: var(--ok); font-weight: var(--weight-medium); }
.chip.remove { background: var(--danger-soft); color: var(--danger); text-decoration: line-through; }
.mark { margin-right: 2px; font-family: var(--mono); }
.call { display: inline-flex; align-items: center; max-width: 100%; }
.call.add .mark { color: var(--ok); font-weight: var(--weight-medium); }
.call.add :deep(.fn-pill) { box-shadow: 0 0 0 1px var(--ok); }
.call.remove .mark { color: var(--danger); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.none { color: var(--text-faint); font-size: var(--text-sm); }
@media (max-width: 559.98px) {
  .row { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }
}
</style>
