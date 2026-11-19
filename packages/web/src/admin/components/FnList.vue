<script setup lang="ts">
/**
 * A system's fns: what each does, its version (the start of its decl's hash) and whether it was added while running,
 * whether it can be used now (and why not), whether it is paused or off, its tags,
 * and how its runs have gone (count, failure rate, retried input apart from failures, typical and p95 time, cost).
 * Its name opens the app's fn modal over the list (what it does, its on/off switch and its numbers, with Open page for
 * the full page; `switched` says when it was turned on or off there); its numbers open its runs. A tag every listed fn has (all of an
 * instance's saved queries are `database` and `query`, all added while running) is left off: it tells none apart.
 * `switchable` (a system's page) puts each fn's own on/off switch where its mark is.
 */
import { runCount, type FnRecord, type QualifiedName } from '@harness/core';
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { useFnModal } from '../../fns/state/fn-modal.ts';
import { formatCost, formatDuration } from '../../chat/logic/format.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import { UiBadge, UiIcon, UiSwitch, fullTime, relativeTime } from '../../ui/index.ts';
import { availabilityText, lacksExamples, NO_EXAMPLES_WHY, shortVersion } from '../logic/systems.ts';

const props = defineProps<{ fns: readonly FnRecord[]; now: number; runsOf: (fn: QualifiedName) => RouteLocationRaw; switchable?: boolean }>();
const emit = defineEmits<{ switch: [fn: QualifiedName, on: boolean]; switched: [fn: QualifiedName, on: boolean] }>();
const fnModal = useFnModal();
// the list follows a fn switched on or off in the modal
fnModal?.within({ switched: (fn, on) => { emit('switched', fn, on); } });

/** What every fn of a list of several shares, so it isn't repeated on each row. */
const shared = computed(() => {
  const [first, ...rest] = props.fns;
  if (first === undefined || rest.length === 0) { return { runtime: false, tags: new Set<string>() }; }
  return {
    runtime: props.fns.every((fn) => fn.origin === 'runtime'),
    tags: new Set(first.decl.tags.filter((tag) => rest.every((fn) => fn.decl.tags.includes(tag)))),
  };
});

const runTotal = (fn: FnRecord): number => runCount(fn.stats.outcomes);
const failureRate = (fn: FnRecord): string => (runTotal(fn) === 0 ? '' : `${Math.round((fn.stats.outcomes.failed / runTotal(fn)) * 100)}% failed`);
</script>

<template>
  <ul class="fns" data-testid="fns">
    <li v-for="fn in fns" :key="fn.name" class="fn" :class="{ off: fn.available !== true }">
      <UiSwitch v-if="switchable" class="switch" :model-value="!fn.disabled" :label="`Use ${fnLabel(fn.name)}`" hide-label data-testid="fn-switch" @update:model-value="emit('switch', fn.name, $event)" />
      <span v-else class="mark" aria-hidden="true"><UiIcon name="fn" :size="16" /></span>
      <div class="main">
        <p class="top">
          <button type="button" class="label" data-testid="fn-page" @click="fnModal?.open(fn.name)">{{ fnLabel(fn.name) }}</button>
          <code class="name">{{ fn.name }}</code>
          <code class="name" :title="`Version ${fn.version}`" data-testid="fn-version">v {{ shortVersion(fn.version) }}</code>
        </p>
        <p class="description">{{ fn.decl.description }}</p>
        <p class="chips">
          <UiBadge v-if="fn.available !== true" tone="warn" :title="fn.available.detail">{{ availabilityText(fn.available) }}</UiBadge>
          <UiBadge v-if="fn.paused">Paused</UiBadge>
          <UiBadge v-if="lacksExamples(fn.decl)" tone="warn" :title="NO_EXAMPLES_WHY" data-testid="fn-no-examples">No examples</UiBadge>
          <UiBadge v-if="fn.origin === 'runtime' && !shared.runtime" tone="accent">Added while running</UiBadge>
          <UiBadge v-for="tag in fn.decl.tags.filter((t) => !shared.tags.has(t))" :key="tag">{{ tag }}</UiBadge>
        </p>
      </div>
      <RouterLink class="stats" :to="runsOf(fn.name)" :title="fn.stats.lastRunAt === undefined ? 'Never run' : `Last run ${fullTime(fn.stats.lastRunAt)}`">
        <span class="runs">{{ runTotal(fn).toLocaleString() }} {{ runTotal(fn) === 1 ? 'run' : 'runs' }}</span>
        <span v-if="runTotal(fn) > 0" class="dim detail">{{ failureRate(fn) }}<template v-if="fn.stats.outcomes['invalid-input'] > 0"> · {{ fn.stats.outcomes['invalid-input'] }} retried</template> · {{ formatDuration(fn.stats.averageTime) }}<template v-if="fn.stats.p95 !== undefined"> (p95 {{ formatDuration(fn.stats.p95) }})</template> · {{ formatCost(fn.stats.averageCost) }}</span>
        <span v-if="fn.stats.lastRunAt !== undefined" class="dim">last {{ relativeTime(fn.stats.lastRunAt, now) }}</span>
      </RouterLink>
    </li>
  </ul>
</template>

<style scoped>
.fns { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.fn { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--space-3); padding: var(--space-4); }
.fn + .fn { border-top: 1px solid var(--border); }
.fn.off .label { color: var(--text-dim); }
.switch { margin-top: 4px; }
.mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); background: var(--surface-2); color: var(--text-dim); }
.main { display: grid; gap: var(--space-1); min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-2); margin: 0; }
.label { padding: 0; border: 0; background: none; color: var(--text); font: inherit; font-weight: var(--weight-medium); text-align: left; text-decoration: none; cursor: pointer; }
.label:hover { color: var(--accent); text-decoration: underline; }
.label:focus-visible { border-radius: var(--radius-sm); outline: none; box-shadow: var(--ring); }
.name { color: var(--text-faint); font-size: var(--text-xs); overflow-wrap: anywhere; }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; }
.chips:empty { display: none; }
.stats {
  display: grid; justify-items: end; gap: 2px; padding: var(--space-1) var(--space-2); border-radius: var(--radius); color: var(--text);
  font-size: var(--text-sm); text-align: right; text-decoration: none; white-space: nowrap;
}
.stats:hover { background: var(--surface-2); text-decoration: none; }
.stats:focus-visible { outline: none; box-shadow: var(--ring); }
.runs { font-weight: var(--weight-medium); }
.dim { color: var(--text-faint); font-size: var(--text-xs); }
/* on a phone the run count stays beside the title (a row of its own would hold only "0 runs"); the rates and times
   are a tap away on the fn's runs */
@media (max-width: 559.98px) {
  .fn { gap: var(--space-2); }
  .stats { margin-top: calc(var(--space-1) * -1); margin-right: calc(var(--space-2) * -1); }
  .detail { display: none; }
}
</style>
