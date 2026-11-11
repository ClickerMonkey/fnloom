<script setup lang="ts">
/**
 * A fn's runs as rows, newest first: status, what each was about, a failure or approval badge, a retry's try number,
 * cost and time, and when. A row opens its run. The fn modal shows the runs in the chat; the fn page its latest ones.
 */
import type { RunId } from '@harness/core';
import BrowserRow from '../../admin/components/BrowserRow.vue';
import RunDot from '../../chat/components/RunDot.vue';
import { formatCost, formatDuration } from '../../chat/logic/format.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import { argSummary, runElapsed, STATUS_LOOK, type RunView } from '../../chat/logic/runs.ts';
import { UiBadge, UiCard } from '../../ui/index.ts';

withDefaults(defineProps<{ runs: readonly RunView[]; now: number; title: string; loading?: boolean; problem?: string; empty?: string }>(), {
  loading: false, problem: '', empty: 'No runs yet.',
});
const emit = defineEmits<{ open: [run: RunId] }>();
const slots = defineSlots<{ actions?: () => unknown }>();
</script>

<template>
  <UiCard class="runs" :title="title" flush compact data-testid="fn-recent">
    <template v-if="slots.actions" #actions><slot name="actions" /></template>
    <p v-if="problem !== ''" class="none bad" role="alert">{{ problem }}</p>
    <p v-else-if="runs.length === 0" class="none">{{ loading ? 'Loading…' : empty }}</p>
    <ul v-else class="list">
      <BrowserRow
        v-for="run in runs" :key="run.id" :title="argSummary(run.args) || fnLabel(run.fn)" :at="run.createdAt" :now="now" :testid="`fn-run-${run.id}`"
        @open="emit('open', run.id)"
      >
        <template #mark><RunDot :status="run.status" :size="10" /></template>
        <template #badges>
          <UiBadge v-if="run.status === 'failed' || run.status === 'awaiting-approval'" :tone="STATUS_LOOK[run.status].tone">{{ STATUS_LOOK[run.status].word }}</UiBadge>
          <UiBadge v-if="run.attempt > 1" tone="warn">Try {{ run.attempt }}</UiBadge>
        </template>
        <template #figures>
          <span>{{ formatCost(run.totalCost) }}</span>
          <span v-if="runElapsed(run, now) !== undefined">{{ formatDuration(runElapsed(run, now) ?? 0) }}</span>
        </template>
      </BrowserRow>
    </ul>
  </UiCard>
</template>

<style scoped>
.list { margin: 0; padding: 0; list-style: none; }
.none { margin: 0; padding: var(--space-3) var(--space-4); color: var(--text-faint); font-size: var(--text-sm); }
.bad { color: var(--danger); }
</style>
