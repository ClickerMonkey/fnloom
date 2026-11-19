<script setup lang="ts">
/**
 * The context inspector: what a contextor put in one prompt. The window as one bar split into its parts (what was
 * fixed, history, context, fns, and what was held back for the margin, reasoning and the reply), with a legend that is
 * also the table of numbers; the context items and fns it chose, each at its detail with its weight; how much history
 * went as messages and which earlier turns as summaries; and what was cut to fit.
 */
import type { SelectionReport } from '@harness/core';
import { computed } from 'vue';
import FnPill from '../../fns/components/FnPill.vue';
import { UiBadge } from '../../ui/index.ts';
import { formatTokens } from '../logic/format.ts';
import {
  BUDGET_WORDS, budgetFill, budgetSlices, contextorLabel, DETAIL_WORDS, inputBudget, modeLabel, rankItems, type BudgetPart, type RankedItem,
} from '../logic/modes.ts';

const props = defineProps<{ report: SelectionReport }>();

const slices = computed(() => budgetSlices(props.report.budget));
const room = computed(() => inputBudget(props.report.budget));
const fill = computed(() => budgetFill(props.report.budget));
const context = computed(() => rankItems(props.report.context));
const fns = computed(() => rankItems(props.report.fns));

/** Each part's colour: the four used parts take the series in order; what is held back is neutral; unused is empty. */
const PART_FILL = {
  fixed: 'var(--series-1)', history: 'var(--series-2)', context: 'var(--series-3)', fns: 'var(--series-4)',
  margin: 'var(--series-reserve)', reasoning: 'var(--series-reserve)', output: 'var(--series-reserve)', free: 'transparent',
} as const satisfies Record<BudgetPart, string>;

const percent = (share: number): string => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
const itemTitle = (item: RankedItem): string => `${item.name}: ${DETAIL_WORDS[item.detail]}, activation ${item.activation.toFixed(2)}`;
</script>

<template>
  <div class="selection" data-testid="selection-report">
    <p class="chips">
      <UiBadge tone="accent">{{ modeLabel(report.mode) }}</UiBadge>
      <UiBadge>{{ contextorLabel(report.contextor) }}</UiBadge>
      <span class="dim">{{ report.linear }} {{ report.linear === 1 ? 'exchange' : 'exchanges' }} as messages<span v-if="report.earlier.length > 0"> · {{ report.earlier.length }} earlier summarised</span></span>
    </p>

    <section class="budget" aria-label="How the window was spent">
      <p class="budget-head">
        <strong>{{ formatTokens(report.budget.window) }}</strong> token window
        <span class="dim">· {{ formatTokens(report.budget.estimate) }} of {{ formatTokens(room) }} for input used ({{ percent(fill) }})</span>
      </p>
      <div class="bar" role="img" :aria-label="slices.map((s) => `${BUDGET_WORDS[s.part].label} ${s.tokens}`).join(', ')" data-testid="budget-bar">
        <span
          v-for="slice in slices" :key="slice.part" class="segment" :class="[slice.part, { reserve: PART_FILL[slice.part] === 'var(--series-reserve)' }]"
          :style="{ flexGrow: slice.tokens, background: PART_FILL[slice.part] }" :title="`${BUDGET_WORDS[slice.part].label}: ${slice.tokens.toLocaleString()} tokens (${percent(slice.share)})`"
        />
      </div>
      <table class="legend">
        <thead class="sr-only"><tr><th>Part</th><th>Tokens</th><th>Asked</th><th>Share</th></tr></thead>
        <tbody>
          <tr v-for="slice in slices" :key="slice.part" :data-part="slice.part" :title="BUDGET_WORDS[slice.part].about">
            <td class="part">
              <span class="swatch" :class="{ reserve: PART_FILL[slice.part] === 'var(--series-reserve)', empty: slice.part === 'free' }" :style="{ background: PART_FILL[slice.part] }" aria-hidden="true" />
              {{ BUDGET_WORDS[slice.part].label }}
            </td>
            <td class="num">{{ slice.tokens.toLocaleString() }}</td>
            <td class="num dim">{{ slice.asked !== undefined && slice.asked > slice.tokens ? `asked ${slice.asked.toLocaleString()}` : '' }}</td>
            <td class="num dim">{{ percent(slice.share) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-for="group in [{ key: 'context', title: 'Context', items: context }, { key: 'fns', title: 'Fns', items: fns }]" :key="group.key" class="items" :data-testid="`selected-${group.key}`">
      <h4 class="heading">{{ group.title }} <span class="dim">{{ group.items.length }}</span></h4>
      <ul v-if="group.items.length > 0" class="list">
        <li v-for="item in group.items" :key="item.name" class="item" :title="itemTitle(item)">
          <FnPill v-if="group.key === 'fns'" class="name" :name="item.name" />
          <code v-else class="name">{{ item.name }}</code>
          <UiBadge :tone="item.detail === 'full' ? 'accent' : 'neutral'">{{ DETAIL_WORDS[item.detail] }}</UiBadge>
          <span class="weight" aria-hidden="true"><span class="weight-fill" :style="{ width: `${Math.max(4, item.weight * 100)}%` }" /></span>
          <span class="num dim">{{ item.activation.toFixed(2) }}</span>
        </li>
      </ul>
      <p v-else class="dim">None chosen.</p>
    </section>

    <section v-if="report.earlier.length > 0" class="items">
      <h4 class="heading">Earlier turns summarised</h4>
      <p class="dim">{{ report.earlier.map((turn) => `#${turn + 1}`).join(', ') }}</p>
    </section>

    <section v-if="report.budget.cut.length > 0" class="items" data-testid="budget-cuts">
      <h4 class="heading">Cut to fit</h4>
      <ul class="cuts">
        <li v-for="(cut, i) in report.budget.cut" :key="i"><strong>{{ cut.what }}</strong> <span class="dim">{{ cut.why }}</span></li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.selection { display: grid; gap: var(--space-4); min-width: 0; }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; }
.dim { color: var(--text-faint); font-size: var(--text-sm); }
.budget { display: grid; gap: var(--space-2); }
.budget-head { margin: 0; font-size: var(--text-sm); }
/* the parts sit 2px apart, each with rounded ends, so neighbours never merge */
.bar { display: flex; gap: 2px; height: 14px; min-width: 0; }
.segment { min-width: 3px; border-radius: 4px; }
.segment.free { border: 1px dashed var(--border-strong); }
.segment.reserve, .swatch.reserve {
  background-image: repeating-linear-gradient(45deg, transparent 0 3px, color-mix(in oklch, var(--surface) 55%, transparent) 3px 5px) !important;
}
.legend { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.legend td { padding: 3px 0; }
.legend tr + tr td { border-top: 1px solid var(--border); }
.part { display: flex; align-items: center; gap: var(--space-2); }
.swatch { flex: none; width: 10px; height: 10px; border-radius: 3px; }
.swatch.empty { border: 1px dashed var(--border-strong); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; padding-left: var(--space-3) !important; }
.items { display: grid; gap: var(--space-2); }
.heading { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.list, .cuts { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.item { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(40px, 80px) auto; align-items: center; gap: var(--space-2); min-height: 28px; }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); }
.weight { height: 6px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
.weight-fill { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
.cuts li { font-size: var(--text-sm); overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
/* on a phone the weight bar and its number wrap under the name and chip, never hidden: the weight is why it was chosen */
@media (max-width: 420px) {
  .item { grid-template-columns: minmax(0, 1fr) auto; row-gap: 2px; }
}
</style>
