<script setup lang="ts">
/**
 * What a set of contract changes amounts to, as the hub worked it out (`ReviewSummary`): its one line, a chip per
 * section that changed ("+3 fns · 1 changed"), how the grants and the config type moved, then its risk flags, most
 * serious first, each with what it is about: a flag about fns names each as a pill (`flagFns`) that opens it. The review
 * page's Pending tab and the chat's install card both draw it.
 */
import type { ReviewSummary } from '@harness/core';
import { computed } from 'vue';
import { FLAG_LOOK, flagFns, GRANTS_MOVE_LOOK, sectionWords } from '../../admin/logic/review.ts';
import FnPill from '../../fns/components/FnPill.vue';
import { UiBadge, UiIcon } from '../../ui/index.ts';

const props = withDefaults(defineProps<{ summary: ReviewSummary; compact?: boolean }>(), { compact: false });

/** A chip per item section that changed (the grants and config get their own). */
const chips = computed(() => props.summary.counts.filter((count) => count.section !== 'grants' && count.section !== 'config').map((count) => ({
  section: count.section,
  label: sectionWords(count.section),
  parts: [
    ...(count.added > 0 ? [{ kind: 'add', text: `+${count.added}` }] : []),
    ...(count.changed > 0 ? [{ kind: 'change', text: `~${count.changed}` }] : []),
    ...(count.removed > 0 ? [{ kind: 'remove', text: `−${count.removed}` }] : []),
  ],
})));
const risky = computed(() => props.summary.flags.length > 0);
/** Each flag with its fns split out for pills, when it is about fns. */
const flags = computed(() => props.summary.flags.map((flag) => ({ flag, fns: flagFns(flag) })));
</script>

<template>
  <section class="strip" :class="{ risky, compact }" data-testid="review-summary" :aria-label="`What changes: ${summary.line}`">
    <header class="head">
      <UiIcon :name="risky ? 'warning' : 'check'" :size="16" class="lead" />
      <p class="line" data-testid="review-summary-line">{{ summary.line }}</p>
    </header>
    <div class="chips">
      <span v-for="chip in chips" :key="chip.section" class="chip" :data-section="chip.section">
        <span class="label">{{ chip.label }}</span>
        <span v-for="part in chip.parts" :key="part.kind" class="count" :class="part.kind">{{ part.text }}</span>
      </span>
      <UiBadge v-if="summary.grants" :tone="GRANTS_MOVE_LOOK[summary.grants].tone" data-testid="review-summary-grants">{{ GRANTS_MOVE_LOOK[summary.grants].word }}</UiBadge>
      <UiBadge v-if="summary.config" tone="accent">Config type {{ summary.config }}</UiBadge>
    </div>
    <ul v-if="risky" class="flags" data-testid="review-flags">
      <li v-for="{ flag, fns } in flags" :key="flag.flag" class="flag" :class="`tone-${FLAG_LOOK[flag.flag].tone}`" :data-flag="flag.flag">
        <UiIcon :name="FLAG_LOOK[flag.flag].icon" :size="14" />
        <span v-if="fns" class="about" :aria-label="flag.line">
          {{ fns.lead }}<template v-if="!fns.tail">:</template>
          <FnPill v-for="fn in fns.fns" :key="fn" :name="fn" />
          <template v-if="fns.tail">: {{ fns.tail }}</template>
        </span>
        <span v-else>{{ flag.line }}</span>
      </li>
    </ul>
    <p v-else-if="!compact" class="calm">No new write or delete fns, effects, grants, hosts or secrets.</p>
  </section>
</template>

<style scoped>
.strip {
  display: grid; gap: var(--space-2); min-width: 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-left: 3px solid var(--ok);
  border-radius: var(--radius-lg); background: var(--surface); animation: strip-in 220ms ease-out;
}
.strip.risky { border-left-color: var(--warn); background: linear-gradient(90deg, var(--warn-soft), var(--surface) 55%); }
.strip.compact { padding: var(--space-2) var(--space-3); border-radius: var(--radius); }
.head { display: flex; align-items: flex-start; gap: var(--space-2); min-width: 0; }
.lead { flex: none; margin-top: 2px; color: var(--ok); }
.risky .lead { color: var(--warn); }
.line { margin: 0; font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-2); }
.chip { display: inline-flex; align-items: center; gap: var(--space-1); height: 22px; padding: 0 var(--space-2); border-radius: var(--radius-full); background: var(--surface-2); font-size: var(--text-xs); }
.label { color: var(--text-dim); }
.count { font-family: var(--mono); font-weight: var(--weight-medium); }
.count.add { color: var(--ok); }
.count.change { color: var(--accent); }
.count.remove { color: var(--danger); }
.flags { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.flag { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); background: var(--tone-soft); color: var(--tone); font-size: var(--text-sm); overflow-wrap: anywhere; }
.flag > :deep(svg) { flex: none; margin-top: 3px; }
.about { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); min-width: 0; }
.calm { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
@keyframes strip-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .strip { animation: none; } }
</style>
