<script setup lang="ts">
/**
 * A used-up budget a run in this chat waits on, sitting with the approvals above the composer: which budget and how
 * much ("the session budget of $1.00 is used up"), and, for someone who may raise it, "Raise by $X and resume" or
 * "Leave it". Anyone else is told an admin was asked. The run goes on by itself once the budget is raised.
 */
import { upperFirst } from '@harness/core';
import { computed, ref } from 'vue';
import { UiButton, UiIcon } from '../../ui/index.ts';
import { formatCost } from '../logic/format.ts';
import type { BudgetAsk } from '../state/thread.ts';

const props = withDefaults(defineProps<{
  ask: BudgetAsk;
  /** The fn of the run that waits, in words. */
  fnLabel: string;
  /** Whether this person may raise budgets (admins). */
  canRaise: boolean;
  busy?: boolean;
}>(), { busy: false });
const emit = defineEmits<{ raise: [by: number]; leave: [] }>();

/** How much a raise adds: the budget's own size again, at least a dollar. */
const step = computed(() => Math.max(1, props.ask.budget.maxCost));
const raising = ref(false);

function raise(): void {
  raising.value = true;
  emit('raise', step.value);
}
</script>

<template>
  <section class="budget" role="region" :aria-label="`${fnLabel} waits on a budget`" data-testid="budget-card" :data-budget="ask.budget.id">
    <header class="head">
      <span class="icon"><UiIcon name="warning" :size="16" /></span>
      <div class="titles">
        <h3 class="title">Budget reached</h3>
        <p class="description">{{ upperFirst(ask.reason) }}. {{ fnLabel }} waits until it is raised.</p>
      </div>
    </header>
    <footer v-if="canRaise" class="foot">
      <UiButton size="sm" variant="secondary" :disabled="busy" data-testid="budget-leave" @click="emit('leave')">Leave it</UiButton>
      <UiButton size="sm" variant="primary" icon="check" :loading="busy && raising" :disabled="busy" data-testid="budget-raise" @click="raise">
        Raise by {{ formatCost(step) }} and resume
      </UiButton>
    </footer>
    <p v-else class="description" data-testid="budget-asked">An admin has been asked to raise it.</p>
  </section>
</template>

<style scoped>
.budget {
  display: grid; gap: var(--space-3); min-width: 0; padding: var(--space-3) var(--space-4);
  border: 1px solid var(--warn); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 0 0 3px var(--warn-soft);
  animation: ui-rise-in var(--medium) var(--ease);
}
.head { display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; }
.icon { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius); background: var(--warn-soft); color: var(--warn); }
.titles { display: grid; gap: 2px; flex: 1; min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); overflow-wrap: anywhere; }
.foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
</style>
