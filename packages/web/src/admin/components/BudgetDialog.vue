<script setup lang="ts">
/**
 * Making or changing a budget: where it applies, over what period (a rolling window, all time, or each message), the
 * most it may spend (and optionally tokens, calls and time), how a group shares it, and what happens at the limit.
 */
import type { LimitLevel } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiInput, UiSegmented, UiSelect, optionsOf, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import type { BudgetView } from '../contract.ts';
import { budgetBody, budgetDraft, type BudgetBody, type BudgetDraft, type PeriodKind } from '../logic/forms.ts';
import { BUDGET_LEVELS, LEVEL_NAME, ON_LIMIT_TEXT, WINDOWS } from '../logic/limits.ts';
import type { ActorOption } from '../state/actors.ts';
import ScopePicker from './ScopePicker.vue';

const props = withDefaults(defineProps<{
  budget?: BudgetView | undefined;
  actorsAt: (level: LimitLevel) => readonly ActorOption[] | undefined;
  busy?: boolean;
  problem?: string;
}>(), { budget: undefined, busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [body: BudgetBody] }>();

const levels = BUDGET_LEVELS.map((level): SelectOption<LimitLevel> => ({ value: level, label: LEVEL_NAME[level] }));
const periods: readonly SegmentOption<PeriodKind>[] = optionsOf({ window: 'Rolling', 'all-time': 'All time', 'per-turn': 'Per message' } satisfies Record<PeriodKind, string>);
const windows = WINDOWS.map((w): SelectOption<string> => ({ value: String(w.ms), label: w.label }));
const onLimits = optionsOf(ON_LIMIT_TEXT);
const shares: readonly SegmentOption<BudgetDraft['share']>[] = optionsOf({ pooled: 'Shared pot', each: 'Each member' } satisfies Record<BudgetDraft['share'], string>);

const draft = ref<BudgetDraft>(budgetDraft());
const tried = ref(false);
const checked = computed(() => budgetBody(draft.value));
const errorOf = (field: keyof BudgetBody): string => (tried.value && !checked.value.ok ? checked.value.problems[field] ?? '' : '');
const windowText = computed({ get: () => String(draft.value.window), set: (ms: string) => { draft.value = { ...draft.value, window: Number(ms) }; } });

watch(open, (isOpen) => { if (isOpen) { draft.value = budgetDraft(props.budget); tried.value = false; } });

function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', checked.value.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" :title="budget ? 'Edit budget' : 'New budget'" description="Every budget that applies counts at once; none may be overspent." width="560px">
    <form class="form" novalidate data-testid="budget-form" @submit.prevent="save">
      <ScopePicker v-model="draft.scope" :levels="levels" :actors-at="actorsAt" :error="errorOf('target')" />
      <div class="field">
        <span class="label">Period</span>
        <UiSegmented v-model="draft.period" :options="periods" label="Period" />
      </div>
      <div class="grid">
        <UiSelect v-if="draft.period === 'window'" v-model="windowText" :options="windows" label="Window" />
        <UiInput v-model="draft.maxCost" type="number" label="Most it may spend ($)" placeholder="5.00" required :error="errorOf('maxCost')" />
        <UiInput v-if="draft.period === 'per-turn'" v-model="draft.maxTime" type="number" label="Longest a message may run (s)" placeholder="600" :error="errorOf('maxTime')" />
        <UiInput v-model="draft.maxTokens" type="number" label="Most tokens" placeholder="No limit" :error="errorOf('maxTokens')" />
        <UiInput v-model="draft.maxCalls" type="number" label="Most LLM calls" placeholder="No limit" :error="errorOf('maxCalls')" />
        <UiSelect v-model="draft.onLimit" :options="onLimits" label="At the limit" />
      </div>
      <div v-if="draft.scope.level === 'group'" class="field">
        <span class="label">For the group</span>
        <UiSegmented v-model="draft.share" :options="shares" label="For the group" />
      </div>
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="budget-save" @click="save">Save budget</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); align-items: start; gap: var(--space-3); }
.field { display: grid; gap: var(--space-2); }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
</style>
