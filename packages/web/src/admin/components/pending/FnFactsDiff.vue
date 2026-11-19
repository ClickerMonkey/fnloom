<script setup lang="ts">
/**
 * A changed fn as a facts card, before and after: its description as a prose diff, then its mode, what it changes in
 * the hub, the types it reads and writes, what it uses and what it costs, side by side (stacked when narrow), the facts
 * that moved marked; the fns it uses are `FnPill`s. A new fn shows only its facts after; a removed one only before.
 */
import type { FnChangeFacts } from '@harness/core';
import { computed } from 'vue';
import { formatCost } from '../../../chat/logic/format.ts';
import FnPill from '../../../fns/components/FnPill.vue';
import { factRows } from '../../logic/review.ts';
import ProseDiff from './ProseDiff.vue';

const props = defineProps<{ facts: FnChangeFacts | undefined; before: string | undefined; after: string | undefined }>();
const rows = computed(() => (props.facts === undefined ? [] : factRows(props.facts, formatCost)));
const both = computed(() => props.facts?.before !== undefined && props.facts.after !== undefined);
const moved = computed(() => rows.value.filter((row) => row.changed).length);
/** The fns a side uses, drawn as pills in the Uses row (none: the row's words). */
const deps = computed(() => ({ before: props.facts?.before?.deps ?? [], after: props.facts?.after?.deps ?? props.facts?.before?.deps ?? [] }));
</script>

<template>
  <div class="fn-facts" data-testid="fn-change-facts">
    <ProseDiff v-if="before !== after" :before="before" :after="after" class="about" />
    <p v-else-if="after" class="about same">{{ after }}</p>
    <table v-if="rows.length > 0" class="facts" :class="{ both }">
      <caption class="sr">{{ both ? `Its facts before and after; ${moved} moved` : 'Its facts' }}</caption>
      <thead v-if="both">
        <tr><th scope="col"><span class="sr">Fact</span></th><th scope="col">Before</th><th scope="col">After</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key" :class="{ changed: row.changed }" :data-fact="row.key">
          <th scope="row">{{ row.label }}</th>
          <td v-if="both" class="was" :data-label="'Before'">
            <span v-if="row.key === 'deps' && deps.before.length > 0" class="pills"><FnPill v-for="fn in deps.before" :key="fn" :name="fn" /></span>
            <template v-else>{{ row.before }}</template>
          </td>
          <td class="now" :data-label="both ? 'After' : undefined">
            <span v-if="row.key === 'deps' && deps.after.length > 0" class="pills"><FnPill v-for="fn in deps.after" :key="fn" :name="fn" /></span>
            <template v-else>{{ row.after ?? row.before }}</template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.pills { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.fn-facts { display: grid; gap: var(--space-2); min-width: 0; container-type: inline-size; }
.about { color: var(--text); font-size: var(--text-sm); }
.about.same { margin: 0; color: var(--text-dim); }
.facts { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.facts th, .facts td { padding: var(--space-1) var(--space-2); border-top: 1px solid var(--border); text-align: left; vertical-align: baseline; overflow-wrap: anywhere; }
.facts thead th { border-top: 0; color: var(--text-faint); font-size: var(--text-xs); font-weight: var(--weight-medium); text-transform: uppercase; letter-spacing: 0.04em; }
.facts tbody th { width: 9.5rem; color: var(--text-dim); font-weight: var(--weight-regular, 400); }
.was { color: var(--text-dim); }
tr.changed .was { color: var(--danger); text-decoration: line-through; text-decoration-thickness: 1px; }
tr.changed .now { color: var(--ok); font-weight: var(--weight-medium); }
tr.changed th { color: var(--text); }
tr.changed th::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: var(--space-1); border-radius: 50%; background: var(--accent); vertical-align: middle; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@container (max-width: 460px) {
  .facts.both thead { display: none; }
  .facts.both tr { display: grid; grid-template-columns: minmax(0, 1fr); padding: var(--space-1) 0; border-top: 1px solid var(--border); }
  .facts.both th, .facts.both td { border-top: 0; padding: 0 var(--space-2); }
  .facts.both td::before { content: attr(data-label) ': '; color: var(--text-faint); font-size: var(--text-xs); }
}
</style>
