<script setup lang="ts">
/**
 * The calls the hub refused because a system went past what it declared, newest first: the rule it broke, what it
 * tried, one line of why, the fn and run it came from, and when. The rule filter narrows the list.
 */
import { REFUSAL_RULES, type RefusalRecord, type RefusalRule, type RunId } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { relativeTime, fullTime, UiBadge, UiSelect, type SelectOption } from '../../ui/index.ts';
import { RULE_WORDS } from '../logic/review.ts';

defineProps<{
  refusals: readonly RefusalRecord[];
  now: number;
  /** A run's page. */
  runPage: (run: RunId) => RouteLocationRaw;
}>();
const rule = defineModel<RefusalRule | 'all'>('rule', { required: true });

const RULES: readonly SelectOption<RefusalRule | 'all'>[] = [{ value: 'all', label: 'Every rule' }, ...REFUSAL_RULES.map((value) => ({ value, label: RULE_WORDS[value] }))];
</script>

<template>
  <div class="refusals">
    <UiSelect v-model="rule" class="filter" :options="RULES" label="Rule" hide-label data-testid="refusal-rule" />
    <ul v-if="refusals.length > 0" class="list" data-testid="refusal-list">
      <li v-for="refusal in refusals" :key="refusal.id" class="row" :data-rule="refusal.rule">
        <UiBadge tone="danger">{{ RULE_WORDS[refusal.rule] }}</UiBadge>
        <span class="main">
          <span class="detail">{{ refusal.detail }}</span>
          <span class="meta">
            <code>{{ refusal.attempt }}</code>
            <span v-if="refusal.fn"> · from <code>{{ refusal.fn }}</code></span>
            <span> · {{ refusal.instance }}</span>
            <RouterLink v-if="refusal.run" :to="runPage(refusal.run)"> · open the run</RouterLink>
          </span>
        </span>
        <time class="at" :datetime="new Date(refusal.at).toISOString()" :title="fullTime(refusal.at)">{{ relativeTime(refusal.at, now) }}</time>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.refusals { display: grid; gap: var(--space-3); }
.filter { justify-self: start; min-width: 200px; }
.list { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.list > li + li { border-top: 1px solid var(--border); }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--space-2) var(--space-3); padding: var(--space-2) var(--space-4); }
.main { display: grid; gap: 2px; min-width: 0; }
.detail { font-size: var(--text-sm); overflow-wrap: anywhere; }
.meta { color: var(--text-dim); font-size: var(--text-xs); overflow-wrap: anywhere; }
.at { color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap; }
@media (max-width: 559.98px) {
  .row { grid-template-columns: minmax(0, 1fr) auto; }
  .main { grid-column: 1 / -1; grid-row: 2; }
}
</style>
