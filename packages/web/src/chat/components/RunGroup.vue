<script setup lang="ts">
/**
 * A stretch of fn calls (with the reasoning between them) as one collapsed section: one line with the group's status,
 * how many calls (and how many failed or are in progress) and the calls condensed by fn, the most recent fn first
 * ("Bash ×3 · Read ×2"). Opened, it lists its steps in the order the model made them: each call's card, and the
 * reasoning between calls folded where it happened. It stays open by itself while one of its runs is going or needs
 * the person, so live work and an approval are never hidden; it folds once they settle, unless the person opened it.
 */
import { isSettled, type Display, type RunId } from '@harness/core';
import { computed, ref } from 'vue';
import { UiIcon } from '../../ui/index.ts';
import { groupCount, groupSummary, groupText, needsPerson } from '../logic/groups.ts';
import type { RunView } from '../logic/runs.ts';
import ReasoningBlock from './ReasoningBlock.vue';
import RunDot from './RunDot.vue';
import RunList from './RunList.vue';
import type { GroupStep, RenderView } from './types.ts';

const props = defineProps<{
  steps: readonly GroupStep[];
  now: number;
  collapsed: (run: RunView) => boolean;
  viewOf: (run: RunView) => RenderView<'fn'> | undefined;
  showOf: (run: RunView) => Display;
}>();
/** Whether the person opened it. */
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ open: [run: RunId]; toggle: [run: RunId, collapsed: boolean]; background: [run: RunId] }>();

const runs = computed(() => props.steps.flatMap((step) => (step.kind === 'runs' ? step.runs : [])));
const summary = computed(() => groupSummary(runs.value));
/** Shown open: opened, or one of its runs is going or waits on the person. */
const shown = computed(() => open.value || runs.value.some((run) => needsPerson(run) || !isSettled(run.status)));

/** The reasoning steps opened, by key. */
const openReasoning = ref<ReadonlySet<string>>(new Set());
function setReasoning(key: string, next: boolean): void {
  const keys = new Set(openReasoning.value);
  if (next) { keys.add(key); } else { keys.delete(key); }
  openReasoning.value = keys;
}
</script>

<template>
  <section class="group" :class="{ shown }" data-testid="run-group" :data-runs="runs.length">
    <button type="button" class="head touch-target" :aria-expanded="shown ? 'true' : 'false'" data-testid="run-group-toggle" @click="open = !shown">
      <RunDot :status="summary.status" :size="10" />
      <span class="count">{{ groupCount(summary) }}</span>
      <span class="calls">{{ groupText(summary) }}</span>
      <UiIcon class="chevron" :name="shown ? 'chevron-down' : 'chevron-right'" :size="14" />
    </button>
    <div v-if="shown" class="body">
      <template v-for="step in steps" :key="step.key">
        <ReasoningBlock v-if="step.kind === 'reasoning'" :text="step.text" :thinking="false" :open="openReasoning.has(step.key)" @update:open="setReasoning(step.key, $event)" />
        <RunList
          v-else :runs="step.runs" :now="now" :collapsed="collapsed" :view-of="viewOf" :show-of="showOf"
          @open="emit('open', $event)" @toggle="(id, c) => emit('toggle', id, c)" @background="emit('background', $event)"
        />
      </template>
    </div>
  </section>
</template>

<style scoped>
.group { display: grid; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.head {
  display: flex; align-items: center; gap: var(--space-2); min-width: 0; padding: var(--space-2) var(--space-3); border: 0; border-radius: var(--radius-lg);
  background: transparent; color: var(--text); font-size: var(--text-sm); text-align: left;
}
.head:hover { background: var(--surface-2); }
.head:focus-visible { outline: none; box-shadow: var(--ring); }
.shown .head { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.count { flex: none; font-weight: var(--weight-medium); }
.calls { flex: 1; min-width: 0; color: var(--text-dim); overflow-wrap: anywhere; }
.chevron { flex: none; color: var(--text-faint); }
.body { display: grid; gap: var(--space-2); min-width: 0; padding: var(--space-2); border-top: 1px solid var(--border); }
</style>
