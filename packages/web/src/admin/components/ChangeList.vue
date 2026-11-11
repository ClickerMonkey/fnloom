<script setup lang="ts">
/**
 * What waits for review after a system went live: a new contract version or additions it made while running. Each
 * change says what it is (added, changed or removed), where it came from, and opens to a line diff of its declaration
 * before and after.
 */
import type { ContractChange } from '@harness/core';
import { ref } from 'vue';
import { DECLARED_WORDS } from '../../context/logic/context.ts';
import { UiBadge, UiIcon } from '../../ui/index.ts';
import { CHANGE_LOOK, lineDiff } from '../logic/review.ts';

defineProps<{ changes: readonly ContractChange[] }>();

const open = ref('');
const keyOf = (change: ContractChange): string => `${change.section}:${change.name}`;
const toggle = (change: ContractChange): void => { open.value = open.value === keyOf(change) ? '' : keyOf(change); };
const MARK = { same: ' ', add: '+', remove: '−' } as const;
</script>

<template>
  <ul class="changes" data-testid="review-changes">
    <li v-for="change in changes" :key="keyOf(change)" :data-change="keyOf(change)">
      <button type="button" class="row" :aria-expanded="open === keyOf(change)" data-testid="review-change" @click="toggle(change)">
        <UiIcon :name="open === keyOf(change) ? 'chevron-down' : 'chevron-right'" :size="14" class="lead" />
        <span class="main"><code class="name">{{ change.name }}</code><span class="section">{{ change.section }}</span></span>
        <span class="side">
          <span class="origin">{{ DECLARED_WORDS[change.origin] }}</span>
          <UiBadge :tone="CHANGE_LOOK[change.change].tone">{{ CHANGE_LOOK[change.change].word }}</UiBadge>
        </span>
      </button>
      <pre v-if="open === keyOf(change)" class="diff" data-testid="review-diff"><span
        v-for="(line, index) in lineDiff(change.before, change.after)" :key="index" class="line" :class="line.kind"
      >{{ MARK[line.kind] }} {{ line.text }}
</span></pre>
    </li>
  </ul>
</template>

<style scoped>
.changes { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.changes > li + li { border-top: 1px solid var(--border); }
.row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-3); width: 100%;
  padding: var(--space-2) var(--space-4); border: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer;
}
.row:hover { background: var(--surface-2); }
.row:focus-visible { outline: none; box-shadow: inset var(--ring); }
.lead { color: var(--text-faint); }
.main { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); min-width: 0; }
.name { font-size: var(--text-sm); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.section, .origin { color: var(--text-faint); font-size: var(--text-xs); }
.side { display: flex; align-items: center; gap: var(--space-2); }
.diff { margin: 0 var(--space-4) var(--space-3); padding: var(--space-2) 0; max-height: 420px; overflow: auto; border-radius: var(--radius-sm); background: var(--surface-2); font-size: var(--text-xs); }
.line { display: block; padding: 0 var(--space-3); white-space: pre-wrap; overflow-wrap: anywhere; }
.line.add { background: var(--ok-soft); }
.line.remove { background: var(--danger-soft); }
</style>
